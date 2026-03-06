/**
 * Extract user identity from Cloudflare Access headers.
 * @param {import('hono').Context} c - Hono request context
 * @param {object} userStmts - User prepared statements { upsert }
 * @returns {string|null} email or null
 */
export function getCfUser(c, userStmts) {
  let email = c.req.header("cf-access-authenticated-user-email") || null;
  let name = null;
  const jwt = c.req.header("cf-access-jwt-assertion");
  if (jwt) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
      if (!email) email = payload.email || null;
      name = payload.name || null;
    } catch {}
  }
  if (email) {
    if (!name) name = email.split("@")[0];
    userStmts.upsert.run(email, name, null, null, new Date().toISOString());
  }
  return email;
}
