import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicKeyB64, signFormbar, unsignedFormbar } from "./formbarToken.js";

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
      NODE_ENV: "test",
      FORMBAR_PUBLIC_KEY_B64: publicKeyB64,
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
    csrf: "",
    store(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of raw) {
        const part = String(line).split(";")[0];
        if (part.startsWith("lane.sid=") && part !== cookie) {
          cookie = part;
          this.csrf = "";
        }
      }
    },
    header() {
      return cookie ? { cookie } : {};
    },
  };
}

async function primeCsrf(base, jar) {
  let res = await fetch(`${base}/login`, { headers: jar.header(), redirect: "manual" });
  jar.store(res);
  if (res.status >= 300 && res.status < 400) {
    res = await fetch(`${base}/`, { headers: jar.header(), redirect: "manual" });
    jar.store(res);
  }
  const html = await res.text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match) jar.csrf = match[1];
}

async function fetchSession(base, url, jar, init = {}) {
  const method = String(init.method || "GET").toUpperCase();
  if (method === "POST") await primeCsrf(base, jar);
  let body = init.body;
  if (body instanceof URLSearchParams && jar.csrf && !body.has("_csrf")) {
    body.set("_csrf", jar.csrf);
  }
  const res = await fetch(`${base}${url}`, {
    ...init,
    body,
    headers: {
      ...(init.headers || {}),
      ...jar.header(),
    },
    redirect: "manual",
  });
  jar.store(res);
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/html")) {
    const html = await res.clone().text();
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    if (match) jar.csrf = match[1];
  }
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
  const noLocal = startServer({ LOCAL_ACCOUNTS: "0", FORMBAR_LOGIN: "1", DISCORD_LOGIN: "0" });
  t.after(() => stopServer(noLocal));
  await noLocal.ready;
  const signup = await fetch(`${noLocal.base}/signup`);
  assert.equal(signup.status, 404);
  const login = await fetch(`${noLocal.base}/login`);
  assert.equal(login.status, 200);
  const loginHtml = await login.text();
  assert.match(loginHtml, /Formbar/);
  assert.doesNotMatch(loginHtml, /Discord/);

  const noFormbar = startServer({
    LOCAL_ACCOUNTS: "1",
    FORMBAR_LOGIN: "0",
    DISCORD_LOGIN: "0",
    AUTH_EMAIL: "0",
  });
  t.after(() => stopServer(noFormbar));
  await noFormbar.ready;
  const formbar = await fetch(`${noFormbar.base}/login?formbar=1`);
  assert.equal(formbar.status, 404);
  const discordOff = await fetch(`${noFormbar.base}/login?discord=1`);
  assert.equal(discordOff.status, 404);

  const discordOnly = startServer({
    LOCAL_ACCOUNTS: "0",
    FORMBAR_LOGIN: "0",
    DISCORD_LOGIN: "1",
    DISCORD_OAUTH_MOCK: "1",
    AUTH_EMAIL: "0",
  });
  t.after(() => stopServer(discordOnly));
  await discordOnly.ready;
  const discordLogin = await fetch(`${discordOnly.base}/login`);
  assert.equal(discordLogin.status, 200);
  assert.match(await discordLogin.text(), /Discord/);
});

test("Discord OAuth mock login sets account session and profile link", async (t) => {
  const server = startServer({
    AUTH_EMAIL: "0",
    DISCORD_LOGIN: "1",
    DISCORD_OAUTH_MOCK: "1",
    DISCORD_MOCK_USER: JSON.stringify({
      id: "778899001122",
      username: "cord.user",
      global_name: "Cord Ace",
    }),
  });
  t.after(() => stopServer(server));
  await server.ready;

  const jar = cookieJar();
  const start = await fetchSession(server.base, "/login?discord=1", jar);
  assert.equal(start.status, 302);
  const loc = start.headers.get("location");
  assert.ok(loc && /\/login\/discord\/callback/.test(loc));
  const cbPath = loc.startsWith("http") ? new URL(loc).pathname + new URL(loc).search : loc;
  const done = await fetchSession(server.base, cbPath, jar);
  assert.equal(done.status, 302);
  const home = await fetchSession(server.base, "/", jar);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Cord Ace/);
  const profileMatch = homeHtml.match(/\/profile\/(\d+)/);
  assert.ok(profileMatch);
  const profile = await fetchSession(server.base, `/profile/${profileMatch[1]}`, jar);
  assert.match(await profile.text(), /778899001122/);
});

