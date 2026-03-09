#!/usr/bin/env node
import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { createServer as createHttpServer } from "http";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createConnection } from "net";

import { createApp } from "./core/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load .env (cwd first, then package root — first match wins in dotenv) ---
dotenv.config();
dotenv.config({ path: join(__dirname, "..", ".env") });

// --- Global error handlers ---
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err.message, err.stack);
  // EADDRINUSE is fatal — exit so launchd can retry after throttle interval
  if (err.code === "EADDRINUSE") {
    console.error("[FATAL] Port in use, exiting in 2s...");
    setTimeout(() => process.exit(1), 2000);
  }
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

// --- Load config ---
const configPath = process.argv.find((a, i) => process.argv[i - 1] === "--config") || process.env.REPOMATE_CONFIG;
if (!configPath) {
  console.error("ERROR: --config <path> or REPOMATE_CONFIG env is required.");
  console.error("Usage: repomate-server --config <config.json>");
  process.exit(1);
}
let config = JSON.parse(readFileSync(configPath, "utf-8"));

// Resolve $HOME in string values
function resolveEnvVars(obj) {
  if (typeof obj === "string") return obj.replace(/\$HOME/g, process.env.HOME || "/tmp");
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveEnvVars(v);
    return out;
  }
  return obj;
}
config = resolveEnvVars(config);

// Ensure serverDir is set
config.serverDir = config.serverDir || __dirname;
const dataDir = config.repoDir || __dirname;
const automationDir = join(dataDir, ".automation");
mkdirSync(automationDir, { recursive: true });
config.dbPath = config.dbPath || join(automationDir, "tasks.db");
config.uploadsDir = config.uploadsDir || join(automationDir, "uploads");
config.port = config.webhookServer?.port || config.port || 8080;

// --- Kill any process holding our port (prevents EADDRINUSE crash loop) ---
function killPortUser(port) {
  try {
    const output = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 5000 }).trim();
    if (output) {
      const myPid = String(process.pid);
      for (const pid of output.split("\n")) {
        if (pid.trim() === myPid) continue; // don't kill ourselves
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
      console.log(`[startup] Killed stale process(es) on port ${port}: ${output.replace(/\n/g, ", ")}`);
    }
  } catch {} // lsof returns exit code 1 when no matches — that's fine
}

// --- Start ---
(async () => {
  killPortUser(config.port);

  const { app, cleanup, worktrees, baseDomain } = await createApp(config);

  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Webhook server running on http://localhost:${info.port}`);
    console.log(`Repo dir: ${config.repoDir}`);
  });

  // --- WebSocket proxy for dev server subdomains (HMR) ---
  if (baseDomain) {
    server.on("upgrade", (req, socket, head) => {
      const host = req.headers.host || "";
      console.log(`[ws] upgrade request: host=${host} url=${req.url}`);
      if (!host.endsWith(`.${baseDomain}`)) {
        console.log(`[ws] not a dev server subdomain, ignoring`);
        return;  // Don't destroy — let other handlers (like Hono) handle it
      }
      const subdomain = host.replace(`.${baseDomain}`, "");
      const ds = worktrees.getDevServerBySubdomain(subdomain);
      if (!ds) {
        console.log(`[ws] no dev server for subdomain ${subdomain}`);
        return socket.destroy();
      }

      console.log(`[ws] proxying to localhost:${ds.port}`);
      const target = createConnection({ port: ds.port, host: "127.0.0.1" }, () => {
        // Forward the original HTTP upgrade request
        const path = req.url || "/";
        target.write(`GET ${path} HTTP/${req.httpVersion}\r\n`);
        // Rewrite Host header to localhost for Next.js
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const key = req.rawHeaders[i];
          const val = key.toLowerCase() === "host" ? `localhost:${ds.port}` : req.rawHeaders[i + 1];
          target.write(`${key}: ${val}\r\n`);
        }
        target.write("\r\n");
        if (head.length > 0) target.write(head);
        target.pipe(socket);
        socket.pipe(target);
      });
      target.on("error", (err) => { console.log(`[ws] target error: ${err.message}`); socket.destroy(); });
      socket.on("error", (err) => { console.log(`[ws] socket error: ${err.message}`); target.destroy(); });
    });
  }
})();
