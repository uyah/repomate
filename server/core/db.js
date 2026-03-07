import Database from "better-sqlite3";

/**
 * Create and initialize the SQLite database with schema, migrations, and prepared statements.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {object} runtime - { getRunningPids, getLiveOutputs, getWorktreeChanges }
 * @returns {{ db, stmts, userStmts, taskToJson }}
 */
export function createDatabase(dbPath, runtime) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // --- Schema ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      result TEXT,
      error TEXT,
      session_id TEXT,
      parent_id TEXT,
      root_id TEXT,
      callback TEXT,
      cwd TEXT
    )
  `);

  // --- Migrations ---
  try { db.exec(`ALTER TABLE tasks ADD COLUMN root_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN slack_thread_key TEXT`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN events_json TEXT`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN created_by TEXT`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN closed_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN branch TEXT`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN cost_usd REAL`); } catch {}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN usage_json TEXT`); } catch {}

  // --- Users table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      slack_user_id TEXT,
      avatar_url TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack ON users(slack_user_id) WHERE slack_user_id IS NOT NULL`); } catch {}

  // --- Dev servers table (worktree → port mapping) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_servers (
      task_id TEXT PRIMARY KEY,
      port INTEGER NOT NULL UNIQUE,
      subdomain TEXT NOT NULL,
      pid INTEGER,
      started_at TEXT NOT NULL
    )
  `);

  // --- Prepared statements ---
  const stmts = {
    insert: db.prepare(`INSERT INTO tasks (id, prompt, status, started_at, callback, cwd, session_id, parent_id, root_id, slack_thread_key, created_by) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE tasks SET status = ?, completed_at = ?, result = ?, error = ?, session_id = ?, events_json = ? WHERE id = ?`),
    updateCost: db.prepare(`UPDATE tasks SET cost_usd = ?, usage_json = ? WHERE id = ?`),
    get: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    list: db.prepare(`SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY started_at DESC LIMIT ?`),
    thread: db.prepare(`SELECT * FROM tasks WHERE root_id = ? ORDER BY started_at ASC`),
    countByStatus: db.prepare(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`),
    total: db.prepare(`SELECT COUNT(*) as count FROM tasks`),
    threadHasRunning: db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE root_id = ? AND status = 'running'`),
    lastBySlackThread: db.prepare(`SELECT * FROM tasks WHERE slack_thread_key = ? ORDER BY started_at DESC LIMIT 1`),
    latestSessionInThread: db.prepare(`SELECT session_id FROM tasks WHERE root_id = ? AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1`),
    latestCwdInThread: db.prepare(`SELECT cwd FROM tasks WHERE root_id = ? AND cwd IS NOT NULL ORDER BY started_at DESC LIMIT 1`),
    closeThread: db.prepare(`UPDATE tasks SET closed_at = ? WHERE id = ? OR root_id = ?`),
    setThreadPr: db.prepare(`UPDATE tasks SET pr_url = ?, branch = ? WHERE id = ?`),
    countDone: db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE closed_at IS NOT NULL AND parent_id IS NULL`),
    countWaiting: db.prepare(`SELECT COUNT(*) as c FROM tasks t WHERE t.parent_id IS NULL AND t.closed_at IS NULL AND t.status != 'running' AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.root_id = t.id AND r.status = 'running')`),
    // Dev servers
    devServerInsert: db.prepare(`INSERT OR REPLACE INTO dev_servers (task_id, port, subdomain, pid, started_at) VALUES (?, ?, ?, ?, ?)`),
    devServerDelete: db.prepare(`DELETE FROM dev_servers WHERE task_id = ?`),
    devServerGet: db.prepare(`SELECT * FROM dev_servers WHERE task_id = ?`),
    devServerBySubdomain: db.prepare(`SELECT * FROM dev_servers WHERE subdomain = ?`),
    devServerAll: db.prepare(`SELECT * FROM dev_servers ORDER BY port ASC`),
    devServerMaxPort: db.prepare(`SELECT MAX(port) as max_port FROM dev_servers`),
  };

  const userStmts = {
    upsert: db.prepare(`INSERT INTO users (email, name, slack_user_id, avatar_url, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, name), slack_user_id = COALESCE(excluded.slack_user_id, slack_user_id), avatar_url = COALESCE(excluded.avatar_url, avatar_url), updated_at = excluded.updated_at`),
    getByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
    getBySlackId: db.prepare(`SELECT * FROM users WHERE slack_user_id = ?`),
    all: db.prepare(`SELECT * FROM users ORDER BY updated_at DESC`),
  };

  function taskToJson(row, opts) {
    if (!row) return null;
    const runningPids = runtime.getRunningPids();
    const liveOutputs = runtime.getLiveOutputs();
    const json = {
      id: row.id, prompt: row.prompt, status: row.status,
      startedAt: row.started_at, completedAt: row.completed_at,
      result: row.result, error: row.error, sessionId: row.session_id,
      parentId: row.parent_id, rootId: row.root_id,
      callback: row.callback, cwd: row.cwd, createdBy: row.created_by || null, closedAt: row.closed_at || null,
      prUrl: row.pr_url || null, branch: row.branch || null,
      costUsd: row.cost_usd || null, usage: row.usage_json ? JSON.parse(row.usage_json) : null,
      pid: runningPids.get(row.id) || null,
      output: liveOutputs.get(row.id)?.lastText || null,
      events: liveOutputs.get(row.id)?.events || (row.events_json ? JSON.parse(row.events_json) : null),
    };
    if (opts?.checkChanges && row.cwd && row.status !== "running") {
      const changes = runtime.getWorktreeChanges(row.cwd);
      if (changes) json.hasChanges = changes;
    }
    return json;
  }

  return { db, stmts, userStmts, taskToJson };
}