test("Formbar login sets account session; Digipog buy needs formbar; paid play uses accountId", async (t) => {
  const server = startServer({ AUTH_EMAIL: "0" });
  t.after(() => stopServer(server));
  await server.ready;

  const formJar = cookieJar();
  const token = signFormbar({ id: 424242, displayName: "Formbar Ace" }, undefined, { expiresIn: "1h" });
  const oauth = await fetchSession(server.base, `/login?token=${encodeURIComponent(token)}`, formJar);
  assert.equal(oauth.status, 302);
  const unsigned = await fetchSession(
    server.base,
    `/login?token=${encodeURIComponent(unsignedFormbar({ id: 1, displayName: "Nope" }))}`,
    cookieJar(),
  );
  assert.equal(unsigned.status, 400);
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
  const token = signFormbar({ id: 515151, displayName: "Link Me" }, undefined, { expiresIn: "1h" });
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

async function runSql(dataDir, sql, params = []) {
  const { default: sqlite3 } = await import("sqlite3");
  const dbFile = path.join(dataDir, "Men Of The Line.sqlite");
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.run(sql, params, (err) => {
      db.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

async function getAccountRow(dataDir, whereSql, params) {
  const { default: sqlite3 } = await import("sqlite3");
  const dbFile = path.join(dataDir, "Men Of The Line.sqlite");
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.get(
      `SELECT id, formbar_id, discord_id, email, name, tickets, wins, losses, mmr
       FROM accounts WHERE ${whereSql}`,
      params,
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row || null);
      },
    );
  });
}

async function countAccounts(dataDir) {
  const { default: sqlite3 } = await import("sqlite3");
  const dbFile = path.join(dataDir, "Men Of The Line.sqlite");
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.get("SELECT COUNT(*) AS n FROM accounts", [], (err, row) => {
      db.close();
      if (err) reject(err);
      else resolve(Number(row.n));
    });
  });
}

function pathFromLocation(loc) {
  if (!loc) return null;
  if (loc.startsWith("http")) {
    const u = new URL(loc);
    return u.pathname + u.search;
  }
  return loc;
}

async function followDiscordOAuth(base, jar, startPath) {
  const start = await fetchSession(base, startPath, jar, {
    method: startPath.startsWith("/profile/") ? "POST" : "GET",
    headers: startPath.startsWith("/profile/")
      ? { "content-type": "application/x-www-form-urlencoded" }
      : {},
    body: startPath.startsWith("/profile/") ? new URLSearchParams({}) : undefined,
  });
  assert.equal(start.status, 302);
  const cbPath = pathFromLocation(start.headers.get("location"));
  assert.ok(cbPath && /\/login\/discord\/callback/.test(cbPath));
  return fetchSession(base, cbPath, jar);
}

async function linkFormbarViaToken(base, jar, formbarId, displayName) {
  const begin = await fetchSession(base, "/profile/link/formbar", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({}),
  });
  assert.equal(begin.status, 302);
  const token = signFormbar({ id: formbarId, displayName });
  return fetchSession(base, `/login?token=${encodeURIComponent(token)}`, jar);
}

test("linking Formbar then Discord merges into one account with all providers", async (t) => {
  const server = startServer({
    AUTH_EMAIL: "0",
    DISCORD_LOGIN: "1",
    DISCORD_OAUTH_MOCK: "1",
    DISCORD_MOCK_USER: JSON.stringify({
      id: "900100200",
      username: "merge.discord",
      global_name: "Merge Discord",
    }),
  });
  t.after(() => stopServer(server));
  await server.ready;

  const formJar = cookieJar();
  await fetchSession(
    server.base,
    `/login?token=${encodeURIComponent(signFormbar({ id: 610001, displayName: "Form Only" }))}`,
    formJar,
  );
  await runSql(server.dataDir, "UPDATE accounts SET tickets = 3, wins = 2 WHERE formbar_id = ?", [610001]);

  const localJar = cookieJar();
  await fetchSession(server.base, "/signup", localJar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Merge Local",
      email: "mergelocal@example.com",
      password: "password123",
    }),
  });
  await runSql(server.dataDir, "UPDATE accounts SET tickets = 1, wins = 1 WHERE email = ?", [
    "mergelocal@example.com",
  ]);

  const linkedForm = await linkFormbarViaToken(server.base, localJar, 610001, "Form Only");
  assert.equal(linkedForm.status, 302);
  let row = await getAccountRow(server.dataDir, "email = ?", ["mergelocal@example.com"]);
  assert.equal(row.formbar_id, 610001);
  assert.equal(row.tickets, 4);
  assert.equal(row.wins, 3);
  assert.equal(await countAccounts(server.dataDir), 1);

  const discJar = cookieJar();
  await followDiscordOAuth(server.base, discJar, "/login?discord=1");
  await runSql(server.dataDir, "UPDATE accounts SET tickets = 5, wins = 4 WHERE discord_id = ?", [
    "900100200",
  ]);
  assert.equal(await countAccounts(server.dataDir), 2);

  const linkedDisc = await followDiscordOAuth(server.base, localJar, "/profile/link/discord");
  assert.equal(linkedDisc.status, 302);
  row = await getAccountRow(server.dataDir, "email = ?", ["mergelocal@example.com"]);
  assert.equal(row.formbar_id, 610001);
  assert.equal(row.discord_id, "900100200");
  assert.equal(row.tickets, 9);
  assert.equal(row.wins, 7);
  assert.equal(await countAccounts(server.dataDir), 1);

  const home = await fetchSession(server.base, "/", localJar);
  const profileId = (await home.text()).match(/\/profile\/(\d+)/)[1];
  const profile = await fetchSession(server.base, `/profile/${profileId}`, localJar);
  const html = await profile.text();
  assert.match(html, /mergelocal@example\.com/);
  assert.match(html, /#610001/);
  assert.match(html, /900100200/);
  assert.match(html, /Accounts merged|Discord is linked|Account links/);
});

