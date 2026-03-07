import { spawn } from "child_process";

/**
 * Create a Claude runner with process management.
 * @param {object} config
 * @param {object} config.stmts - DB prepared statements
 * @param {object} config.db - SQLite database instance
 * @param {function} config.taskToJson - taskToJson helper
 * @param {function} config.getGhToken - returns env with GH_TOKEN
 * @param {string} config.repoDir - default working directory
 * @param {number} config.maxTurns - default max turns
 */
export function createClaudeRunner(config) {
  const { stmts, db, taskToJson, getGhToken, repoDir, maxTurns } = config;
  const runningPids = new Map();
  const liveOutputs = new Map();

  function runClaude(taskId, prompt, turns, sessionId, cwd) {
    const args = ["-p", prompt, "--max-turns", String(turns), "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
    if (sessionId) args.push("--resume", sessionId);

    const proc = spawn("claude", args, {
      cwd: cwd || repoDir,
      env: { ...process.env, ...getGhToken() },
      stdio: ["ignore", "pipe", "pipe"],
    });

    runningPids.set(taskId, proc.pid);
    const existingTask = stmts.get.get(taskId);
    const prevEvents = existingTask?.events_json ? JSON.parse(existingTask.events_json) : [];
    const liveData = { events: [...prevEvents], lastText: "" };
    liveOutputs.set(taskId, liveData);
    let fullStdout = "";
    let stderr = "";
    let lastResultText = "";
    let lastErrorText = "";
    let capturedSessionId = sessionId;
    let resultSubtype = null;

    proc.on("error", (err) => {
      console.error(`[${taskId}] spawn error: ${err.message}`);
      runningPids.delete(taskId);
      liveOutputs.delete(taskId);
      stmts.update.run("failed", new Date().toISOString(), null, `spawn error: ${err.message}`, capturedSessionId, null, taskId);
    });

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      fullStdout += chunk;

      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);

          if (evt.type === "assistant" && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === "text") {
                lastResultText = block.text;
                liveData.events.push({ type: "text", text: block.text });
              } else if (block.type === "tool_use") {
                liveData.events.push({ type: "tool_use", name: block.name, input: block.input });
              }
            }
          } else if (evt.type === "user" && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === "tool_result") {
                const content = Array.isArray(block.content) ? block.content.map(c => c.text || "").join("") : String(block.content || "");
                liveData.events.push({ type: "tool_result", tool_use_id: block.tool_use_id, content: content.slice(0, 2000) });
              }
            }
          } else if (evt.type === "result") {
            if (evt.session_id) capturedSessionId = evt.session_id;
            if (evt.subtype) resultSubtype = evt.subtype;
            if (evt.result) lastResultText = evt.result;
            if (evt.is_error) lastErrorText = evt.result || (evt.errors && evt.errors.join("; ")) || "Unknown error";
          }
        } catch {}
      }
      liveData.lastText = lastResultText;
    });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", async (code) => {
      runningPids.delete(taskId);
      liveOutputs.delete(taskId);
      const completedAt = new Date().toISOString();

      // Auto-retry without --resume if session not found
      if (sessionId && lastErrorText && lastErrorText.includes("No conversation found")) {
        console.log(`[${taskId}] Session not found, retrying without --resume`);
        stmts.update.run("failed", completedAt, null, lastErrorText, null, null, taskId);
        runClaude(taskId, prompt, turns, null, cwd);
        return;
      }

      const eventsJson = liveData.events.length > 0 ? JSON.stringify(liveData.events) : null;

      if (resultSubtype === "error_max_turns") {
        const result = lastResultText || fullStdout;
        stmts.update.run("max_turns", completedAt, result, "max turns reached", capturedSessionId, eventsJson, taskId);
      } else if (code === 0 && !lastErrorText) {
        const result = lastResultText || fullStdout;
        stmts.update.run("completed", completedAt, result, null, capturedSessionId, eventsJson, taskId);
      } else {
        const error = lastErrorText || stderr || lastResultText || "(Claude exited with no output)";
        stmts.update.run("failed", completedAt, null, error, capturedSessionId, eventsJson, taskId);
      }

      // Callback
      const task = stmts.get.get(taskId);
      if (task?.callback) {
        try {
          await fetch(task.callback, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: taskId, status: task.status, result: task.result, error: task.error }),
          });
        } catch (e) {
          console.error(`Callback failed for ${taskId}: ${e.message}`);
        }
      }

      const finalStatus = resultSubtype === "error_max_turns" ? "max_turns" : (code === 0 ? "completed" : "failed");
      console.log(`[${taskId}] ${finalStatus} (exit ${code}) - ${prompt.slice(0, 80)}`);
    });

    return proc;
  }

  function runClaudeSync(taskId, prompt, turns, sessionId, cwd) {
    return new Promise((resolve) => {
      runClaude(taskId, prompt, turns, sessionId, cwd);
      const check = setInterval(() => {
        const task = stmts.get.get(taskId);
        if (task && task.status !== "running") {
          clearInterval(check);
          resolve(taskToJson(task));
        }
      }, 1000);
    });
  }

  function resumeStaleTasks() {
    const staleTasks = db.prepare(`SELECT * FROM tasks WHERE status IN ('running', 'max_turns')`).all();
    if (staleTasks.length === 0) return;
    console.log(`[startup] Found ${staleTasks.length} interrupted task(s) from previous run`);
    for (const task of staleTasks) {
      if (task.session_id) {
        console.log(`[startup] Resuming task ${task.id} (session: ${task.session_id})`);
        const prompt = "続けてください (auto-resumed after server restart)";
        runClaude(task.id, prompt, maxTurns, task.session_id, task.cwd || repoDir);
      } else {
        console.log(`[startup] Marking task ${task.id} as interrupted (no session_id)`);
        stmts.update.run("interrupted", new Date().toISOString(), null, "server restarted", null, null, task.id);
      }
    }
  }

  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, saving running tasks...`);

    const now = new Date().toISOString();
    for (const [taskId, pid] of runningPids.entries()) {
      const liveData = liveOutputs.get(taskId);
      const eventsJson = liveData?.events?.length > 0 ? JSON.stringify(liveData.events) : null;
      const task = stmts.get.get(taskId);
      if (task) {
        db.prepare(`UPDATE tasks SET events_json = ? WHERE id = ?`).run(eventsJson, taskId);
      }
      try { process.kill(pid, "SIGTERM"); } catch {}
      console.log(`[shutdown] Killed claude process ${pid} for task ${taskId}`);
    }

    console.log(`[shutdown] ${runningPids.size} task(s) will auto-resume on next startup`);
    setTimeout(() => process.exit(0), 1000);
  }

  return { runClaude, runClaudeSync, runningPids, liveOutputs, resumeStaleTasks, gracefulShutdown };
}
