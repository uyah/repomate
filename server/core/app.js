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

/**
 * Create the full Hono application with all modules wired together.
 * @param {object} config
 * @param {string} config.repoDir - Main repository directory (SALES_DIR equivalent)
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
  const { db, stmts, userStmts, taskToJson } = createDatabase(config.dbPath, {
    getRunningPids: () => runner.runningPids,
    getLiveOutputs: () => runner.liveOutputs,
    getWorktreeChanges: (cwd) => worktrees.getWorktreeChanges(cwd),
  });

  const worktrees = createWorktreeManager({
    repoDir,
    worktreeBase: config.worktreeBase,
    stmts,
  });

  // --- Initialize Claude runner ---
  const runner = createClaudeRunner({
    stmts,
    db,
    taskToJson,
    getGhToken: worktrees.getGhToken,
    repoDir,
    maxTurns,
  });

  // --- User identification helper (bound to userStmts) ---
  const cfUserHelper = (c) => getCfUser(c, userStmts);

  // --- Register core routes ---
  const routeCtx = {
    db, stmts, userStmts, taskToJson, runner, worktrees,
    config: { uploadsDir, maxTurns, repoDir },
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

  // --- Dashboard route ---
  app.get("/", (c) => {
    try {
      const serverDir = config.serverDir || join(dirname(fileURLToPath(import.meta.url)), "..");
      const dashboardPath = join(serverDir, "dashboard.html");
      const html = readFileSync(dashboardPath, "utf-8");
      return c.html(html);
    } catch {
      return c.text("Dashboard not found", 404);
    }
  });

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

  return {
    app,
    runner,
    cleanup: (signal) => runner.gracefulShutdown(signal),
  };
}
