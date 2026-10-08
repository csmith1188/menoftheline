import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function startServer(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-admin-http-"));
  const port = 19410 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ["app.js"], {
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
      DISCORD_LOGIN: "0",
      AUTH_EMAIL: "0",
      SESSION_SECRET: "test-admin-http-secret-xxxxxxxx",
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
  return { child, base: `http://127.0.0.1:${port}`, dataDir, ready, output: () => "" };
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
  const res = await fetch(`${base}/login`, { headers: jar.header(), redirect: "manual" });
  jar.store(res);
  const html = await res.text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match) jar.csrf = match[1];
}

async function signupAndLogin(base, jar, { email, name, password = "Password1!" }) {
  await primeCsrf(base, jar);
  let res = await fetch(`${base}/signup`, {
    method: "POST",
    headers: { ...jar.header(), "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      _csrf: jar.csrf,
      email,
      name,
      password,
      password2: password,
    }),
  });
  jar.store(res);
  // AUTH_EMAIL=0 may auto-verify / log in; otherwise login
  if (res.status >= 300) {
    await primeCsrf(base, jar);
    res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { ...jar.header(), "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        _csrf: jar.csrf,
        email,
        password,
      }),
    });
    jar.store(res);
  }
}

test("non-admin is redirected away from /admin", async () => {
  const server = startServer({});
  await server.ready;
  try {
    const jar = cookieJar();
    await signupAndLogin(server.base, jar, {
      email: "normie@example.com",
      name: "Normie",
    });
    const res = await fetch(`${server.base}/admin`, {
      headers: jar.header(),
      redirect: "manual",
    });
    assert.ok(res.status >= 300 && res.status < 400);
    assert.equal(res.headers.get("location"), "/");
  } finally {
    await stopServer(server);
  }
});

test("bootstrap admin can open /admin", async () => {
  // First boot creates account via signup outside; bootstrap needs existing id.
  // Create DB with a pre-promoted admin by starting once, signing up, then
  // restarting with ADMIN_BOOTSTRAP_ACCOUNT_ID=1.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-admin-boot-"));
  const port1 = 19610 + Math.floor(Math.random() * 80);
  const child1 = spawn(process.execPath, ["app.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port1),
      DATA_DIR: dataDir,
      SKIP_FORMBAR: "1",
      METRICS_LOG: "0",
      LOCAL_ACCOUNTS: "1",
      FORMBAR_LOGIN: "0",
      AUTH_EMAIL: "0",
      SESSION_SECRET: "test-admin-boot-secret-xxxxxxxx",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(buf)), 20000);
    const onData = (c) => {
      buf += c.toString();
      if (/listening on/.test(buf)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child1.stdout.on("data", onData);
    child1.stderr.on("data", onData);
  });
  const base1 = `http://127.0.0.1:${port1}`;
  const jar = cookieJar();
  await signupAndLogin(base1, jar, { email: "boss@example.com", name: "Boss" });
  child1.kill();
  await new Promise((r) => child1.once("exit", r));

  const port2 = port1 + 1;
  const child2 = spawn(process.execPath, ["app.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port2),
      DATA_DIR: dataDir,
      SKIP_FORMBAR: "1",
      METRICS_LOG: "0",
      LOCAL_ACCOUNTS: "1",
      FORMBAR_LOGIN: "0",
      AUTH_EMAIL: "0",
      SESSION_SECRET: "test-admin-boot-secret-xxxxxxxx",
      NODE_ENV: "test",
      ADMIN_BOOTSTRAP_ACCOUNT_ID: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(buf)), 20000);
    const onData = (c) => {
      buf += c.toString();
      if (/listening on/.test(buf)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child2.stdout.on("data", onData);
    child2.stderr.on("data", onData);
  });
  try {
    const base2 = `http://127.0.0.1:${port2}`;
    const jar2 = cookieJar();
    await signupAndLogin(base2, jar2, { email: "boss@example.com", name: "Boss" });
    // login with existing
    await primeCsrf(base2, jar2);
    let res = await fetch(`${base2}/login`, {
      method: "POST",
      headers: { ...jar2.header(), "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        _csrf: jar2.csrf,
        email: "boss@example.com",
        password: "Password1!",
      }),
    });
    jar2.store(res);
    res = await fetch(`${base2}/admin`, { headers: jar2.header(), redirect: "manual" });
    // Should render 200 (not redirect)
    if (res.status >= 300 && res.status < 400) {
      // follow once in case of session save bounce
      res = await fetch(`${base2}${res.headers.get("location")}`, {
        headers: jar2.header(),
        redirect: "manual",
      });
    }
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /System|Overview|Accounts/i);
  } finally {
    child2.kill();
    await new Promise((r) => child2.once("exit", r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
