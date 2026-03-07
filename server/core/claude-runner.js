import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

function stripAnsi(str) {
  return str.replace(/[\x1B\x9B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g, "");
}

/**
 * Create a Claude runner using persistent tmux sessions.
 * Each thread gets its own tmux session running Claude Code interactively.
 */
export function createClaudeRunner(config) {
  const { stmts, db, getGhToken, repoDir } = config;
  const logsDir = config.logsDir;
  if (logsDir) mkdirSync(logsDir, { recursive: true });

  const monitors = new Map(); // rootId → intervalId

  function sn(rootId) { return `claude-${rootId}`; }

  function logFile(rootId) {
    return logsDir ? join(logsDir, `${rootId}.log`) : null;
  }

  /** Check if a tmux session exists for this thread. */
  function hasSession(rootId) {
    try {
      execSync(`tmux has-session -t '${sn(rootId)}' 2>/dev/null`, { stdio: "pipe" });
      return true;
    } catch { return false; }
  }

  /** List all active claude-* session names (one execSync call). */
  function listActiveSessions() {
    try {
      const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", { encoding: "utf-8" });
      return new Set(out.trim().split("\n").filter(s => s.startsWith("claude-")));
    } catch { return new Set(); }
  }

  /** Start a new tmux session with Claude Code, then send the initial prompt. */
  function startSession(rootId, prompt, cwd) {
    if (hasSession(rootId)) {
      sendToSession(rootId, prompt);
      return;
    }

    const name = sn(rootId);
    const ghEnv = getGhToken();
    const env = { ...process.env, ...ghEnv };
    const escapedCwd = cwd.replace(/'/g, "'\\''");

    try {
      execSync(
        `tmux new-session -d -s '${name}' -x 100 -y 50 "cd '${escapedCwd}' && claude --dangerously-skip-permissions"`,
        { env, stdio: "pipe" },
      );
      execSync(`tmux set-option -t '${name}' history-limit 50000`, { stdio: "pipe" });
      // Persistent log via pipe-pane
      const lf = logFile(rootId);
      if (lf) {
        writeFileSync(lf, "");
        execSync(`tmux pipe-pane -t '${name}' -o 'cat >> "${lf}"'`, { stdio: "pipe" });
      }
    } catch (err) {
      console.error(`[tmux] Failed to start ${name}: ${err.message}`);
      stmts.update.run("failed", new Date().toISOString(), null, err.message, null, null, rootId);
      return;
    }

    console.log(`[tmux] Started ${name} in ${cwd}`);
    waitAndSend(rootId, prompt);
    monitorSession(rootId);
  }

  /** Wait for Claude to show output (ready), then send the initial prompt. */
  function waitAndSend(rootId, prompt) {
    let attempts = 0;
    const iv = setInterval(() => {
      attempts++;
      if (!hasSession(rootId) || attempts > 30) {
        clearInterval(iv);
        return;
      }
      const out = captureOutput(rootId, 5);
      if (out && out.trim().length > 5) {
        clearInterval(iv);
        setTimeout(() => sendToSession(rootId, prompt), 1000);
      }
    }, 1000);
  }

  /** Send a message to an existing tmux session via load-buffer + paste-buffer. */
  function sendToSession(rootId, message) {
    const name = sn(rootId);
    if (!hasSession(rootId)) return false;
    try {
      execSync("tmux load-buffer -", { input: message, stdio: ["pipe", "pipe", "pipe"] });
      execSync(`tmux paste-buffer -t '${name}'`, { stdio: "pipe" });
      execSync(`tmux send-keys -t '${name}' Enter`, { stdio: "pipe" });
      return true;
    } catch (err) {
      console.error(`[tmux] Send failed for ${name}: ${err.message}`);
      return false;
    }
  }

  /** Capture terminal output. Falls back to log file if session is gone. */
  function captureOutput(rootId, lines = 1000) {
    const name = sn(rootId);
    if (hasSession(rootId)) {
      try {
        const raw = execSync(`tmux capture-pane -t '${name}' -p -S -${lines}`, {
          encoding: "utf-8", timeout: 5000,
        });
        // Trim trailing whitespace per line and remove excessive blank lines
        return raw.split("\n").map(l => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n");
      } catch {}
    }
    // Fall back to log file
    const lf = logFile(rootId);
    if (lf && existsSync(lf)) {
      try {
        const content = readFileSync(lf, "utf-8");
        const cleaned = stripAnsi(content);
        const allLines = cleaned.split("\n");
        return allLines.slice(-lines).join("\n");
      } catch {}
    }
    return null;
  }

  /** Send Ctrl+C to interrupt Claude's current action. */
  function cancelSession(rootId) {
    if (!hasSession(rootId)) return;
    try {
      execSync(`tmux send-keys -t '${sn(rootId)}' C-c C-c`, { stdio: "pipe" });
    } catch {}
  }

  /** Kill the tmux session entirely. */
  function killSession(rootId) {
    try { execSync(`tmux kill-session -t '${sn(rootId)}'`, { stdio: "pipe" }); } catch {}
    const m = monitors.get(rootId);
    if (m) { clearInterval(m); monitors.delete(rootId); }
  }

  /** Monitor a session; mark thread completed when session ends. */
  function monitorSession(rootId) {
    if (monitors.has(rootId)) return;
    const iv = setInterval(() => {
      if (!hasSession(rootId)) {
        clearInterval(iv);
        monitors.delete(rootId);
        const now = new Date().toISOString();
        const root = stmts.get.get(rootId);
        if (root?.status === "running") {
          stmts.update.run("completed", now, null, null, null, null, rootId);
        }
        for (const t of stmts.thread.all(rootId)) {
          if (t.status === "running") {
            stmts.update.run("completed", now, null, null, null, null, t.id);
          }
        }
        console.log(`[tmux] Session ${sn(rootId)} ended`);
      }
    }, 5000);
    monitors.set(rootId, iv);
  }

  /** On startup, reconnect monitors to existing sessions. */
  function resumeStaleTasks() {
    const stale = db.prepare("SELECT * FROM tasks WHERE status = 'running' AND parent_id IS NULL").all();
    if (!stale.length) return;
    const active = listActiveSessions();
    console.log(`[startup] Checking ${stale.length} session(s), ${active.size} tmux session(s) found`);
    for (const task of stale) {
      const rootId = task.root_id || task.id;
      if (active.has(sn(rootId))) {
        console.log(`[startup] ${sn(rootId)} active, resuming monitor`);
        monitorSession(rootId);
      } else {
        console.log(`[startup] ${sn(rootId)} gone, marking completed`);
        stmts.update.run("completed", new Date().toISOString(), null, null, null, null, task.id);
      }
    }
  }

  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} — clearing monitors (tmux sessions persist)`);
    for (const [, iv] of monitors) clearInterval(iv);
    monitors.clear();
    setTimeout(() => process.exit(0), 500);
  }

  // Legacy stubs for db.js taskToJson compatibility
  const runningPids = new Map();
  const liveOutputs = new Map();

  return {
    startSession, sendToSession, captureOutput,
    hasSession, listActiveSessions, cancelSession, killSession,
    monitorSession, resumeStaleTasks, gracefulShutdown,
    runningPids, liveOutputs,
  };
}
