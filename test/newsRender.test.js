import assert from "node:assert/strict";
import test from "node:test";

process.env.THIS_URL = "https://example.com";

const {
  renderNewsWebsiteHtml,
  renderNewsPlainText,
  renderNewsEmailHtml,
  absolutizeHtml,
  buildNewsEmailPayload,
} = await import("../server/newsRender.js");

const entry = {
  id: "2026-10-05-test",
  date: "2026-10-05",
  title: "Test News",
  category: "balance",
  summary: "Hello **world** and <script>alert(1)</script>",
  body: "See [home](/) and ![img](/img/x.png)",
  items: ["Bullet one", "Bullet two"],
};

test("website html escapes raw HTML from markdown", () => {
  const html = renderNewsWebsiteHtml(entry);
  assert.match(html, /Test News/);
  assert.match(html, /balance/);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /Bullet one/);
});

test("email html uses absolute URLs and branding", () => {
  const html = renderNewsEmailHtml(entry, {
    siteUrl: "https://example.com",
    unsubscribeUrl: "https://example.com/unsubscribe/news?token=abc",
  });
  assert.match(html, /Men Of The Line/);
  assert.match(html, /href="https:\/\/example\.com\/"/);
  assert.match(html, /src="https:\/\/example\.com\/img\/x\.png"/);
  assert.match(html, /Unsubscribe/);
  assert.match(html, /https:\/\/example\.com\/unsubscribe\/news\?token=abc/);
});

test("plain text is readable and includes unsubscribe", () => {
  const text = renderNewsPlainText(entry, {
    siteUrl: "https://example.com",
    unsubscribeUrl: "https://example.com/unsubscribe/news?token=abc",
  });
  assert.match(text, /Test News/);
  assert.match(text, /- Bullet one/);
  assert.match(text, /Unsubscribe from news emails/);
  assert.match(text, /token=abc/);
});

test("absolutizeHtml rewrites relative href/src", () => {
  const out = absolutizeHtml('<a href="/x">x</a><img src="/y.png">', "https://example.com");
  assert.match(out, /https:\/\/example\.com\/x/);
  assert.match(out, /https:\/\/example\.com\/y\.png/);
});

test("buildNewsEmailPayload subject defaults", () => {
  const payload = buildNewsEmailPayload(entry, { siteUrl: "https://example.com" });
  assert.equal(payload.subject, "Men Of The Line — Test News");
  assert.ok(payload.html.includes("Test News"));
  assert.ok(payload.text.includes("Test News"));
});
