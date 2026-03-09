import webpush from "web-push";

/**
 * Create push notification manager.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ subscribe, unsubscribe, sendNotification, mute, unmute, getMutes, isEnabled, vapidPublicKey }}
 */
export function createPushManager(db) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@localhost";

  if (!vapidPublic || !vapidPrivate) {
    console.log("[push] VAPID keys not configured, push notifications disabled");
    return { subscribe() {}, unsubscribe() {}, sendNotification() {}, mute() {}, unmute() {}, getMutes() { return []; }, isEnabled: false, vapidPublicKey: null };
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  // Mute table (per-endpoint × per-thread)
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_mutes (
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
    // Mute
    mute: db.prepare(`INSERT OR REPLACE INTO push_mutes (endpoint, root_id, created_at) VALUES (?, ?, ?)`),
    unmute: db.prepare(`DELETE FROM push_mutes WHERE endpoint = ? AND root_id = ?`),
    getMutes: db.prepare(`SELECT root_id FROM push_mutes WHERE endpoint = ?`),
    isMuted: db.prepare(`SELECT 1 FROM push_mutes WHERE endpoint = ? AND root_id = ?`),
  };

  function subscribe(subscription) {
    stmts.insert.run(subscription.endpoint, JSON.stringify(subscription.keys), new Date().toISOString());
    console.log("[push] New subscription registered");
  }

  function unsubscribe(endpoint) {
    stmts.delete.run(endpoint);
  }

  function mute(endpoint, rootId) {
    stmts.mute.run(endpoint, rootId, new Date().toISOString());
  }

  function unmute(endpoint, rootId) {
    stmts.unmute.run(endpoint, rootId);
  }

  function getMutes(endpoint) {
    return stmts.getMutes.all(endpoint).map(r => r.root_id);
  }

  async function sendNotification(title, body, url, tag, rootId) {
    const subs = stmts.all.all();
    if (subs.length === 0) return;
    const payload = JSON.stringify({ title, body, url, tag, threadId: rootId });
    let sent = 0;
    for (const sub of subs) {
      // Skip if this endpoint has muted this thread
      if (rootId && stmts.isMuted.get(sub.endpoint, rootId)) continue;

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
    if (sent > 0) console.log(`[push] Sent "${title}" to ${sent} subscriber(s)`);
  }

  console.log(`[push] Enabled with ${stmts.all.all().length} subscription(s)`);
  return { subscribe, unsubscribe, sendNotification, mute, unmute, getMutes, isEnabled: true, vapidPublicKey: vapidPublic };
}
