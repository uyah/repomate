import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { createApp } from "./core/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load .env ---
dotenv.config({ path: join(__dirname, "..", ".env") });

// --- Global error handlers ---
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

// --- Load config ---
const configPath = process.argv.find((a, i) => process.argv[i - 1] === "--config") || process.env.MAC_MINI_CONFIG;
let config;
if (configPath) {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} else {
  // Fallback: construct config from env vars (backward compatible)
  const repoDir = process.env.SALES_DIR || `${process.env.HOME}/primaryinc/sales`;
  config = {
    repoDir,
    dbPath: join(__dirname, "tasks.db"),
    uploadsDir: join(__dirname, "uploads"),
    maxTurns: parseInt(process.env.MAX_TURNS || "30", 10),
    port: parseInt(process.env.PORT || "8080", 10),
    serverDir: __dirname,
    webhookServer: {
      adapters: ["slack"],
    },
  };
}

// Ensure serverDir is set
config.serverDir = config.serverDir || __dirname;
config.dbPath = config.dbPath || join(__dirname, "tasks.db");
config.uploadsDir = config.uploadsDir || join(__dirname, "uploads");
config.port = config.port || 8080;

// --- Start ---
(async () => {
  const { app, cleanup } = await createApp(config);

  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Webhook server running on http://localhost:${info.port}`);
    console.log(`Repo dir: ${config.repoDir}`);
  });
})();
