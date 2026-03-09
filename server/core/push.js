import webpush from "web-push";

/**
 * Create push notification manager.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ subscribe, unsubscribe, sendNotification, isEnabled, vapidPublicKey }}
 */
export function createPushManager(db) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@localhost";

  if (!vapidPublic || !vapidPrivate) {
    console.log("[push] VAPID keys not configured, push notifications disabled");
    return { subscribe() {}, unsubscribe() {}, sendNotification() {}, isEnabled: false, vapidPublicKey: null };
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const stmts = {
    insert: db.prepare(`INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, ?)`),
    delete: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
    all: db.prepare(`SELECT * FROM push_subscriptions`),
  };

  function subscribe(subscription) {
    stmts.insert.run(subscription.endpoint, JSON.stringify(subscription.keys), new Date().toISOString());
    console.log("[push] New subscription registered");
  }

  function unsubscribe(endpoint) {
    stmts.delete.run(endpoint);
  }

  async function sendNotification(title, body, url, tag) {
    const subs = stmts.all.all();
    if (subs.length === 0) return;
    const payload = JSON.stringify({ title, body, url, tag });
    let sent = 0;
    for (const sub of subs) {
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
  return { subscribe, unsubscribe, sendNotification, isEnabled: true, vapidPublicKey: vapidPublic };
}
