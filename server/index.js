#!/usr/bin/env node
import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { createServer as createHttpServer } from "http";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
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

// --- PID file management (safe alternative to port-based kill) ---
const pidFile = join(automationDir, "server.pid");

function killPreviousServer() {
  try {
    if (!existsSync(pidFile)) return;
    const oldPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!oldPid || oldPid === process.pid) return;
    try {
      process.kill(oldPid, 0); // check if alive
      process.kill(oldPid, "SIGTERM");
      console.log(`[startup] Sent SIGTERM to previous server (pid ${oldPid})`);
      // Give it a moment to release the port
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try { process.kill(oldPid, 0); } catch { break; } // process exited
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    } catch {} // process already dead
  } catch {}
}

function writePidFile() {
  writeFileSync(pidFile, String(process.pid));
}

function cleanupPidFile() {
  try { unlinkSync(pidFile); } catch {}
}

// --- Start ---
(async () => {
  killPreviousServer();
  writePidFile();

  const { app, cleanup, worktrees, baseDomain } = await createApp(config);

  process.on("SIGTERM", () => { cleanupPidFile(); cleanup("SIGTERM"); });
  process.on("SIGINT", () => { cleanupPidFile(); cleanup("SIGINT"); });

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
