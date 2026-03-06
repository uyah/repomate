import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Create a worktree manager for git worktree operations.
 * @param {object} config
 * @param {string} config.repoDir - Main repository directory
 * @param {string} [config.worktreeBase] - Base directory for worktrees (default: repoDir/../worktrees)
 */
export function createWorktreeManager(config) {
  const { repoDir } = config;
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

  return {
    createWorktree,
    removeWorktree,
    getWorktreeChanges,
    commitAndMergeToMain,
    createPullRequest,
    getGhToken,
    WORKTREES_DIR,
  };
}
