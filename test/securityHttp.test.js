import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicKeyB64, signFormbar, unsignedFormbar } from "./formbarToken.js";

function spawnServer(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-sechttp-"));
  const port = 19320 + Math.floor(Math.random() * 200);
  const childEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    SKIP_FORMBAR: "1",
    METRICS_LOG: "0",
    LOCAL_ACCOUNTS: "1",
    FORMBAR_LOGIN: "1",
    AUTH_EMAIL: "0",
    NODE_ENV: "test",
    SESSION_SECRET: "test-security-http-secret",
    FORMBAR_PUBLIC_KEY_B64: publicKeyB64,
    ...env,
  };
  const child = spawn(process.execPath, ["app.js"], {
    cwd: path.resolve("."),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const ready = new Promise((resolve, reject) => {
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
    ready,
    output: () => buf,
  };
}

function stopServer(server) {
  server.child.kill();
  return new Promise((resolve) => {
    server.child.once("exit", () => {
      fs.rmSync(server.dataDir, { recursive: true, force: true });
      resolve();
    });
  });
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const part = String(line).split(";")[0];
    if (part.startsWith("lane.sid=")) return part;
  }
  return "";
}

test("production process exits when the session secret is insecure", async () => {
  const env = {
    NODE_ENV: "production",
    SESSION_SECRET: "lane-pusher-local",
    FORMBAR_LOGIN: "0",
  };
  const childEnv = { ...process.env, ...env, PORT: "19301", SKIP_FORMBAR: "1" };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["app.js"], {
    cwd: path.resolve("."),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await new Promise((resolve) => {
    let buf = "";
    child.stdout.on("data", (chunk) => { buf += chunk.toString(); });
    child.stderr.on("data", (chunk) => { buf += chunk.toString(); });
    child.once("exit", (code) => resolve({ code, buf }));
  });
  assert.notEqual(result.code, 0);
  assert.equal(/listening on/.test(result.buf), false);
  assert.match(result.buf, /SESSION_SECRET/);
});

test("csrf rejects a missing token and accepts a real one", async (t) => {
  const server = spawnServer({});
  t.after(() => stopServer(server));
  await server.ready;
  const page = await fetch(`${server.base}/login`, { redirect: "manual" });
  const cookie = cookieFrom(page);
  const html = await page.text();
  const token = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  assert.ok(token);
  const missing = await fetch(`${server.base}/login`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "a@example.com", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(missing.status, 403);
  const present = await fetch(`${server.base}/login`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "a@example.com", password: "password123", _csrf: token }),
    redirect: "manual",
  });
  assert.equal(present.status, 400);
});

test("guest play csrf survives a parallel static asset fetch", async (t) => {
  const server = spawnServer({});
  t.after(() => stopServer(server));
  await server.ready;
  const [page, css] = await Promise.all([
    fetch(`${server.base}/games`, { redirect: "manual" }),
    fetch(`${server.base}/css/landing.css`, { redirect: "manual" }),
  ]);
  assert.equal(page.status, 200);
  assert.equal(css.status, 200);
  assert.equal(cookieFrom(css), "");
  const cookie = cookieFrom(page);
  assert.ok(cookie);
  const html = await page.text();
  const token = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  assert.ok(token);
  const play = await fetch(`${server.base}/play/bot`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: token }),
    redirect: "manual",
  });
  assert.equal(play.status, 302);
  assert.equal(play.headers.get("location"), "/play");
});

test("login rate limit returns before another password check", async (t) => {
  const server = spawnServer({ RATE_LOGIN_MAX: "2", RATE_LOGIN_WINDOW_MS: "60000" });
  t.after(() => stopServer(server));
  await server.ready;
  const page = await fetch(`${server.base}/login`, { redirect: "manual" });
  const cookie = cookieFrom(page);
  const html = await page.text();
  const token = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  let limited = 0;
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${server.base}/login`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "rate@example.com", password: "password123", _csrf: token }),
      redirect: "manual",
    });
    const body = await res.text();
    if (/Too many login attempts/.test(body)) limited += 1;
  }
  assert.ok(limited >= 1);
});

test("metrics stay hidden without admin or METRICS_TOKEN", async (t) => {
  const server = spawnServer({ METRICS: "1", METRICS_TOKEN: "metrics-test-token" });
  t.after(() => stopServer(server));
  await server.ready;
  const hidden = await fetch(`${server.base}/api/v1/metrics`);
  assert.equal(hidden.status, 404);
  const shown = await fetch(`${server.base}/api/v1/metrics`, {
    headers: { authorization: "Bearer metrics-test-token" },
  });
  assert.equal(shown.status, 200);
  const body = await shown.json();
  assert.equal(body.enabled, true);
});

test("Formbar OAuth start rotates the session; token callback keeps it", async (t) => {
  const server = spawnServer({});
  t.after(() => stopServer(server));
  await server.ready;
  const first = await fetch(`${server.base}/login`, { redirect: "manual" });
  const before = cookieFrom(first);
  assert.ok(before);
  const start = await fetch(`${server.base}/login?formbar=1`, {
    headers: { cookie: before },
    redirect: "manual",
  });
  assert.equal(start.status, 302);
  const mid = cookieFrom(start);
  assert.ok(mid);
  assert.notEqual(mid, before);
  const token = signFormbar({ id: 606060, displayName: "Signed Ace" }, undefined, { expiresIn: "1h" });
  const login = await fetch(`${server.base}/login?token=${encodeURIComponent(token)}`, {
    headers: { cookie: mid },
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/");
  const after = cookieFrom(login) || mid;
  const home = await fetch(`${server.base}/`, { headers: { cookie: after }, redirect: "manual" });
  assert.match(await home.text(), /Signed Ace/);
  const bad = await fetch(`${server.base}/login?token=${encodeURIComponent(unsignedFormbar({ id: 1, displayName: "Nope" }))}`, {
    redirect: "manual",
  });
  assert.equal(bad.status, 400);
});

test("production ignores DEBUG_RANGES", async (t) => {
  const secret = "production-session-secret-value-32";
  const env = {
    NODE_ENV: "production",
    SESSION_SECRET: secret,
    DEBUG_RANGES: "1",
    THIS_URL: "http://127.0.0.1:19380",
    PORT: "19380",
  };
  const childEnv = { ...process.env, ...env, SKIP_FORMBAR: "1", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "motl-debug-")) };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["app.js"], {
    cwd: path.resolve("."),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(buf)), 20000);
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
      reject(new Error(`exit ${code}\n${buf}`));
    });
  });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    try {
      fs.rmSync(childEnv.DATA_DIR, { recursive: true, force: true });
    } catch {
      // Windows can keep the SQLite file locked for a moment after exit.
    }
  });
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(buf, /DEBUG_RANGES is set but ignored in production/);
  assert.equal(/Debug ranges:/.test(buf), false);
});
