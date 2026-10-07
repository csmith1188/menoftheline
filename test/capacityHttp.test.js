import test from "node:test";
import assert from "node:assert/strict";

process.env.SKIP_FORMBAR = "1";
process.env.METRICS_LOG = "0";
process.env.METRICS = "";

const { listen, httpServer, io } = await import("../app.js");
const { disconnectFormbar } = await import("../server/formbar.js");

test("metrics route is absent until METRICS=1, and static assets cache", async (t) => {
  await listen(0);
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    disconnectFormbar();
    await new Promise((resolve) => {
      io.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  const hidden = await fetch(`${base}/api/v1/metrics`);
  assert.equal(hidden.status, 404);

  process.env.METRICS = "1";
  const stillHidden = await fetch(`${base}/api/v1/metrics`);
  assert.equal(stillHidden.status, 404);

  process.env.METRICS_TOKEN = "metrics-test-token";
  const shown = await fetch(`${base}/api/v1/metrics`, {
    headers: { authorization: "Bearer metrics-test-token" },
  });
  assert.equal(shown.status, 200);
  const body = await shown.json();
  assert.equal(body.enabled, true);
  assert.equal(typeof body.roomTicks, "number");

  const script = await fetch(`${base}/js/main.js`);
  assert.equal(script.status, 200);
  const cache = script.headers.get("cache-control") || "";
  assert.match(cache, /max-age=3600/);

  const versioned = await fetch(`${base}/js/main.js?v=1`);
  assert.equal(versioned.status, 200);
  assert.match(versioned.headers.get("cache-control") || "", /max-age=3600/);

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const homeCache = home.headers.get("cache-control") || "";
  assert.equal(homeCache.includes("max-age=3600"), false);
  const html = await home.text();
  assert.match(html, /\/css\/landing\.css\?v=/);
});
