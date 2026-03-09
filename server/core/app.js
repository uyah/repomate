import { Hono } from "hono";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { spawn } from "child_process";

import { createDatabase } from "./db.js";
import { createClaudeRunner } from "./claude-runner.js";
import { createWorktreeManager } from "./worktree.js";
import { registerRoutes } from "./routes.js";
import { getCfUser } from "../adapters/cloudflare-auth.js";
import { createPushManager } from "./push.js";

/**
 * Create the full Hono application with all modules wired together.
 * @param {object} config
 * @param {string} config.repoDir - Main repository directory
 * @param {string} config.dbPath - Path to SQLite database file
 * @param {string} config.uploadsDir - Path to uploads directory
 * @param {number} [config.maxTurns=30] - Default max turns for Claude
 * @param {string[]} [config.webhookServer.adapters] - Adapters to load (e.g. ["slack"])
 * @returns {{ app: Hono, cleanup: Function }}
 */
export async function createApp(config) {
  const app = new Hono();
  const repoDir = config.repoDir;
  const maxTurns = config.maxTurns || 30;
  const uploadsDir = config.uploadsDir;
  mkdirSync(uploadsDir, { recursive: true });

  // Global error handler
  app.onError((err, c) => {
    console.error(`[HTTP] ${c.req.method} ${c.req.path} error:`, err.message);
    return c.json({ error: "internal server error", detail: err.message }, 500);
  });

  // --- Initialize database first, then worktree manager (needs db for closeThread) ---
  const { db, stmts, userStmts, taskToJson, resolveThreadRunner } = createDatabase(config.dbPath, {
    getRunningPids: () => runner.runningPids,
    getLiveOutputs: () => runner.liveOutputs,
    getWorktreeChanges: (cwd) => worktrees.getWorktreeChanges(cwd),
  });

  const worktrees = createWorktreeManager({
    repoDir,
    worktreeBase: config.worktreeBase,
    stmts,
    devServer: config.devServer || null,
    serverPort: config.port || 8080,
  });

  // --- Initialize push notifications ---
  const push = createPushManager(db);

  // --- Initialize Claude runner ---
  const runner = createClaudeRunner({
    stmts,
    db,
    taskToJson,
    getGhToken: worktrees.getGhToken,
    repoDir,
    maxTurns,
    push,
  });

  // --- Reverse proxy for dev server subdomains ---
  const baseDomain = config.devServer?.baseDomain;
  if (baseDomain) {
    app.use("*", async (c, next) => {
      const host = c.req.header("host") || "";
      if (!host.endsWith(`.${baseDomain}`)) return next();
      const subdomain = host.replace(`.${baseDomain}`, "");
      const origin = c.req.header("origin") || `https://${host}`;

      // Handle CORS preflight
      if (c.req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": c.req.header("access-control-request-headers") || "*",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      const server = worktrees.getDevServerBySubdomain(subdomain);
      if (!server) return c.text(`Dev server '${subdomain}' not found`, 404);
      // Re-encode path segments (Hono/URL decodes %5B→[ which breaks Turbopack asset paths)
      const url = new URL(c.req.url);
      const encodedPath = url.pathname.split("/").map(s =>
        s.replace(/[^a-zA-Z0-9._~!$&'()*+,;=:@%-]/g, (ch) => encodeURIComponent(ch))
      ).join("/");
      const target = `http://localhost:${server.port}${encodedPath}${url.search}`;
      const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
      try {
        const resp = await fetch(target, {
          method: c.req.method,
          headers: c.req.raw.headers,
          body: hasBody ? c.req.raw.body : undefined,
          redirect: "manual",
          ...(hasBody ? { duplex: "half" } : {}),
        });
        const headers = new Headers(resp.headers);
        headers.set("Access-Control-Allow-Origin", origin);
        return new Response(resp.body, {
          status: resp.status,
          headers,
        });
      } catch {
        return c.text("Bad gateway", 502);
      }
    });
  }

  // --- User identification helper (bound to userStmts) ---
  const cfUserHelper = (c) => getCfUser(c, userStmts);

  // --- Register core routes ---
  const routeCtx = {
    db, stmts, userStmts, taskToJson, resolveThreadRunner, runner, worktrees, push,
    config: { uploadsDir, maxTurns, repoDir, port: config.port || 8080, devServer: config.devServer || null },
    getCfUser: cfUserHelper,
  };
  registerRoutes(app, routeCtx);

  // --- Deploy route ---
  app.post("/deploy", async (c) => {
    console.log("[deploy] Deploy triggered");
    const deployScript = join(repoDir, "scripts", "deploy.sh");
    if (!existsSync(deployScript)) {
      return c.json({ error: "deploy.sh not found" }, 500);
    }
    const deployProc = spawn("bash", [deployScript], {
      cwd: repoDir,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...worktrees.getGhToken() },
    });
    deployProc.on("error", (err) => console.error("[deploy] spawn error:", err.message));
    deployProc.unref();
    return c.json({ deployed: true, message: "deploy.sh started" });
  });

  // --- PWA static files ---
  const serverDir = config.serverDir || join(dirname(fileURLToPath(import.meta.url)), "..");
  const pwaFiles = {
    "/sw.js": { path: join(serverDir, "sw.js"), mime: "application/javascript" },
    "/manifest.json": { path: join(serverDir, "manifest.json"), mime: "application/manifest+json" },
    "/icon-192.svg": { path: join(serverDir, "icon-192.svg"), mime: "image/svg+xml" },
    "/icon-512.svg": { path: join(serverDir, "icon-512.svg"), mime: "image/svg+xml" },
  };
  for (const [route, { path: filePath, mime }] of Object.entries(pwaFiles)) {
    app.get(route, (c) => {
      try {
        const content = readFileSync(filePath, "utf-8");
        return new Response(content, { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" } });
      } catch {
        return c.text("Not found", 404);
      }
    });
  }

  // --- Dashboard route ---
  const serveDashboard = (c) => {
    try {
      const serverDir = config.serverDir || join(dirname(fileURLToPath(import.meta.url)), "..");
      const dashboardPath = join(serverDir, "dashboard.html");
      const html = readFileSync(dashboardPath, "utf-8");
      return c.html(html);
    } catch {
      return c.text("Dashboard not found", 404);
    }
  };
  app.get("/", serveDashboard);
  app.get("/t/:id", serveDashboard);

  // --- Logs viewer route ---
  app.get("/logs-viewer", (c) => {
    try {
      const serverDir = config.serverDir || join(dirname(fileURLToPath(import.meta.url)), "..");
      const logsPath = join(serverDir, "logs.html");
      const html = readFileSync(logsPath, "utf-8");
      return c.html(html);
    } catch {
      return c.text("Logs viewer not found", 404);
    }
  });

  // --- Load adapters ---
  const adapters = config.webhookServer?.adapters || [];
  if (adapters.includes("slack")) {
    try {
      const { registerSlack } = await import("../adapters/slack.js");
      registerSlack(app, { db, stmts, userStmts, taskToJson, runner, worktrees, config: { uploadsDir, maxTurns, repoDir } });
    } catch (err) {
      console.error("[app] Failed to load Slack adapter:", err.message);
    }
  }

  // --- Resume stale tasks ---
  runner.resumeStaleTasks();

  // Expose WebSocket proxy lookup for index.js upgrade handler
  app.wsProxy = (subdomain) => worktrees.getDevServerBySubdomain(subdomain);

  return {
    app,
    runner,
    worktrees,
    baseDomain: baseDomain || null,
    cleanup: (signal) => {
      worktrees.stopAllDevServers();
      runner.gracefulShutdown(signal);
    },
  };
}
