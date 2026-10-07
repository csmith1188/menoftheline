import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.x`;
}

function startServer(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-auth-"));
  const mailPath = path.join(dataDir, "mail.log");
  const port = 19010 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SKIP_FORMBAR: "1",
      METRICS: "",
      METRICS_LOG: "0",
      LOCAL_ACCOUNTS: "1",
      FORMBAR_LOGIN: "1",
      AUTH_EMAIL: "1",
      SMTP_HOST: "localhost",
      SMTP_FROM: "motl@example.com",
      AUTH_MAIL_CAPTURE_PATH: mailPath,
      SESSION_SECRET: "test-auth-secret",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`server did not listen\n${buf}`)), 20000);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (/listening on/.test(buf)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${buf}`));
    });
  });
  return {
    child,
    base: `http://127.0.0.1:${port}`,
    dataDir,
    mailPath,
    ready,
  };
}

async function stopServer(server) {
  server.child.kill();
  await new Promise((resolve) => server.child.once("exit", resolve));
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}

function cookieJar() {
  let cookie = "";
  return {
    store(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const list = raw.length ? raw : [];
      for (const line of list) {
        const part = String(line).split(";")[0];
        if (part.startsWith("lane.sid=")) cookie = part;
      }
    },
    header() {
      return cookie ? { cookie } : {};
    },
  };
}

