import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "child_process";

/**
 * Create a multi-runner (Claude Code + Codex) task executor.
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
  /** @type {Map<string, AbortController>} */
  const runningTasks = new Map();
  /** @type {Map<string, {events: Array, lastText: string}>} */
  const liveOutputs = new Map();

  // Backward-compat: expose a pid-like Map for routes that check runningPids.size
  const runningPids = new Map();

  // ─── Shared helpers ───

  function setupLiveData(taskId) {
    const existingTask = stmts.get.get(taskId);
    const prevEvents = existingTask?.events_json ? JSON.parse(existingTask.events_json) : [];
    const liveData = { events: [...prevEvents], lastText: "" };
    liveOutputs.set(taskId, liveData);
    return liveData;
  }

  function finalizeTask(taskId, { capturedSessionId, lastResultText, lastErrorText, resultSubtype, totalCostUsd, usageData, liveData, abortController }) {
    runningTasks.delete(taskId);
    runningPids.delete(taskId);
    liveOutputs.delete(taskId);
    const completedAt = new Date().toISOString();
    const eventsJson = liveData.events.length > 0 ? JSON.stringify(liveData.events) : null;

    if (abortController.signal.aborted) {
      stmts.update.run("cancelled", completedAt, lastResultText || null, null, capturedSessionId, eventsJson, taskId);
    } else if (resultSubtype === "error_max_turns") {
      stmts.update.run("max_turns", completedAt, lastResultText || null, "max turns reached", capturedSessionId, eventsJson, taskId);
    } else if (!lastErrorText) {
      const costInfo = totalCostUsd != null ? ` ($${totalCostUsd.toFixed(4)})` : "";
      stmts.update.run("completed", completedAt, lastResultText || null, null, capturedSessionId, eventsJson, taskId);
      console.log(`[${taskId}] completed${costInfo} - ${(lastResultText || "").slice(0, 80)}`);
    } else {
      stmts.update.run("failed", completedAt, null, lastErrorText, capturedSessionId, eventsJson, taskId);
      console.log(`[${taskId}] failed - ${lastErrorText.slice(0, 100)}`);
    }

    // Save cost/usage
    if (totalCostUsd != null || usageData) {
      stmts.updateCost.run(totalCostUsd, usageData ? JSON.stringify(usageData) : null, taskId);
    }
  }

  async function sendCallback(taskId) {
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
  }

  // ─── Claude Code runner (Agent SDK) ───

  function runClaude(taskId, prompt, turns, sessionId, cwd, opts = {}) {
    const abortController = new AbortController();
    runningTasks.set(taskId, abortController);
    runningPids.set(taskId, process.pid);
    const liveData = setupLiveData(taskId);

    const sdkOptions = {
      abortController,
      cwd: cwd || repoDir,
      maxTurns: turns,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      promptSuggestions: true,
      env: (() => { const e = { ...process.env, ...getGhToken() }; delete e.CLAUDECODE; return e; })(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
    };
    if (opts.model) sdkOptions.model = opts.model;
    if (sessionId) sdkOptions.resume = sessionId;

    (async () => {
      let capturedSessionId = sessionId;
      let lastResultText = "";
      let lastErrorText = "";
      let resultSubtype = null;
      let totalCostUsd = null;
      let usageData = null;

      try {
        const conversation = query({ prompt, options: sdkOptions });

        for await (const msg of conversation) {
          if (abortController.signal.aborted) break;
          if (msg.session_id) capturedSessionId = msg.session_id;

          switch (msg.type) {
            case "assistant": {
              if (!msg.message?.content) break;
              for (const block of msg.message.content) {
                if (block.type === "text") {
                  lastResultText = block.text;
                  liveData.events.push({ type: "text", text: block.text });
                } else if (block.type === "tool_use") {
                  liveData.events.push({ type: "tool_use", name: block.name, input: block.input, tool_use_id: block.id });
                } else if (block.type === "thinking") {
                  liveData.events.push({ type: "thinking", text: block.thinking });
                }
              }
              liveData.lastText = lastResultText;
              break;
            }
            case "user": {
              if (!msg.message?.content) break;
              const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
              for (const block of blocks) {
                if (block.type === "tool_result") {
                  const text = Array.isArray(block.content) ? block.content.map(c => c.text || "").join("") : String(block.content || "");
                  liveData.events.push({ type: "tool_result", tool_use_id: block.tool_use_id, content: text.slice(0, 2000), is_error: block.is_error || false });
                }
              }
              break;
            }
            case "result": {
              if (msg.session_id) capturedSessionId = msg.session_id;
              if (msg.subtype) resultSubtype = msg.subtype;
              if (msg.result) lastResultText = msg.result;
              if (msg.total_cost_usd != null) totalCostUsd = msg.total_cost_usd;
              if (msg.usage) usageData = msg.usage;
              if (msg.num_turns != null) {
                liveData.events.push({ type: "result_meta", cost_usd: msg.total_cost_usd, num_turns: msg.num_turns, duration_ms: msg.duration_ms, input_tokens: msg.usage?.input_tokens, output_tokens: msg.usage?.output_tokens });
              }
              if (msg.is_error) {
                lastErrorText = msg.result || (msg.errors && msg.errors.join("; ")) || "Unknown error";
              }
              break;
            }
            case "prompt_suggestion": {
              liveData.events.push({ type: "prompt_suggestion", suggestion: msg.suggestion });
              break;
            }
            case "system": {
              if (msg.subtype === "init") {
                liveData.events.push({ type: "system", subtype: "init", model: msg.model, tools: msg.tools });
              } else if (msg.subtype === "compact_boundary") {
                liveData.events.push({ type: "system", subtype: "compact_boundary", pre_tokens: msg.compact_metadata?.pre_tokens });
              }
              break;
            }
            case "stream_event": {
              const evt = msg.event;
              if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                liveData.lastText = (liveData.lastText || "") + evt.delta.text;
              }
              break;
            }
          }
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          console.log(`[${taskId}] cancelled`);
        } else if (sessionId && err.message && err.message.includes("No conversation found")) {
          console.log(`[${taskId}] Session not found, retrying without --resume`);
          runningTasks.delete(taskId); runningPids.delete(taskId); liveOutputs.delete(taskId);
          stmts.update.run("failed", new Date().toISOString(), null, err.message, null, null, taskId);
          runClaude(taskId, prompt, turns, null, cwd);
          return;
        } else {
          lastErrorText = err.message || "Unknown error";
          console.error(`[${taskId}] SDK error: ${lastErrorText}`);
        }
      }

      finalizeTask(taskId, { capturedSessionId, lastResultText, lastErrorText, resultSubtype, totalCostUsd, usageData, liveData, abortController });
      await sendCallback(taskId);
    })();
  }

  // ─── Codex runner (CLI exec --json) ───

  function runCodex(taskId, prompt, turns, sessionId, cwd, opts = {}) {
    const abortController = new AbortController();
    runningTasks.set(taskId, abortController);
    runningPids.set(taskId, process.pid);
    const liveData = setupLiveData(taskId);

    const codexModel = opts.model || null;
    liveData.events.push({ type: "system", subtype: "init", model: codexModel || "(default)", runner: "codex", tools: [] });

    (async () => {
      let lastResultText = "";
      let lastErrorText = "";
      let capturedSessionId = sessionId;

      try {
        const args = ["exec"];
        if (sessionId) {
          // Resume existing thread
          args.push("resume", sessionId);
        }
        args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
        if (codexModel) args.push("-m", codexModel);
        if (cwd || repoDir) args.push("--cd", cwd || repoDir);
        args.push(prompt);

        const env = { ...process.env, ...getGhToken(), PATH: `/opt/homebrew/bin:${process.env.PATH}` };
        delete env.CLAUDECODE;

        const child = spawn("codex", args, { env, stdio: ["ignore", "pipe", "pipe"] });
        const pid = child.pid;
        runningPids.set(taskId, pid);

        abortController.signal.addEventListener("abort", () => {
          try { process.kill(pid, "SIGTERM"); } catch {}
        });

        let stderrBuf = "";
        child.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderrBuf += text;
          console.error(`[${taskId}] codex stderr: ${text.trim()}`);
        });

        // Parse JSONL stream
        let lineBuf = "";
        child.stdout.on("data", (chunk) => {
          lineBuf += chunk.toString();
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop(); // keep incomplete line
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              // Capture thread_id as session_id for resume
              if (evt.type === "thread.started" && evt.thread_id) {
                capturedSessionId = evt.thread_id;
              }
              handleCodexEvent(evt, liveData, (text) => { lastResultText = text; });
            } catch {}
          }
        });

        await new Promise((resolve) => {
          child.on("close", (code) => {
            if (lineBuf.trim()) {
              try {
                const evt = JSON.parse(lineBuf);
                if (evt.type === "thread.started" && evt.thread_id) {
                  capturedSessionId = evt.thread_id;
                }
                handleCodexEvent(evt, liveData, (text) => { lastResultText = text; });
              } catch {}
            }
            if (code !== 0 && !abortController.signal.aborted) {
              lastErrorText = stderrBuf.slice(0, 500) || `codex exited with code ${code}`;
            }
            resolve();
          });
        });
      } catch (err) {
        if (!abortController.signal.aborted) {
          lastErrorText = err.message || "Unknown error";
          console.error(`[${taskId}] Codex error: ${lastErrorText}`);
        }
      }

      finalizeTask(taskId, { capturedSessionId, lastResultText, lastErrorText, resultSubtype: null, totalCostUsd: null, usageData: null, liveData, abortController });
      await sendCallback(taskId);
    })();
  }

  function handleCodexEvent(evt, liveData, setResult) {
    // Codex JSONL events: thread.started, turn.started, item.started, item.completed, turn.completed
    switch (evt.type) {
      case "item.completed": {
        const item = evt.item;
        if (!item) break;
        if (item.type === "agent_message" && item.text) {
          setResult(item.text);
          liveData.events.push({ type: "text", text: item.text });
          liveData.lastText = item.text;
        } else if (item.type === "command_execution") {
          liveData.events.push({
            type: "tool_use",
            name: "Bash",
            input: { command: item.command || "" },
            tool_use_id: item.id || "",
          });
          if (item.aggregated_output || item.exit_code != null) {
            liveData.events.push({
              type: "tool_result",
              tool_use_id: item.id || "",
              content: (item.aggregated_output || "").slice(0, 2000),
              is_error: item.exit_code !== 0,
            });
          }
        } else if (item.type === "file_edit") {
          liveData.events.push({
            type: "tool_use",
            name: "Edit",
            input: { file_path: item.file_path || "", diff: item.diff || "" },
            tool_use_id: item.id || "",
          });
        }
        break;
      }
      case "turn.completed": {
        if (evt.usage) {
          liveData.events.push({
            type: "result_meta",
            cost_usd: null,
            num_turns: null,
            duration_ms: null,
            input_tokens: evt.usage.input_tokens,
            output_tokens: evt.usage.output_tokens,
            cached_input_tokens: evt.usage.cached_input_tokens,
          });
        }
        break;
      }
      case "thread.started": {
        // Update init event with thread_id
        const initEvt = liveData.events.find(e => e.type === "system" && e.subtype === "init");
        if (initEvt) initEvt.threadId = evt.thread_id;
        break;
      }
    }
  }

  // ─── Unified dispatch ───

  const VALID_RUNNERS = ["claude", "codex"];

  function runTask(taskId, prompt, turns, sessionId, cwd, runner, opts = {}) {
    if (!runner || !VALID_RUNNERS.includes(runner)) {
      throw new Error(`Invalid runner: ${JSON.stringify(runner)}. Must be one of: ${VALID_RUNNERS.join(", ")}`);
    }
    if (runner === "codex") {
      runCodex(taskId, prompt, turns, sessionId, cwd, opts);
    } else {
      runClaude(taskId, prompt, turns, sessionId, cwd, opts);
    }
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

  function cancelTask(taskId) {
    const controller = runningTasks.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
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
    console.log(`[shutdown] ${signal} received, aborting ${runningTasks.size} running task(s)...`);
    for (const [taskId, controller] of runningTasks.entries()) {
      const liveData = liveOutputs.get(taskId);
      const eventsJson = liveData?.events?.length > 0 ? JSON.stringify(liveData.events) : null;
      const task = stmts.get.get(taskId);
      if (task) {
        db.prepare(`UPDATE tasks SET events_json = ? WHERE id = ?`).run(eventsJson, taskId);
      }
      controller.abort();
      console.log(`[shutdown] Aborted task ${taskId}`);
    }
    console.log(`[shutdown] ${runningTasks.size} task(s) will auto-resume on next startup`);
    setTimeout(() => process.exit(0), 1000);
  }

  return { runClaude, runCodex, runTask, runClaudeSync, cancelTask, runningPids, liveOutputs, resumeStaleTasks, gracefulShutdown };
}
