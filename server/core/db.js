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
      callback TEXT,
      cwd TEXT,
      parent_id TEXT,
      root_id TEXT,
      slack_thread_key TEXT,
      events_json TEXT,
      created_by TEXT
    )
  `);

  // --- Migrations ---
  const columns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  if (!columns.includes("session_id")) db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
  if (!columns.includes("callback")) db.exec("ALTER TABLE tasks ADD COLUMN callback TEXT");
  if (!columns.includes("cwd")) db.exec("ALTER TABLE tasks ADD COLUMN cwd TEXT");
  if (!columns.includes("parent_id")) db.exec("ALTER TABLE tasks ADD COLUMN parent_id TEXT");
  if (!columns.includes("root_id")) db.exec("ALTER TABLE tasks ADD COLUMN root_id TEXT");
  if (!columns.includes("slack_thread_key")) db.exec("ALTER TABLE tasks ADD COLUMN slack_thread_key TEXT");
  if (!columns.includes("events_json")) db.exec("ALTER TABLE tasks ADD COLUMN events_json TEXT");
  if (!columns.includes("created_by")) db.exec("ALTER TABLE tasks ADD COLUMN created_by TEXT");

  // --- Users table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      slack_user_id TEXT,
      avatar_url TEXT,
      last_seen TEXT
    )
  `);

  // --- Prepared statements ---
  const stmts = {
    insert: db.prepare(`INSERT INTO tasks (id, prompt, started_at, callback, cwd, session_id, parent_id, root_id, slack_thread_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE tasks SET status = ?, completed_at = ?, result = ?, error = ?, session_id = COALESCE(?, session_id), events_json = COALESCE(?, events_json) WHERE id = ?`),
    get: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    list: db.prepare(`SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY started_at DESC LIMIT ? OFFSET ?`),
    thread: db.prepare(`SELECT * FROM tasks WHERE root_id = ? ORDER BY started_at ASC`),
    threadHasRunning: db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE root_id = ? AND status = 'running'`),
    countByStatus: db.prepare(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`),
    total: db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE parent_id IS NULL`),
    lastBySlackThread: db.prepare(`SELECT * FROM tasks WHERE slack_thread_key = ? ORDER BY started_at DESC LIMIT 1`),
    latestSessionInThread: db.prepare(`SELECT session_id FROM tasks WHERE root_id = ? AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1`),
    latestCwdInThread: db.prepare(`SELECT cwd FROM tasks WHERE root_id = ? AND cwd IS NOT NULL ORDER BY started_at DESC LIMIT 1`),
  };

  const userStmts = {
    upsert: db.prepare(`INSERT INTO users (email, name, slack_user_id, avatar_url, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, name), slack_user_id = COALESCE(excluded.slack_user_id, slack_user_id), avatar_url = COALESCE(excluded.avatar_url, avatar_url), last_seen = excluded.last_seen`),
    getByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
    getBySlackId: db.prepare(`SELECT * FROM users WHERE slack_user_id = ?`),
    all: db.prepare(`SELECT * FROM users ORDER BY last_seen DESC`),
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
      callback: row.callback, cwd: row.cwd, createdBy: row.created_by || null,
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
