import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "fs";
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
  const devServerConfig = config.devServer || null;
  const devServerProcs = new Map(); // taskId → ChildProcess
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

  function createWorktree(taskId) {
    const worktreePath = join(WORKTREES_DIR, `task-${taskId}`);
    if (existsSync(worktreePath)) return worktreePath;
    try {
      execSync(`git worktree add --detach "${worktreePath}"`, { cwd: repoDir, stdio: "pipe" });
      // Copy .env files from main repo
      try {
        const envFiles = readdirSync(repoDir).filter(f => f.startsWith(".env"));
        for (const f of envFiles) {
          copyFileSync(join(repoDir, f), join(worktreePath, f));
        }
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

  function getWorktreeChanges(cwd) {
    if (!cwd || !existsSync(cwd)) return null;
    try {
      const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
      if (!status) return null;
      const files = status.split("\n").map(l => l.trim()).filter(Boolean);
      return { files, summary: `${files.length} file(s) changed` };
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
      execSync(`git push origin "${branch}"`, { cwd, stdio: "pipe", env: { ...process.env, ...getGhToken() } });
      const prUrl = execSync(
        `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${(body || "").replace(/"/g, '\\"')}" --head "${branch}" --base main`,
        { cwd, encoding: "utf-8", env: { ...process.env, ...getGhToken() } }
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

    proc.stdout?.on("data", (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[dev:${taskId}:${port}] ${line}`);
    });
    proc.stderr?.on("data", (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[dev:${taskId}:${port}] ${line}`);
    });
    proc.on("exit", (code) => {
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
  }

  function getDevServers() {
    return dbStmts.devServerAll.all();
  }

  function getDevServerBySubdomain(subdomain) {
    return dbStmts.devServerBySubdomain.get(subdomain);
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
    WORKTREES_DIR,
  };
}
