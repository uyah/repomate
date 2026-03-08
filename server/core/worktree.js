import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, rmSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";

/**
 * Create a worktree manager for git worktree operations.
 * @param {object} config
 * @param {string} config.repoDir - Main repository directory
 * @param {string} [config.worktreeBase] - Base directory for worktrees (default: repoDir/../worktrees)
 * @param {object} [config.stmts] - Prepared statements (needs closeThread stmt)
 * @param {object} [config.devServer] - Dev server config { startPort, command, baseDomain }
 */
export function createWorktreeManager(config) {
  const { repoDir, stmts: dbStmts } = config;
  const serverPort = config.serverPort || 8080;
  const devServerConfig = config.devServer || null;
  const devServerProcs = new Map(); // taskId → ChildProcess
  const devServerLogs = new Map(); // taskId → string[] (last N lines)
  const WORKTREES_DIR = config.worktreeBase || join(repoDir, "..", "worktrees");
  mkdirSync(WORKTREES_DIR, { recursive: true });

  function getGhToken() {
    try {
      const scriptPath = `${repoDir}/scripts/gh-app-token.sh`;
      if (!existsSync(scriptPath)) return {};
      const output = execSync(`bash "${scriptPath}"`, { encoding: "utf-8" });
      const match = output.match(/export GH_TOKEN='([^']+)'/);
      if (match) return { GH_TOKEN: match[1] };
    } catch {}
    return {};
  }

  function agentInstructions(taskId, serverUrl) {
    const API = serverUrl;
    return `# Repomate

このworktreeはrepomateのタスク \`${taskId}\` 用です。
以下のAPIでautomationサーバーを操作できます。

## Dev Server

プレビュー用devサーバーを起動・管理できます。

\`\`\`bash
# 起動
curl -s -X POST ${API}/task/${taskId}/dev-server

# 停止
curl -s -X DELETE ${API}/task/${taskId}/dev-server

# ログ確認
curl -s ${API}/task/${taskId}/dev-server/logs | jq '.lines[-20:]'
\`\`\`

## PR紐づけ

PRを作成したら、ダッシュボードに紐づけてください:
\`\`\`bash
curl -s -X POST ${API}/task/${taskId}/link-pr \\
  -H 'Content-Type: application/json' \\
  -d '{"prUrl":"<実際のPR URL>"}'
\`\`\`

## タスク完了

作業が完了したら明示的に閉じてください:
\`\`\`bash
curl -s -X POST ${API}/task/${taskId}/close
\`\`\`
`;
  }

  function writeAgentInstructions(worktreePath, taskId, serverUrl) {
    const instructions = agentInstructions(taskId, serverUrl);
    // Claude Code: .claude/CLAUDE.local.md (auto-loaded, untracked)
    const claudeDir = join(worktreePath, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.local.md"), instructions);
    // Codex: AGENTS.md (auto-loaded by Codex)
    writeFileSync(join(worktreePath, "AGENTS.md"), instructions);
  }

  function createWorktree(taskId, opts) {
    const worktreePath = join(WORKTREES_DIR, `task-${taskId}`);
    if (existsSync(worktreePath)) return worktreePath;
    try {
      const branch = opts?.branch;
      const cmd = branch
        ? `git worktree add "${worktreePath}" "${branch}"`
        : `git worktree add --detach "${worktreePath}"`;
      execSync(cmd, { cwd: repoDir, stdio: "pipe" });
      // Copy .env files from main repo
      try {
        const envFiles = readdirSync(repoDir).filter(f => f.startsWith(".env"));
        for (const f of envFiles) {
          copyFileSync(join(repoDir, f), join(worktreePath, f));
        }
      } catch {}
      // Write task context + agent instructions
      try {
        const serverUrl = `http://localhost:${serverPort}`;
        writeFileSync(join(worktreePath, ".repomate-task.json"), JSON.stringify({
          taskId, serverUrl,
        }, null, 2) + "\n");
        writeAgentInstructions(worktreePath, taskId, serverUrl);
      } catch {}
      console.log(`[worktree] Created ${worktreePath}`);
      return worktreePath;
    } catch (err) {
      console.error(`[worktree] Failed to create: ${err.message}`);
      return null;
    }
  }

  function removeWorktree(taskId) {
    const worktreePath = join(WORKTREES_DIR, `task-${taskId}`);
    if (!existsSync(worktreePath)) return;
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoDir, stdio: "pipe" });
      console.log(`[worktree] Removed ${worktreePath}`);
    } catch (err) {
      console.error(`[worktree] Failed to remove: ${err.message}`);
    }
  }

  function getWorktreeChanges(cwd, opts) {
    if (!cwd || !existsSync(cwd)) return null;
    try {
      // Uncommitted changes
      const status = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
      // Filter out repomate/claude internal files from change detection
      const INTERNAL_FILES = [".repomate-task.json", "AGENTS.md", ".claude/CLAUDE.local.md"];
      const uncommittedFiles = status
        ? status.split("\n").map(l => l.trim()).filter(Boolean)
            .filter(l => !INTERNAL_FILES.some(f => l.endsWith(f)))
        : [];

      // Commits ahead of origin/main
      let commitsAhead = 0;
      try {
        if (opts?.fetch) {
          execSync("git fetch origin main --quiet", { cwd, stdio: "pipe", timeout: 10000 });
        }
        const log = execSync("git log origin/main..HEAD --oneline", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
        commitsAhead = log ? log.split("\n").length : 0;
      } catch {}

      if (uncommittedFiles.length === 0 && commitsAhead === 0) return null;
      return { uncommittedFiles, commitsAhead };
    } catch { return null; }
  }

  function commitAndMergeToMain(cwd, taskId, message) {
    try {
      execSync("git add -A", { cwd, stdio: "pipe" });
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd, stdio: "pipe" });
      const commitHash = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
      execSync(`git fetch origin main`, { cwd: repoDir, stdio: "pipe" });
      execSync(`git merge --no-edit ${commitHash}`, { cwd: repoDir, stdio: "pipe" });
      execSync(`git push origin main`, { cwd: repoDir, stdio: "pipe", env: { ...process.env, ...getGhToken() } });
      return { ok: true, commit: commitHash };
    } catch (err) {
      try { execSync("git merge --abort", { cwd: repoDir, stdio: "pipe" }); } catch {}
      return { ok: false, error: err.message };
    }
  }

  function createPullRequest(cwd, taskId, title, body) {
    const branch = `task/${taskId}`;
    try {
      execSync(`git checkout -b "${branch}"`, { cwd, stdio: "pipe" });
      execSync("git add -A", { cwd, stdio: "pipe" });
      execSync(`git commit -m "${title.replace(/"/g, '\\"')}"`, { cwd, stdio: "pipe" });
      const ghEnv = { ...process.env, ...getGhToken() };
      execSync(`git push origin "${branch}"`, { cwd, stdio: "pipe", env: ghEnv });
      const prUrl = execSync(
        `gh pr create --title "${title.replace(/"/g, '\\"')}" --body-file - --head "${branch}" --base main`,
        { cwd, encoding: "utf-8", env: ghEnv, input: body || "" }
      ).trim();
      return { ok: true, prUrl, branch };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function closeThread(rootId) {
    const now = new Date().toISOString();
    dbStmts.closeThread.run(now, rootId, rootId);
    stopDevServer(rootId);
    removeWorktree(rootId);
    console.log(`[thread] Closed thread ${rootId}`);
  }

  // --- Dev server management ---

  // Clean up stale dev server records on startup (processes don't survive server restart)
  if (devServerConfig) {
    const stale = dbStmts.devServerAll.all();
    for (const ds of stale) {
      // Try to kill old process if still alive
      if (ds.pid) {
        try { process.kill(-ds.pid, "SIGTERM"); } catch {}
      }
      dbStmts.devServerDelete.run(ds.task_id);
    }
    if (stale.length > 0) console.log(`[dev] Cleaned up ${stale.length} stale dev server record(s)`);
  }

  function killPortUser(port) {
    try {
      const output = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 5000 }).trim();
      if (output) {
        for (const pid of output.split("\n")) {
          try { process.kill(Number(pid), "SIGKILL"); } catch {}
        }
        console.log(`[dev] Killed process(es) on port ${port}`);
      }
    } catch {}
  }

  function allocatePort() {
    const startPort = devServerConfig?.startPort || 3001;
    const row = dbStmts.devServerMaxPort.get();
    return row?.max_port ? Math.max(row.max_port + 1, startPort) : startPort;
  }

  function startDevServer(taskId, cwd) {
    if (!devServerConfig) return null;
    if (devServerProcs.has(taskId)) return dbStmts.devServerGet.get(taskId);

    // Clean up stale .next lock/cache to prevent "Unable to acquire lock" crash
    const nextDir = join(cwd, ".next");
    if (existsSync(nextDir)) {
      try {
        rmSync(nextDir, { recursive: true, force: true });
        console.log(`[dev:${taskId}] Cleaned .next directory`);
      } catch {}
    }

    // Install dependencies if installCommand is configured
    const installCmd = devServerConfig.installCommand || "npm install";
    try {
      console.log(`[dev:${taskId}] Running: ${installCmd}`);
      execSync(installCmd, { cwd, stdio: "pipe", timeout: 300000 });
      console.log(`[dev:${taskId}] Install complete`);
    } catch (err) {
      console.error(`[dev:${taskId}] Install failed: ${err.message}`);
      return { error: `install failed: ${err.message}` };
    }

    const port = allocatePort();
    killPortUser(port);
    const subdomain = `task-${taskId}`;
    const cmd = (devServerConfig.command || "npm run dev -- -p $PORT")
      .replace(/\$PORT/g, String(port));

    const env = { ...process.env, PORT: String(port) };
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const MAX_LOG_LINES = 200;
    const logs = [];
    devServerLogs.set(taskId, logs);
    const logFile = join(cwd, "dev-server.log");
    try { writeFileSync(logFile, ""); } catch {} // truncate
    const appendLog = (line) => {
      logs.push(line);
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
      try { appendFileSync(logFile, line + "\n"); } catch {}
    };
    proc.stdout?.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed) { appendLog(trimmed); console.log(`[dev:${taskId}:${port}] ${trimmed}`); }
      }
    });
    proc.stderr?.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed) { appendLog(trimmed); console.log(`[dev:${taskId}:${port}] ${trimmed}`); }
      }
    });
    proc.on("exit", (code) => {
      appendLog(`[exited code=${code}]`);
      console.log(`[dev:${taskId}:${port}] exited (code=${code})`);
      devServerProcs.delete(taskId);
      dbStmts.devServerDelete.run(taskId);
    });

    devServerProcs.set(taskId, proc);
    dbStmts.devServerInsert.run(taskId, port, subdomain, proc.pid, new Date().toISOString());
    console.log(`[dev] Started dev server for ${taskId} on port ${port} (subdomain: ${subdomain})`);

    return { taskId, port, subdomain, pid: proc.pid };
  }

  function stopDevServer(taskId) {
    const proc = devServerProcs.get(taskId);
    if (proc) {
      try { process.kill(-proc.pid, "SIGTERM"); } catch {}
      devServerProcs.delete(taskId);
    }
    dbStmts.devServerDelete.run(taskId);
    // Keep logs — don't delete from devServerLogs
  }

  function getDevServers() {
    return dbStmts.devServerAll.all();
  }

  function getDevServerBySubdomain(subdomain) {
    return dbStmts.devServerBySubdomain.get(subdomain);
  }

  function getDevServerLogs(taskId) {
    const mem = devServerLogs.get(taskId);
    if (mem && mem.length > 0) return mem;
    // Fallback: read from log file (survives server restart)
    try {
      const logFile = join(WORKTREES_DIR, `task-${taskId}`, "dev-server.log");
      if (existsSync(logFile)) {
        const lines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
        return lines.slice(-200);
      }
    } catch {}
    return [];
  }

  function stopAllDevServers() {
    for (const [taskId, proc] of devServerProcs) {
      try { process.kill(-proc.pid, "SIGTERM"); } catch {}
      dbStmts.devServerDelete.run(taskId);
    }
    const count = devServerProcs.size;
    devServerProcs.clear();
    // Keep logs — don't clear devServerLogs
    if (count > 0) console.log(`[dev] Stopped ${count} dev server(s)`);
  }

  return {
    createWorktree,
    removeWorktree,
    getWorktreeChanges,
    commitAndMergeToMain,
    createPullRequest,
    closeThread,
    getGhToken,
    startDevServer,
    stopDevServer,
    getDevServers,
    getDevServerBySubdomain,
    getDevServerLogs,
    stopAllDevServers,
    WORKTREES_DIR,
  };
}
