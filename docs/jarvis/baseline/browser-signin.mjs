// Task 1.01: a signed-in browser session on a LOCAL, throwaway copy of the dev
// database. A measurement tool, not product code.
//
// The owner signs in with Google, which a script cannot do, and the app has no
// test bypass. So: sign a throwaway user up and in through the real routes
// (the way e2e/global-setup.ts does), then point that session row at the
// owner's user in the copy. The cookie is the server's own; only the copy's
// session table is touched. Refuses any database that is not on localhost.
//
//   BASE_URL=http://localhost:3112 OWNER_EMAIL=<email> STATE=<path>/state.json \
//     DATABASE_URL=postgresql://postgres:postgres@localhost:5441/secretary \
//     node docs/jarvis/baseline/browser-signin.mjs
import { writeFileSync } from "node:fs";
import pg from "pg";

const base = process.env.BASE_URL ?? "http://localhost:3112";
const dbUrl = process.env.DATABASE_URL ?? "";
if (!["localhost", "127.0.0.1"].includes(new URL(dbUrl).hostname)) throw new Error("local databases only");

const who = { email: "baseline-101@secretary.test", password: "baseline-password-not-a-secret", name: "Baseline" };
const headers = { "Content-Type": "application/json", Origin: base };
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  await db.query('delete from "user" where email = $1', [who.email]);
  const up = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers, body: JSON.stringify(who) });
  if (!up.ok && up.status !== 422) throw new Error(`sign-up failed: ${up.status}`);
  const made = await db.query('update "user" set email_verified = true where email = $1 returning id', [who.email]);
  const tempId = made.rows[0]?.id;
  if (!tempId) throw new Error("sign-up stored no user");
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: who.email, password: who.password }),
  });
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status}`);
  const cookies = signIn.headers.getSetCookie().map((line) => {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    return {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      domain: new URL(base).hostname,
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    };
  });
  if (!cookies.length) throw new Error("sign-in set no cookies");

  let as = who.email;
  if (process.env.OWNER_EMAIL) {
    const owner = await db.query('select id from "user" where email = $1', [process.env.OWNER_EMAIL]);
    if (!owner.rows[0]) throw new Error("OWNER_EMAIL matches no user");
    const moved = await db.query("update session set user_id = $1 where user_id = $2", [owner.rows[0].id, tempId]);
    if (moved.rowCount !== 1) throw new Error(`expected one session, moved ${moved.rowCount}`);
    as = "the owner";
  }
  writeFileSync(process.env.STATE ?? "state.json", JSON.stringify({ cookies, origins: [] }, null, 2));
  const check = await fetch(`${base}/api/workspace`, { headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } });
  console.log(JSON.stringify({ signed_in_as: as, cookies: cookies.length, workspace_api: check.status }));
} finally {
  await db.end();
}