async function fetchSession(base, url, jar, init = {}) {
  const res = await fetch(`${base}${url}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...jar.header(),
    },
    redirect: "manual",
  });
  jar.store(res);
  return res;
}

function lastMailUrl(mailPath, needle) {
  if (!fs.existsSync(mailPath)) return null;
  const lines = fs.readFileSync(mailPath, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const msg = JSON.parse(lines[i]);
    const text = String(msg.text || "");
    const match = text.match(new RegExp(`${needle}\\?token=(\\S+)`));
    if (match) return match[1];
  }
  return null;
}

test("signup verify login and password reset", async (t) => {
  const server = startServer({});
  t.after(() => stopServer(server));
  await server.ready;
  const jar = cookieJar();
  const email = "verify@example.com";

  const signup = await fetchSession(server.base, "/signup", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Verify User",
      email,
      password: "password123",
    }),
  });
  assert.equal(signup.status, 302);
  assert.match(String(signup.headers.get("location")), /\/login$/);

  const loginBlocked = await fetchSession(server.base, "/login", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "password123" }),
  });
  assert.equal(loginBlocked.status, 400);
  const blockedHtml = await loginBlocked.text();
  assert.match(blockedHtml, /Verify your email/);

  const token = lastMailUrl(server.mailPath, "/verify");
  assert.ok(token);
  const verify = await fetchSession(server.base, `/verify?token=${encodeURIComponent(token)}`, jar);
  assert.equal(verify.status, 302);
  assert.equal(verify.headers.get("location"), "/");

  const home = await fetchSession(server.base, "/", jar);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Verify User/);

  await fetchSession(server.base, "/logout", jar);
  const forgot = await fetchSession(server.base, "/forgot", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email }),
  });
  assert.equal(forgot.status, 302);
  const resetToken = lastMailUrl(server.mailPath, "/reset");
  assert.ok(resetToken);
  const reset = await fetchSession(server.base, "/reset", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: resetToken,
      password: "password456",
    }),
  });
  assert.equal(reset.status, 302);
  assert.equal(reset.headers.get("location"), "/");

  await fetchSession(server.base, "/logout", jar);
  const loginNew = await fetchSession(server.base, "/login", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "password456" }),
  });
  assert.equal(loginNew.status, 302);
  assert.equal(loginNew.headers.get("location"), "/");
});

test("signup rejects profane names and bad emails server-side", async (t) => {
  const server = startServer({ AUTH_EMAIL: "0" });
  t.after(() => stopServer(server));
  await server.ready;
  const jar = cookieJar();

  const badName = await fetchSession(server.base, "/signup", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "fuckface",
      email: "clean@example.com",
      password: "password123",
    }),
  });
  assert.equal(badName.status, 400);
  assert.match(await badName.text(), /different display name/i);

  const badEmail = await fetchSession(server.base, "/signup", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Clean Name",
      email: "not-an-email",
      password: "password123",
    }),
  });
  assert.equal(badEmail.status, 400);
  assert.match(await badEmail.text(), /valid email/i);

  const badPass = await fetchSession(server.base, "/signup", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Clean Name",
      email: "clean2@example.com",
      password: "short",
    }),
  });
  assert.equal(badPass.status, 400);
  assert.match(await badPass.text(), /8 characters/i);
});

test("AUTH_EMAIL=0 signs up verified; flags gate routes", async (t) => {
  const server = startServer({ AUTH_EMAIL: "0" });
  t.after(() => stopServer(server));
  await server.ready;
  const jar = cookieJar();

  const signup = await fetchSession(server.base, "/signup", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Instant User",
      email: "instant@example.com",
      password: "password123",
    }),
  });
  assert.equal(signup.status, 302);
  assert.equal(signup.headers.get("location"), "/");
  const home = await fetchSession(server.base, "/", jar);
  assert.match(await home.text(), /Instant User/);

  const forgot = await fetchSession(server.base, "/forgot", jar);
  assert.equal(forgot.status, 404);
});

test("LOCAL_ACCOUNTS=0 and FORMBAR_LOGIN=0 gate providers", async (t) => {
  const noLocal = startServer({ LOCAL_ACCOUNTS: "0", FORMBAR_LOGIN: "1" });
  t.after(() => stopServer(noLocal));
  await noLocal.ready;
  const signup = await fetch(`${noLocal.base}/signup`);
  assert.equal(signup.status, 404);
  const login = await fetch(`${noLocal.base}/login`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Formbar/);

  const noFormbar = startServer({ LOCAL_ACCOUNTS: "1", FORMBAR_LOGIN: "0", AUTH_EMAIL: "0" });
  t.after(() => stopServer(noFormbar));
  await noFormbar.ready;
  const formbar = await fetch(`${noFormbar.base}/login?formbar=1`);
  assert.equal(formbar.status, 404);
});

test("Formbar login sets account session; Digipog buy needs formbar; paid play uses accountId", async (t) => {
  const server = startServer({ AUTH_EMAIL: "0" });
  t.after(() => stopServer(server));
  await server.ready;

  const formJar = cookieJar();
  const token = fakeJwt({ id: 424242, displayName: "Formbar Ace" });
  const oauth = await fetchSession(server.base, `/login?token=${encodeURIComponent(token)}`, formJar);
  assert.equal(oauth.status, 302);
  const formHome = await fetchSession(server.base, "/", formJar);
  assert.match(await formHome.text(), /Formbar Ace/);

  const localJar = cookieJar();
  await fetchSession(server.base, "/signup", localJar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Local Ace",
      email: "localace@example.com",
      password: "password123",
    }),
  });
  const tickets = await fetchSession(server.base, "/tickets", localJar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ next: "/games", pin: "0000" }),
  });
  assert.equal(tickets.status, 302);
  const games = await fetchSession(server.base, "/games", localJar);
  assert.match(await games.text(), /Link a Formbar account/);

  // Grant tickets via sqlite for paid-mode gate check.
  const { default: sqlite3 } = await import("sqlite3");
  const dbFile = path.join(server.dataDir, "Men Of The Line.sqlite");
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.run(
      "UPDATE accounts SET tickets = 2 WHERE email = ?",
      ["localace@example.com"],
      (err) => {
        db.close();
        if (err) reject(err);
        else resolve();
      },
    );
  });
  const ranked = await fetchSession(server.base, "/play/ranked", localJar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({}),
  });
  assert.equal(ranked.status, 302);
  assert.equal(ranked.headers.get("location"), "/play");
});

test("profile can add local credentials onto a Formbar account", async (t) => {
  const server = startServer({ AUTH_EMAIL: "0" });
  t.after(() => stopServer(server));
  await server.ready;
  const jar = cookieJar();
  const token = fakeJwt({ id: 515151, displayName: "Link Me" });
  await fetchSession(server.base, `/login?token=${encodeURIComponent(token)}`, jar);
  const home = await fetchSession(server.base, "/", jar);
  const html = await home.text();
  const profileMatch = html.match(/\/profile\/(\d+)/);
  assert.ok(profileMatch);
  const profileId = profileMatch[1];
  const link = await fetchSession(server.base, "/profile/link/local", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "linked@example.com",
      password: "password123",
    }),
  });
  assert.equal(link.status, 302);
  await fetchSession(server.base, "/logout", jar);
  const login = await fetchSession(server.base, "/login", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "linked@example.com",
      password: "password123",
    }),
  });
  assert.equal(login.status, 302);
  const again = await fetchSession(server.base, `/profile/${profileId}`, jar);
  assert.match(await again.text(), /linked@example\.com/);
});
