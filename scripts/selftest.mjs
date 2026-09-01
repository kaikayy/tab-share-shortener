#!/usr/bin/env node
/**
 * selftest.mjs -- `npm test`
 *
 * Unit checks on the pure modules, then a real HTTP round-trip against the
 * server (temp store, throwaway port). Exits non-zero on the first failure.
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = path.join(tmpdir(), `tss-selftest-${process.pid}.json`);
const VIEWER = "https://kaikayy.github.io/multi-link-share/";

process.env.SHORTENER_PORT = String(PORT);
process.env.SHORTENER_BASE = BASE;
process.env.SHORTENER_HOSTS = "kaikayy.github.io";
process.env.SHORTENER_STORE = STORE;
process.env.SHORTENER_RATE = "0"; // disable limiter for the round-trip
process.env.SHORTENER_META_REFRESH_OVER = "7000";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ----------------------------- unit ----------------------------- */

const { generate, looksLikeCode, normalizeMode } = await import("../src/codes.mjs");
const { RateLimiter } = await import("../src/ratelimit.mjs");
const { validateTarget } = await import("../src/validate.mjs");
const { truncateIp } = await import("../src/accesslog.mjs");

test("SHORTENER_HOSTS_FILE merges with SHORTENER_HOSTS", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const hf = path.join(tmpdir(), `tss-hosts-${process.pid}.txt`);
  writeFileSync(hf, "# a comment\nfriend.example\n\n  Other.Example  \n");
  const out = execFileSync(
    process.execPath,
    ["-e", "import('./src/config.mjs').then(m => console.log(JSON.stringify(m.config.allowedHosts)))"],
    { cwd: root, env: { ...process.env, SHORTENER_HOSTS: "me.example", SHORTENER_HOSTS_FILE: hf } },
  );
  const hosts = JSON.parse(out.toString().trim());
  assert.deepEqual(hosts.sort(), ["friend.example", "me.example", "other.example"]);
  rmSync(hf, { force: true });
});

test("truncateIp drops host bits (privacy)", () => {
  assert.equal(truncateIp("203.0.113.47"), "203.0.113.0");
  assert.equal(truncateIp("::ffff:203.0.113.47"), "203.0.113.0"); // v4-mapped
  assert.equal(truncateIp("2001:db8:abcd:1234::1"), "2001:db8:abcd::");
  assert.equal(truncateIp("2001:db8::1"), "2001:db8:0::");
  assert.equal(truncateIp(""), "");
  assert.equal(truncateIp("garbage"), "");
});

test("code mode: 7 unambiguous chars", () => {
  const c = generate("code", () => false);
  assert.match(c, /^[2-9a-km-zA-HJ-NP-Z]{7}$/);
});

test("words mode: adjective-adjective-noun", () => {
  const c = generate("words", () => false);
  assert.match(c, /^[a-z]+-[a-z]+-[a-z]+$/);
});

test("words mode: collision appends a -xx suffix", () => {
  let calls = 0;
  const c = generate("words", () => calls++ < 1); // first candidate "taken"
  assert.match(c, /^[a-z]+-[a-z]+-[a-z]+-[2-9a-km-zA-HJ-NP-Z]{2}$/);
});

test("code mode: widens when crowded instead of looping forever", () => {
  const taken = new Set();
  const c = generate("code", (x) => {
    if (taken.size < 30) { taken.add(x); return true; }
    return false;
  });
  assert.ok(c.length >= 7);
});

test("looksLikeCode accepts real codes, rejects junk", () => {
  assert.ok(looksLikeCode("k7Rm2pq"));
  assert.ok(looksLikeCode("swift-amber-otter"));
  assert.ok(!looksLikeCode("../etc/passwd"));
  assert.ok(!looksLikeCode("has space"));
  assert.ok(!looksLikeCode("-leadinghyphen"));
});

test("normalizeMode falls back to code", () => {
  assert.equal(normalizeMode("words"), "words");
  assert.equal(normalizeMode("nonsense"), "code");
  assert.equal(normalizeMode(undefined), "code");
});

test("RateLimiter enforces the window", () => {
  const rl = new RateLimiter(2);
  assert.ok(rl.allow("ip"));
  assert.ok(rl.allow("ip"));
  assert.ok(!rl.allow("ip"));
  assert.ok(rl.allow("other"));
});

test("validateTarget: allowlist + scheme rules", () => {
  assert.ok(validateTarget(`${VIEWER}#abc`).ok);
  assert.equal(validateTarget("https://evil.example/#x").ok, false);
  assert.equal(validateTarget("http://kaikayy.github.io/#x").ok, false); // not https
  assert.equal(validateTarget("not a url").ok, false);
  assert.equal(validateTarget("").ok, false);
});

test("validateTarget: rejects oversized url", () => {
  const huge = `${VIEWER}#` + "a".repeat(300 * 1024);
  const r = validateTarget(huge);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

/* -------------------------- integration -------------------------- */

const { server, store } = await import("../src/server.mjs");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));

