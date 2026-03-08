#!/usr/bin/env node
import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

import { createApp } from "./core/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load .env ---
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

  const { app, cleanup } = await createApp(config);

  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Webhook server running on http://localhost:${info.port}`);
    console.log(`Repo dir: ${config.repoDir}`);
  });
})();