test("merge refuses when both accounts already have different Formbar ids", async (t) => {
  const server = startServer({
    AUTH_EMAIL: "0",
    DISCORD_LOGIN: "1",
    DISCORD_OAUTH_MOCK: "1",
    DISCORD_MOCK_USER: JSON.stringify({
      id: "900100201",
      username: "conflict.discord",
      global_name: "Conflict Discord",
    }),
  });
  t.after(() => stopServer(server));
  await server.ready;

  const survivor = cookieJar();
  await fetchSession(server.base, "/signup", survivor, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Survivor",
      email: "survivor@example.com",
      password: "password123",
    }),
  });
  await linkFormbarViaToken(server.base, survivor, 710001, "Survivor Form");

  const donor = cookieJar();
  await followDiscordOAuth(server.base, donor, "/login?discord=1");
  await linkFormbarViaToken(server.base, donor, 710002, "Donor Form");

  assert.equal(await countAccounts(server.dataDir), 2);
  const beforeSurvivor = await getAccountRow(server.dataDir, "email = ?", ["survivor@example.com"]);
  const beforeDonor = await getAccountRow(server.dataDir, "discord_id = ?", ["900100201"]);
  assert.equal(beforeSurvivor.formbar_id, 710001);
  assert.equal(beforeDonor.formbar_id, 710002);

  const refused = await followDiscordOAuth(server.base, survivor, "/profile/link/discord");
  assert.equal(refused.status, 302);
  assert.match(refused.headers.get("location") || "", /\/profile\//);

  assert.equal(await countAccounts(server.dataDir), 2);
  const afterSurvivor = await getAccountRow(server.dataDir, "email = ?", ["survivor@example.com"]);
  const afterDonor = await getAccountRow(server.dataDir, "discord_id = ?", ["900100201"]);
  assert.equal(afterSurvivor.discord_id, null);
  assert.equal(afterSurvivor.formbar_id, 710001);
  assert.equal(afterDonor.formbar_id, 710002);

  const profile = await fetchSession(server.base, `/profile/${afterSurvivor.id}`, survivor);
  assert.match(await profile.text(), /different Formbar/);
});

test("new accounts use provider names and auto-discriminate collisions", async (t) => {
  const server = startServer({
    AUTH_EMAIL: "0",
    DISCORD_LOGIN: "1",
    DISCORD_OAUTH_MOCK: "1",
    DISCORD_MOCK_USER: JSON.stringify({
      id: "900100300",
      username: "same.name",
      global_name: "Shared Name",
    }),
  });
  t.after(() => stopServer(server));
  await server.ready;

  const formA = cookieJar();
  await fetchSession(
    server.base,
    `/login?token=${encodeURIComponent(signFormbar({ id: 910001, displayName: "Shared Name" }))}`,
    formA,
  );
  let row = await getAccountRow(server.dataDir, "formbar_id = ?", [910001]);
  assert.equal(row.name, "Shared Name");

  const formB = cookieJar();
  await fetchSession(
    server.base,
    `/login?token=${encodeURIComponent(signFormbar({ id: 910002, displayName: "Shared Name" }))}`,
    formB,
  );
  row = await getAccountRow(server.dataDir, "formbar_id = ?", [910002]);
  assert.equal(row.name, "Shared Name 2");

  const localJar = cookieJar();
  await fetchSession(server.base, "/signup", localJar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Shared Name",
      email: "sharedname@example.com",
      password: "password123",
    }),
  });
  row = await getAccountRow(server.dataDir, "email = ?", ["sharedname@example.com"]);
  assert.equal(row.name, "Shared Name 3");

  // Returning Formbar login must not overwrite a customized MOTL name.
  await runSql(server.dataDir, "UPDATE accounts SET name = ? WHERE formbar_id = ?", [
    "Custom Keep",
    910001,
  ]);
  await fetchSession(
    server.base,
    `/login?token=${encodeURIComponent(signFormbar({ id: 910001, displayName: "Shared Name" }))}`,
    formA,
  );
  row = await getAccountRow(server.dataDir, "formbar_id = ?", [910001]);
  assert.equal(row.name, "Custom Keep");
});

