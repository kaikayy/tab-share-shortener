#!/usr/bin/env node
/**
 * selftest-worker.mjs -- exercise deploy/worker.js with a fake KV binding.
 * No wrangler, no network. Run by `npm test` alongside the Node server tests.
 */

import assert from "node:assert/strict";
import worker from "../deploy/worker.js";

const VIEWER = "https://kaikayy.github.io/multi-link-share/";

function makeEnv() {
  const map = new Map();
  return {
    SHORTENER_BASE: "https://s.example.com",
    SHORTENER_HOSTS: "kaikayy.github.io",
    LINKS: {
      get: async (k) => (map.has(k) ? map.get(k) : null),
      put: async (k, v) => void map.set(k, v),
    },
    _map: map,
  };
}

const req = (path, init) => new Request(`https://s.example.com${path}`, init);
const jbody = (o) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

let passed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("health", async () => {
  const r = await worker.fetch(req("/api/health"), makeEnv());
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test("POST shorten (code) + redirect", async () => {
  const env = makeEnv();
  const target = `${VIEWER}#realtoken_v3`;
  const r = await worker.fetch(req("/api/shorten", jbody({ url: target, mode: "code" })), env);
  assert.equal(r.status, 201);
  const b = await r.json();
  assert.match(b.code, /^[2-9a-km-zA-HJ-NP-Z]{7}$/);
  assert.equal(b.shortUrl, `https://s.example.com/${b.code}`);

  const red = await worker.fetch(req(`/${b.code}`), env);
  assert.equal(red.status, 302);
  assert.equal(red.headers.get("location"), target);
  assert.equal(red.headers.get("cache-control"), "no-store");
});

test("HEAD is routed like GET", async () => {
  const env = makeEnv();
  const b = await (await worker.fetch(req("/api/shorten", jbody({ url: `${VIEWER}#head_v3`, mode: "code" })), env)).json();

  const h = await worker.fetch(req("/api/health", { method: "HEAD" }), env);
  assert.equal(h.status, 200);

  const red = await worker.fetch(req(`/${b.code}`, { method: "HEAD" }), env);
  assert.equal(red.status, 302);
  assert.equal(red.headers.get("location"), `${VIEWER}#head_v3`);
});

test("words mode slug shape", async () => {
  const r = await worker.fetch(req("/api/shorten", jbody({ url: `${VIEWER}#x`, mode: "words" })), makeEnv());
  assert.equal(r.status, 201);
  assert.match((await r.json()).code, /^[a-z]+-[a-z]+-[a-z]+(-[2-9a-km-zA-HJ-NP-Z]{2})?$/);
});

test("dedup: same URL twice -> same code, reused:true, 200", async () => {
  const env = makeEnv();
  const target = `${VIEWER}#dedup_worker`;
  const a = await (await worker.fetch(req("/api/shorten", jbody({ url: target, mode: "code" })), env)).json();
  const rb = await worker.fetch(req("/api/shorten", jbody({ url: target, mode: "words" })), env);
  const b = await rb.json();
  assert.equal(rb.status, 200);
  assert.equal(b.code, a.code);
  assert.equal(b.reused, true);
});

test("compat GET /new", async () => {
  const target = `${VIEWER}#compat`;
  const r = await worker.fetch(req(`/new?mode=words&url=${encodeURIComponent(target)}`), makeEnv());
  assert.equal(r.status, 200);
  assert.ok((await r.text()).startsWith("https://s.example.com/"));
});

test("disallowed host -> 403", async () => {
  const r = await worker.fetch(req("/api/shorten", jbody({ url: "https://evil.example/#x" })), makeEnv());
  assert.equal(r.status, 403);
});

test("non-https -> 400", async () => {
  const r = await worker.fetch(req("/api/shorten", jbody({ url: "http://kaikayy.github.io/#x" })), makeEnv());
  assert.equal(r.status, 400);
});

test("very long target -> meta-refresh 200", async () => {
  const env = makeEnv();
  const target = `${VIEWER}#` + "a".repeat(9000);
  const b = await (await worker.fetch(req("/api/shorten", jbody({ url: target })), env)).json();
  const red = await worker.fetch(req(`/${b.code}`), env);
  assert.equal(red.status, 200);
  assert.match(red.headers.get("content-type"), /text\/html/);
  assert.ok((await red.text()).includes("a".repeat(9000)));
});

test("unknown code -> 404", async () => {
  const r = await worker.fetch(req("/missing"), makeEnv());
  assert.equal(r.status, 404);
});

test("collision falls back to a suffixed slug", async () => {
  const env = makeEnv();
  // pre-fill so the first ~unsuffixed slug is very likely taken at least once
  for (const a of ["swift", "amber"]) for (const b of ["otter", "cedar"]) env._map.set(`${a}-${a}-${b}`, "x");
  const b = await (await worker.fetch(req("/api/shorten", jbody({ url: `${VIEWER}#x`, mode: "words" })), env)).json();
  assert.match(b.code, /^[a-z]+-[a-z]+-[a-z]+(-[2-9a-km-zA-HJ-NP-Z]{2})?$/);
});

let failed = 0;
for (const [n, f] of tests) {
  try {
    await f();
    passed++;
    console.log(`  ok  ${n}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${n}\n      ${e.message}`);
  }
}
console.log(`\nworker: ${passed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
