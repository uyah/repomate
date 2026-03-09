import webpush from "web-push";

/**
 * Create push notification manager.
 * Opt-in model: only endpoints that "watch" a thread receive notifications.
 * Auto-watch is triggered when a task is created with a push endpoint.
 * @param {import('better-sqlite3').Database} db
 */
export function createPushManager(db) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@localhost";

  const noop = { subscribe() {}, unsubscribe() {}, sendNotification() {}, watch() {}, unwatch() {}, getWatches() { return []; }, isWatching() { return false; }, isEnabled: false, vapidPublicKey: null };
  if (!vapidPublic || !vapidPrivate) {
    console.log("[push] VAPID keys not configured, push notifications disabled");
    return noop;
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  // Migrate: drop old mutes table if exists, create watches table
  try { db.exec(`DROP TABLE IF EXISTS push_mutes`); } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_watches (
      endpoint TEXT NOT NULL,
      root_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (endpoint, root_id)
    )
  `);

  const stmts = {
    insert: db.prepare(`INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, ?)`),
    delete: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
    all: db.prepare(`SELECT * FROM push_subscriptions`),
    // Watches (opt-in)
    watch: db.prepare(`INSERT OR REPLACE INTO push_watches (endpoint, root_id, created_at) VALUES (?, ?, ?)`),
    unwatch: db.prepare(`DELETE FROM push_watches WHERE endpoint = ? AND root_id = ?`),
    getWatches: db.prepare(`SELECT root_id FROM push_watches WHERE endpoint = ?`),
    isWatching: db.prepare(`SELECT 1 FROM push_watches WHERE endpoint = ? AND root_id = ?`),
    watchersForThread: db.prepare(`SELECT endpoint FROM push_watches WHERE root_id = ?`),
  };

  function subscribe(subscription) {
    stmts.insert.run(subscription.endpoint, JSON.stringify(subscription.keys), new Date().toISOString());
    console.log("[push] New subscription registered");
  }

  function unsubscribe(endpoint) {
    stmts.delete.run(endpoint);
  }

  function watch(endpoint, rootId) {
    stmts.watch.run(endpoint, rootId, new Date().toISOString());
  }

  function unwatch(endpoint, rootId) {
    stmts.unwatch.run(endpoint, rootId);
  }

  function getWatches(endpoint) {
    return stmts.getWatches.all(endpoint).map(r => r.root_id);
  }

  function isWatching(endpoint, rootId) {
    return !!stmts.isWatching.get(endpoint, rootId);
  }

  async function sendNotification(title, body, url, tag, rootId) {
    if (!rootId) return;
    // Only send to endpoints watching this thread
    const watchers = stmts.watchersForThread.all(rootId);
    if (watchers.length === 0) return;

    const allSubs = stmts.all.all();
    const subMap = new Map(allSubs.map(s => [s.endpoint, s]));
    const payload = JSON.stringify({ title, body, url, tag, threadId: rootId });

    let sent = 0;
    for (const { endpoint } of watchers) {
      const sub = subMap.get(endpoint);
      if (!sub) continue; // watcher's subscription expired
      const pushSub = { endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) };
      try {
        await webpush.sendNotification(pushSub, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          stmts.delete.run(sub.endpoint);
          console.log("[push] Removed expired subscription");
        } else {
          console.error(`[push] Failed: ${err.message}`);
        }
      }
    }
    if (sent > 0) console.log(`[push] Sent "${title}" to ${sent} watcher(s)`);
  }

  console.log(`[push] Enabled with ${stmts.all.all().length} subscription(s)`);
  return { subscribe, unsubscribe, sendNotification, watch, unwatch, getWatches, isWatching, isEnabled: true, vapidPublicKey: vapidPublic };
}
