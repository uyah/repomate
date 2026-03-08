import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, extname } from "path";

/**
 * Register all HTTP routes on the Hono app.
 * @param {import('hono').Hono} app
 * @param {object} ctx - { db, stmts, userStmts, taskToJson, runner, worktrees, config, getCfUser }
 */
export function registerRoutes(app, ctx) {
  const { db, stmts, userStmts, taskToJson, runner, worktrees, config, getCfUser } = ctx;
  const { runClaude, runTask, runClaudeSync, cancelTask, runningPids, liveOutputs } = runner;
  const { createWorktree, removeWorktree, getWorktreeChanges, commitAndMergeToMain, createPullRequest, closeThread, startDevServer, stopDevServer, getDevServers, getDevServerLogs, WORKTREES_DIR } = worktrees;
  const UPLOADS_DIR = config.uploadsDir;
  const MAX_TURNS = config.maxTurns;

  // --- Health ---
  app.get("/health", (c) => {
    return c.json({ status: "ok", activeTasks: runningPids.size });
  });

  // --- Public config (for dashboard) ---
  app.get("/config/public", (c) => {
    return c.json({
      devServer: config.devServer || null,
    });
  });

  // --- File upload ---
  app.post("/upload", async (c) => {
    const contentType = c.req.header("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") return c.json({ error: "no file" }, 400);
      const ext = extname(file.name || ".bin") || ".bin";
      const name = randomUUID().slice(0, 8) + ext;
      const buf = Buffer.from(await file.arrayBuffer());
      writeFileSync(join(UPLOADS_DIR, name), buf);
      return c.json({ name, url: `/files/${name}`, size: buf.length });
    }

    const { data, filename } = await c.req.json();
    if (!data) return c.json({ error: "no data" }, 400);
    const ext = extname(filename || ".bin") || ".bin";
    const name = randomUUID().slice(0, 8) + ext;
    const buf = Buffer.from(data, "base64");
    writeFileSync(join(UPLOADS_DIR, name), buf);
    return c.json({ name, url: `/files/${name}`, size: buf.length });
  });

  // --- Serve uploaded files ---
  app.get("/files/:name", (c) => {
    const name = c.req.param("name").replace(/[^a-zA-Z0-9._-]/g, "");
    const filePath = join(UPLOADS_DIR, name);
    if (!existsSync(filePath)) return c.json({ error: "not found" }, 404);

    const ext = extname(name).toLowerCase();
    const mimeTypes = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
      ".json": "application/json", ".html": "text/html",
      ".mp4": "video/mp4", ".mp3": "audio/mpeg",
    };
    const mime = mimeTypes[ext] || "application/octet-stream";
    const content = readFileSync(filePath);
    return new Response(content, {
      headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
    });
  });

  // --- Create task ---
  app.post("/task", async (c) => {
    const { prompt, maxTurns, callback, files, branch, runner: runnerType, model } = await c.req.json();
    if (!prompt) return c.json({ error: "prompt is required" }, 400);
    if (!runnerType || !["claude", "codex"].includes(runnerType)) return c.json({ error: `runner is required. Must be "claude" or "codex"` }, 400);

    let displayPrompt = prompt;
    let fullPrompt = prompt;
    if (files && files.length > 0) {
      const fileUrls = files.map((f) => `/files/${f}`);
      displayPrompt += "\n" + fileUrls.join("\n");
      const filePaths = files.map((f) => join(UPLOADS_DIR, f)).filter((p) => existsSync(p));
      if (filePaths.length > 0) {
        fullPrompt += "\n\n添付ファイル:\n" + filePaths.join("\n");
      }
    }

    // If branch specified, fetch it first so worktree can check it out
    if (branch) {
      try {
        execSync(`git fetch origin "${branch}"`, { cwd: config.repoDir, stdio: "pipe" });
      } catch {}
    }

    const id = randomUUID().slice(0, 8);
    const worktreeCwd = createWorktree(id, branch ? { branch: `origin/${branch}` } : undefined);
    const user = getCfUser(c);
    const now = new Date().toISOString();
    stmts.insert.run(id, displayPrompt, now, callback || null, worktreeCwd, null, null, id, null, user);
    if (branch) stmts.setThreadPr.run(null, branch, id);
    runTask(id, fullPrompt, maxTurns || MAX_TURNS, null, worktreeCwd, runnerType, { model });

    return c.json({ id, status: "accepted" }, 202);
  });

  // --- Sync task ---
  app.post("/task/sync", async (c) => {
    const { prompt, maxTurns } = await c.req.json();
    if (!prompt) return c.json({ error: "prompt is required" }, 400);

    const id = randomUUID().slice(0, 8);
    const worktreeCwd = createWorktree(id);
    const user = getCfUser(c);
    stmts.insert.run(id, prompt, new Date().toISOString(), null, worktreeCwd, null, null, id, null, user);

    const task = await runClaudeSync(id, prompt, maxTurns || MAX_TURNS, null, worktreeCwd);
    return c.json(task);
  });

  // --- Get task ---
  app.get("/task/:id", (c) => {
    const task = taskToJson(stmts.get.get(c.req.param("id")));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  // --- List tasks (threaded) ---
  app.get("/tasks", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
    const q = (c.req.query("q") || "").trim();
    const showClosed = c.req.query("closed") === "1";
    const offset = (page - 1) * limit;

    const closedFilter = showClosed ? " AND t.closed_at IS NOT NULL" : " AND t.closed_at IS NULL";
    let countSql, listSql, params, countParams;

    if (q) {
      const like = `%${q}%`;
      countSql = `SELECT COUNT(DISTINCT CASE WHEN parent_id IS NULL THEN id ELSE root_id END) as count FROM tasks WHERE prompt LIKE ? OR result LIKE ?`;
      countParams = [like, like];
      listSql = `SELECT t.*, (SELECT MAX(started_at) FROM tasks WHERE root_id = t.id) as last_activity FROM tasks t WHERE t.parent_id IS NULL AND t.id IN (SELECT DISTINCT CASE WHEN parent_id IS NULL THEN id ELSE root_id END FROM tasks WHERE prompt LIKE ? OR result LIKE ?)${closedFilter} ORDER BY last_activity DESC LIMIT ? OFFSET ?`;
      params = [like, like, limit, offset];
    } else {
      countSql = `SELECT COUNT(*) as count FROM tasks WHERE parent_id IS NULL${closedFilter.replace('t.', '')}`;
      countParams = [];
      listSql = `SELECT t.*, (SELECT MAX(started_at) FROM tasks WHERE root_id = t.id) as last_activity FROM tasks t WHERE t.parent_id IS NULL${closedFilter} ORDER BY last_activity DESC LIMIT ? OFFSET ?`;
      params = [limit, offset];
    }

    const total = db.prepare(countSql).get(...countParams).count;
    const rows = db.prepare(listSql).all(...params);
    const totalPages = Math.ceil(total / limit) || 1;

    const threads = rows.map((row) => {
      const t = taskToJson(row);
      const replies = stmts.thread.all(row.id).filter((r) => r.id !== row.id);
      t.replies = replies.map(r => taskToJson(r));
      const lastTask = t.replies.length > 0 ? t.replies[t.replies.length - 1] : t;
      const hasRunning = lastTask.status === "running" || t.replies.some(r => r.status === "running");
      if (!hasRunning && lastTask.cwd) {
        const changes = getWorktreeChanges(lastTask.cwd);
        if (changes) t.worktreeChanges = changes;
      }
      return t;
    });

    const userIds = new Set();
    for (const t of threads) {
      if (t.createdBy) userIds.add(t.createdBy);
      for (const r of t.replies || []) {
        if (r.createdBy) userIds.add(r.createdBy);
      }
    }
    const users = {};
    for (const uid of userIds) {
      if (uid.startsWith("slack:")) {
        const slackName = uid.slice(6);
        users[uid] = { name: slackName };
      } else {
        const u = userStmts.getByEmail.get(uid);
        if (u) users[uid] = { email: u.email, name: u.name, avatar: u.avatar_url };
      }
    }

    return c.json({ threads, total, page, totalPages, users });
  });

  // --- Reply to task ---
  app.post("/task/:id/reply", async (c) => {
    const original = stmts.get.get(c.req.param("id"));
    if (!original) return c.json({ error: "not found" }, 404);
    if (original.status === "running") return c.json({ error: "task is still running" }, 409);
    const rootId = original.root_id || original.id;
    if (stmts.threadHasRunning.get(rootId).count > 0) return c.json({ error: "thread already has a running task" }, 409);

    const { prompt, maxTurns, files, runner: runnerType, model } = await c.req.json();
    if (!prompt) return c.json({ error: "prompt is required" }, 400);
    if (!runnerType || !["claude", "codex"].includes(runnerType)) return c.json({ error: `runner is required. Must be "claude" or "codex"` }, 400);

    let displayPrompt = prompt;
    let fullPrompt = prompt;
    if (files && files.length > 0) {
      const fileUrls = files.map((f) => `/files/${f}`);
      displayPrompt += "\n" + fileUrls.join("\n");
      const filePaths = files.map((f) => join(UPLOADS_DIR, f)).filter((p) => existsSync(p));
      if (filePaths.length > 0) {
        fullPrompt += "\n\n添付ファイル:\n" + filePaths.join("\n");
      }
    }

    const id = randomUUID().slice(0, 8);
    // Look up session and cwd from the whole thread, not just the last task
    const sessionId = original.session_id || stmts.latestSessionInThread.get(rootId)?.session_id || null;
    const cwd = original.cwd || stmts.latestCwdInThread.get(rootId)?.cwd || null;
    const user = getCfUser(c);
    stmts.insert.run(id, displayPrompt, new Date().toISOString(), null, cwd, sessionId, original.id, rootId, null, user);
    runTask(id, fullPrompt, maxTurns || MAX_TURNS, sessionId, cwd, runnerType, { model });

    return c.json({ id, status: "accepted", resuming: sessionId }, 202);
  });

  // --- SSE stream (fast: 300ms interval, delta-based) ---
  app.get("/task/:id/stream", (c) => {
    const taskId = c.req.param("id");
    const task = stmts.get.get(taskId);
    if (!task) return c.json({ error: "not found" }, 404);

    return new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (data) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

          let closed = false;
          let lastEventCount = 0;
          let lastText = "";
          const safeClose = () => { if (!closed) { closed = true; try { controller.close(); } catch {} } };
          const interval = setInterval(() => {
            if (closed) { clearInterval(interval); return; }
            try {
              const current = stmts.get.get(taskId);
              const live = liveOutputs.get(taskId);
              if (!current) { clearInterval(interval); safeClose(); return; }

              const allEvents = live?.events || null;
              const currentText = live?.lastText || current.result || "";
              const eventCount = allEvents?.length || 0;

              // Send delta: only new events since last send
              if (eventCount > lastEventCount || currentText !== lastText || current.status !== "running") {
                const newEvents = allEvents ? allEvents.slice(lastEventCount) : null;
                send({
                  status: current.status === "running" ? "running" : current.status,
                  output: currentText,
                  events: allEvents,
                  newEvents: newEvents,
                  eventOffset: lastEventCount,
                  error: current.error,
                });
                lastEventCount = eventCount;
                lastText = currentText;
              }

              if (current.status !== "running") {
                clearInterval(interval);
                safeClose();
              }
            } catch { clearInterval(interval); safeClose(); }
          }, 300);
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }
    );
  });

  // --- Cancel task ---
  app.delete("/task/:id", (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    cancelTask(task.id);
    return c.json({ status: "cancelled" });
  });

  // --- Retry task ---
  app.post("/task/:id/retry", async (c) => {
    const original = stmts.get.get(c.req.param("id"));
    if (!original) return c.json({ error: "not found" }, 404);
    if (original.status === "running") return c.json({ error: "task is still running" }, 409);

    const rootId = original.root_id || original.id;
    if (stmts.threadHasRunning.get(rootId).count > 0) return c.json({ error: "thread already has a running task" }, 409);

    // Resume session if available (check whole thread), otherwise re-run the prompt
    const sessionId = original.session_id || stmts.latestSessionInThread.get(rootId)?.session_id || null;
    const cwd = original.cwd || stmts.latestCwdInThread.get(rootId)?.cwd || null;
    const id = randomUUID().slice(0, 8);
    const prompt = original.prompt;

    const user = getCfUser(c);
    stmts.insert.run(id, `[retry] ${prompt}`, new Date().toISOString(), null, cwd, sessionId, original.id, rootId, original.slack_thread_key || null, user);
    runClaude(id, prompt, MAX_TURNS, sessionId, cwd);

    return c.json({ id, status: "accepted", retrying: original.id, resuming: sessionId }, 202);
  });

  // --- Merge worktree ---
  app.post("/task/:id/merge", async (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);

    const rootTask = task.root_id ? stmts.get.get(task.root_id) : task;
    const cwd = task.cwd || rootTask?.cwd;
    if (!cwd) return c.json({ error: "no worktree for this task" }, 400);

    const changes = getWorktreeChanges(cwd);
    if (!changes) return c.json({ error: "no changes to merge" }, 400);

    const message = `task(${task.root_id || task.id}): ${task.prompt.slice(0, 60)}`;
    const rootId = task.root_id || task.id;
    const result = commitAndMergeToMain(cwd, rootId, message);
    if (result.ok) {
      closeThread(rootId);
      return c.json({ status: "merged", commit: result.commit });
    }
    return c.json({ error: `merge failed: ${result.error}` }, 500);
  });

  // --- Create PR (via Claude Code) ---
  app.post("/task/:id/pr", async (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);

    const rootTask = task.root_id ? stmts.get.get(task.root_id) : task;
    const cwd = task.cwd || rootTask?.cwd;
    if (!cwd) return c.json({ error: "no worktree for this task" }, 400);

    const changes = getWorktreeChanges(cwd);
    if (!changes) return c.json({ error: "no changes" }, 400);

    const rootId = task.root_id || task.id;

    // Resume existing session so Claude has full thread context
    const sessionRow = stmts.latestSessionInThread.get(rootId);
    const sessionId = sessionRow?.session_id || null;

    const prTaskId = `pr-${rootId}-${Date.now()}`;
    const port = config.port || 8080;
    const callbackUrl = `http://localhost:${port}/internal/pr-callback/${rootId}`;
    const prompt = `この作業の変更をPRにしてください。git diff で差分を確認し、適切なコミットメッセージでコミットし、gh pr create でPRを作成してください。`;

    stmts.insert.run(prTaskId, prompt, new Date().toISOString(), callbackUrl, cwd, sessionId, rootId, rootId, null, null);
    runClaude(prTaskId, prompt, 30, sessionId, cwd);

    return c.json({ status: "pr_creating", taskId: prTaskId });
  });

  // --- Internal: PR creation callback ---
  app.post("/internal/pr-callback/:rootId", async (c) => {
    const rootId = c.req.param("rootId");
    const body = await c.req.json();
    if (body.status !== "completed" || !body.result) return c.json({ ok: true });

    const prUrlMatch = body.result.match(/https:\/\/github\.com\/[^\s)>\]]+\/pull\/\d+/);
    if (prUrlMatch) {
      const branchMatch = body.result.match(/task\/[a-z0-9-]+|[a-z]+\/[a-z0-9_-]+/i);
      stmts.setThreadPr.run(prUrlMatch[0], branchMatch?.[0] || null, rootId);
      stopDevServer(rootId);
      console.log(`[pr] Linked PR ${prUrlMatch[0]} to thread ${rootId}`);
    }
    return c.json({ ok: true });
  });

  // --- Discard changes ---
  app.post("/task/:id/discard", (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const rootId = task.root_id || task.id;
    closeThread(rootId);
    return c.json({ status: "discarded" });
  });

  // --- Compact context ---
  app.post("/task/:id/compact", async (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const rootId = task.root_id || task.id;
    if (stmts.threadHasRunning.get(rootId).count > 0) return c.json({ error: "thread has running tasks" }, 409);

    const sessionId = task.session_id || stmts.latestSessionInThread.get(rootId)?.session_id || null;
    if (!sessionId) return c.json({ error: "no session to compact" }, 400);

    const cwd = task.cwd || stmts.latestCwdInThread.get(rootId)?.cwd || null;
    const id = randomUUID().slice(0, 8);
    const user = getCfUser(c);
    stmts.insert.run(id, "[compact] コンテキスト圧縮", new Date().toISOString(), null, cwd, sessionId, task.id, rootId, null, user);
    runClaude(id, "/compact", MAX_TURNS, sessionId, cwd);

    return c.json({ id, status: "accepted", compacting: sessionId }, 202);
  });

  // --- Close thread (manual done, no changes) ---
  app.post("/task/:id/close", (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const rootId = task.root_id || task.id;
    if (stmts.threadHasRunning.get(rootId).count > 0) return c.json({ error: "thread has running tasks" }, 409);
    closeThread(rootId);
    return c.json({ status: "closed" });
  });

  // --- Users ---
  app.get("/users", (c) => {
    return c.json(userStmts.all.all());
  });

  // --- System status ---
  app.get("/status", (c) => {
    let tmuxSessions = "";
    let claudeProcesses = "";
    try {
      tmuxSessions = execSync("tmux list-sessions 2>/dev/null || echo 'no sessions'", { encoding: "utf-8" }).trim();
    } catch { tmuxSessions = "tmux not available"; }
    try {
      claudeProcesses = execSync("ps aux | grep '[c]laude' | awk '{print $2, $11, $12}' || echo 'none'", { encoding: "utf-8" }).trim();
    } catch { claudeProcesses = "none"; }

    const statusCounts = {};
    for (const row of stmts.countByStatus.all()) statusCounts[row.status] = row.count;
    const total = stmts.total.get().count;

    let worktreeCount = 0;
    try { worktreeCount = readdirSync(WORKTREES_DIR).filter(d => d.startsWith("task-")).length; } catch {}

    return c.json({
      tmuxSessions: tmuxSessions.split("\n"),
      claudeProcesses: claudeProcesses.split("\n").filter(Boolean),
      tasks: {
        total, running: runningPids.size,
        completed: statusCounts.completed || 0, failed: statusCounts.failed || 0,
        done: stmts.countDone.get().c,
        waiting: stmts.countWaiting.get().c,
      },
      worktrees: worktreeCount,
      uptime: process.uptime(),
    });
  });

  // --- Worktree cleanup ---
  app.post("/worktrees/cleanup", (c) => {
    let removed = 0;
    try {
      const dirs = readdirSync(WORKTREES_DIR).filter(d => d.startsWith("task-"));
      for (const dir of dirs) {
        const rootId = dir.replace("task-", "");
        const hasRunning = stmts.threadHasRunning.get(rootId)?.count > 0;
        if (!hasRunning) {
          removeWorktree(rootId);
          removed++;
        }
      }
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
    return c.json({ removed, message: `${removed} worktree(s) cleaned up` });
  });

  // --- Logs ---
  app.get("/logs", (c) => {
    const source = c.req.query("source") || "webhook-server";
    const lines = parseInt(c.req.query("lines") || "200", 10);
    const after = c.req.query("after") || null;

    try {
      let content = "";
      if (source === "deploy") {
        const logPath = join(process.env.HOME || "/tmp", "logs", "deploy.log");
        if (existsSync(logPath)) {
          content = readFileSync(logPath, "utf-8");
        } else {
          content = "(deploy.log not found)";
        }
      } else if (source === "webhook-server" || source === "task-runner") {
        try {
          content = execSync(
            `tmux capture-pane -t ${source} -p -S -${lines} 2>/dev/null`,
            { encoding: "utf-8", timeout: 5000 }
          );
        } catch {
          content = `(tmux session '${source}' not available)`;
        }
      } else {
        return c.json({ error: "unknown source" }, 400);
      }

      const allLines = content.split("\n");
      const trimmed = allLines.slice(-lines);

      return c.json({
        source,
        lines: trimmed,
        total: allLines.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // --- Dev servers ---
  app.get("/dev-servers", (c) => {
    return c.json(getDevServers());
  });

  app.post("/task/:id/dev-server", (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const rootId = task.root_id || task.id;
    const rootTask = task.root_id ? stmts.get.get(task.root_id) : task;
    const cwd = task.cwd || rootTask?.cwd;
    if (!cwd) return c.json({ error: "no worktree for this task" }, 400);
    const result = startDevServer(rootId, cwd);
    if (!result) return c.json({ error: "dev server not configured" }, 400);
    if (result.error) return c.json({ error: result.error }, 500);
    return c.json(result);
  });

  app.delete("/task/:id/dev-server", (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const rootId = task.root_id || task.id;
    stopDevServer(rootId);
    return c.json({ status: "stopped" });
  });

  app.get("/task/:id/dev-server/logs", (c) => {
    const task = stmts.get.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const rootId = task.root_id || task.id;
    return c.json({ lines: getDevServerLogs(rootId) });
  });

  app.get("/logs/sources", (c) => {
    const sources = [
      { id: "webhook-server", name: "Webhook Server", type: "tmux" },
      { id: "task-runner", name: "Task Runner", type: "tmux" },
      { id: "deploy", name: "Deploy Log", type: "file" },
    ];
    return c.json(sources);
  });
}