test("profile can change display name with rate limiting", async (t) => {
  const server = startServer({ AUTH_EMAIL: "0" });
  t.after(() => stopServer(server));
  await server.ready;
  const jar = cookieJar();
  await fetchSession(server.base, "/signup", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Rename Me",
      email: "rename@example.com",
      password: "password123",
    }),
  });
  const home = await fetchSession(server.base, "/", jar);
  const profileId = (await home.text()).match(/\/profile\/(\d+)/)[1];

  const other = cookieJar();
  await fetchSession(server.base, "/signup", other, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Taken Name",
      email: "takenname@example.com",
      password: "password123",
    }),
  });

  const taken = await fetchSession(server.base, "/profile/name", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Taken Name" }),
  });
  assert.equal(taken.status, 302);
  let profile = await fetchSession(server.base, `/profile/${profileId}`, jar);
  assert.match(await profile.text(), /already taken/);

  for (const name of ["Rename One", "Rename Two", "Rename Three"]) {
    const res = await fetchSession(server.base, "/profile/name", jar, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name }),
    });
    assert.equal(res.status, 302);
  }
  const row = await getAccountRow(server.dataDir, "email = ?", ["rename@example.com"]);
  assert.equal(row.name, "Rename Three");

  const blocked = await fetchSession(server.base, "/profile/name", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Rename Four" }),
  });
  assert.equal(blocked.status, 302);
  profile = await fetchSession(server.base, `/profile/${profileId}`, jar);
  assert.match(await profile.text(), /too often/);
  const still = await getAccountRow(server.dataDir, "email = ?", ["rename@example.com"]);
  assert.equal(still.name, "Rename Three");
});

test("local link with password merges Discord from the other account", async (t) => {
  const server = startServer({
    AUTH_EMAIL: "0",
    DISCORD_LOGIN: "1",
    DISCORD_OAUTH_MOCK: "1",
    DISCORD_MOCK_USER: JSON.stringify({
      id: "900100202",
      username: "local.merge",
      global_name: "Local Merge Disc",
    }),
  });
  t.after(() => stopServer(server));
  await server.ready;

  const formJar = cookieJar();
  await fetchSession(
    server.base,
    `/login?token=${encodeURIComponent(signFormbar({ id: 810001, displayName: "Form Survivor" }))}`,
    formJar,
  );

  const localJar = cookieJar();
  await fetchSession(server.base, "/signup", localJar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Has Discord",
      email: "hasdiscord@example.com",
      password: "password123",
    }),
  });
  await followDiscordOAuth(server.base, localJar, "/profile/link/discord");
  await runSql(server.dataDir, "UPDATE accounts SET tickets = 2 WHERE email = ?", [
    "hasdiscord@example.com",
  ]);
  await runSql(server.dataDir, "UPDATE accounts SET tickets = 4 WHERE formbar_id = ?", [810001]);

  const home = await fetchSession(server.base, "/", formJar);
  const profileId = (await home.text()).match(/\/profile\/(\d+)/)[1];
  const merge = await fetchSession(server.base, "/profile/link/local", formJar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "hasdiscord@example.com",
      password: "password123",
    }),
  });
  assert.equal(merge.status, 302);

  const row = await getAccountRow(server.dataDir, "formbar_id = ?", [810001]);
  assert.equal(row.email, "hasdiscord@example.com");
  assert.equal(row.discord_id, "900100202");
  assert.equal(row.tickets, 6);
  assert.equal(await countAccounts(server.dataDir), 1);

  const profile = await fetchSession(server.base, `/profile/${profileId}`, formJar);
  const html = await profile.text();
  assert.match(html, /hasdiscord@example\.com/);
  assert.match(html, /900100202/);
  assert.match(html, /Accounts merged/);
});