async function api(method, pathname, { json, headers } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    redirect: "manual",
    headers: json ? { "content-type": "application/json", ...headers } : headers,
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test("GET /api/health", async () => {
  const r = await api("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).ok, true);
});

test("POST /api/shorten (code) then redirect round-trips", async () => {
  const target = `${VIEWER}#NoZgTest_v3payload`;
  const r = await api("POST", "/api/shorten", { json: { url: target, mode: "code" } });
  assert.equal(r.status, 201);
  const body = JSON.parse(r.text);
  assert.match(body.code, /^[2-9a-km-zA-HJ-NP-Z]{7}$/);
  assert.equal(body.shortUrl, `${BASE}/${body.code}`);

  const red = await api("GET", `/${body.code}`);
  assert.equal(red.status, 302);
  assert.equal(red.headers.get("location"), target);
  assert.equal(red.headers.get("cache-control"), "no-store");
});

test("HEAD behaves like GET, no body, no hit bump", async () => {
  const target = `${VIEWER}#head_probe_v3`;
  const code = JSON.parse((await api("POST", "/api/shorten", { json: { url: target, mode: "code" } })).text).code;

  const h = await api("HEAD", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.text, ""); // headers only

  const before = store.get(code).hits || 0;
  const red = await api("HEAD", `/${code}`);
  assert.equal(red.status, 302);
  assert.equal(red.headers.get("location"), target);
  assert.equal(red.text, "");
  assert.equal((store.get(code).hits || 0), before); // HEAD is not a click

  const bad = await api("HEAD", "/no-such-code");
  assert.equal(bad.status, 404);
});

test("POST /api/shorten (words) returns a readable slug", async () => {
  const r = await api("POST", "/api/shorten", { json: { url: `${VIEWER}#x`, mode: "words" } });
  assert.equal(r.status, 201);
  assert.match(JSON.parse(r.text).code, /^[a-z]+-[a-z]+-[a-z]+(-[2-9a-km-zA-HJ-NP-Z]{2})?$/);
});

test("shortening the same URL twice returns the same code (dedup)", async () => {
  const target = `${VIEWER}#dedup_me_v3`;
  const a = JSON.parse((await api("POST", "/api/shorten", { json: { url: target, mode: "code" } })).text);
  const b = await api("POST", "/api/shorten", { json: { url: target, mode: "words" } });
  const bj = JSON.parse(b.text);
  assert.equal(bj.code, a.code); // same code, even though a different style was asked for
  assert.equal(bj.reused, true);
  assert.equal(b.status, 200); // reuse is 200, fresh is 201
});

test("compat GET /new?url= returns text/plain short URL", async () => {
  const target = `${VIEWER}#compatcheck`;
  const r = await api("GET", `/new?url=${encodeURIComponent(target)}&mode=words`);
  assert.equal(r.status, 200);
  assert.ok(r.text.startsWith(`${BASE}/`));
  const code = r.text.slice(`${BASE}/`.length);
  assert.match(code, /^[a-z]+-[a-z]+-[a-z]+(-[2-9a-km-zA-HJ-NP-Z]{2})?$/);
});

test("disallowed host is refused", async () => {
  const r = await api("POST", "/api/shorten", { json: { url: "https://phish.example/#x" } });
  assert.equal(r.status, 403);
});

test("non-https is refused", async () => {
  const r = await api("POST", "/api/shorten", { json: { url: "http://kaikayy.github.io/#x" } });
  assert.equal(r.status, 400);
});

test("very long target redirects via HTML meta-refresh", async () => {
  const target = `${VIEWER}#` + "a".repeat(9000);
  const r = await api("POST", "/api/shorten", { json: { url: target } });
  assert.equal(r.status, 201);
  const { code } = JSON.parse(r.text);

  const red = await api("GET", `/${code}`);
  assert.equal(red.status, 200);
  assert.match(red.headers.get("content-type"), /text\/html/);
  assert.ok(red.text.includes("http-equiv=\"refresh\""));
  assert.ok(red.text.includes("a".repeat(9000)));
});

test("unknown code -> 404", async () => {
  const r = await api("GET", "/nope123");
  assert.equal(r.status, 404);
});

test("oversized POST body -> clean 413 (not a connection reset)", async () => {
  const huge = `${VIEWER}#` + "a".repeat(400 * 1024); // > maxBodyBytes
  const r = await api("POST", "/api/shorten", { json: { url: huge } });
  assert.equal(r.status, 413);
  assert.match(r.text, /exceeds/);
});

test("store persists to disk", async () => {
  const target = `${VIEWER}#persisttest`;
  const r = await api("POST", "/api/shorten", { json: { url: target } });
  const { code } = JSON.parse(r.text);
  store.flushSync();
  const disk = JSON.parse(await (await import("node:fs/promises")).readFile(STORE, "utf8"));
  assert.equal(disk.links[code].url, target);
});

/* ----------------------------- run ----------------------------- */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

try { server.close(); } catch {}
try { rmSync(STORE, { force: true }); rmSync(`${STORE}.tmp`, { force: true }); } catch {}

console.log(`\n${passed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
