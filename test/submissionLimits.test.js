import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";

function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-limits-"));
  const port = 19210 + Math.floor(Math.random() * 200);
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
      FORMBAR_LOGIN: "0",
      AUTH_EMAIL: "0",
      SESSION_SECRET: "test-limits-secret",
      NODE_ENV: "test",
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
  return { child, base: `http://127.0.0.1:${port}`, dataDir, ready };
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

function runSql(dbFile, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.run(sql, params, function onRun(err) {
      db.close();
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getSql(dbFile, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.get(sql, params, (err, row) => {
      db.close();
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function signupAndLogin(server, email, name) {
  const jar = cookieJar();
  const signup = await fetchSession(server.base, "/signup", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name, email, password: "password123" }),
  });
  assert.equal(signup.status, 302);
  const login = await fetchSession(server.base, "/login", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "password123" }),
  });
  assert.equal(login.status, 302);
  return jar;
}

async function postSuggestion(server, jar, { body, isBug = false, repro = "" }) {
  const params = new URLSearchParams({ next: "/", body });
  if (isBug) {
    params.set("is_bug", "1");
    params.set("repro", repro);
  }
  const res = await fetchSession(server.base, "/suggestions", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  assert.equal(res.status, 302);
  const home = await fetchSession(server.base, "/", jar);
  return home.text();
}

test("extra unanswered suggestions cost a ticket; bugs cap at 5", async (t) => {
  const server = startServer();
  t.after(() => stopServer(server));
  await server.ready;
  const email = "limits@example.com";
  const jar = await signupAndLogin(server, email, "Limit User");
  const dbFile = path.join(server.dataDir, "Men Of The Line.sqlite");

  let html = await postSuggestion(server, jar, { body: "First free idea" });
  assert.match(html, /Thanks for the suggestion/);

  html = await postSuggestion(server, jar, { body: "Needs a ticket" });
  assert.match(html, /Extra suggestions cost 1 ticket/);

  await runSql(dbFile, "UPDATE accounts SET tickets = 2 WHERE email = ?", [email]);
  html = await postSuggestion(server, jar, { body: "Paid idea" });
  assert.match(html, /Used 1 ticket/);
  const tickets = await getSql(dbFile, "SELECT tickets FROM accounts WHERE email = ?", [email]);
  assert.equal(tickets.tickets, 1);

  for (let i = 0; i < 5; i += 1) {
    html = await postSuggestion(server, jar, {
      body: `Bug ${i}`,
      isBug: true,
      repro: `steps ${i}`,
    });
    assert.match(html, /Thanks for the bug report/);
  }
  html = await postSuggestion(server, jar, {
    body: "Bug overflow",
    isBug: true,
    repro: "more steps",
  });
  assert.match(html, /unresolved bug reports/);
});

test("unapproved wiki edits cap at 5 per account", async (t) => {
  const server = startServer();
  t.after(() => stopServer(server));
  await server.ready;
  const email = "wikieditor@example.com";
  const jar = await signupAndLogin(server, email, "Wiki Editor");
  const dbFile = path.join(server.dataDir, "Men Of The Line.sqlite");
  const account = await getSql(dbFile, "SELECT id FROM accounts WHERE email = ?", [email]);
  const now = Date.now();
  await runSql(
    dbFile,
    `INSERT INTO games (id, mode, account_a, account_b, formbar_a, formbar_b, winner_side, created_at, ended_at)
     VALUES (?, 'ranked', ?, NULL, NULL, NULL, 'player', ?, ?)`,
    [`test-ranked-${account.id}`, account.id, now, now],
  );

  for (let i = 0; i < 5; i += 1) {
    const res = await fetchSession(server.base, "/rules/home/edit", jar, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "Home", body: `Edit number ${i}\n\nMore text.` }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/rules/home");
  }

  const blocked = await fetchSession(server.base, "/rules/home/edit", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "Home", body: "Should fail" }),
  });
  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get("location"), "/rules/home/edit");
  const editPage = await fetchSession(server.base, "/rules/home/edit", jar);
  assert.match(await editPage.text(), /unapproved wiki changes/i);
});
