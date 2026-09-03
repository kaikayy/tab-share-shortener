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
const HOSTS_FILE = path.join(tmpdir(), `tss-selftest-hosts-${process.pid}.txt`);
const ANALYTICS = path.join(tmpdir(), `tss-selftest-an-${process.pid}.json`);
const ADMIN_TOKEN = "selftest-admin-token";
const VIEWER = "https://kaikayy.github.io/multi-link-share/";

writeFileSync(HOSTS_FILE, "kaikayy.github.io\n");

process.env.SHORTENER_PORT = String(PORT);
process.env.SHORTENER_BASE = BASE;
process.env.SHORTENER_HOSTS = "kaikayy.github.io";
process.env.SHORTENER_HOSTS_FILE = HOSTS_FILE;
process.env.SHORTENER_STORE = STORE;
process.env.SHORTENER_ANALYTICS_STORE = ANALYTICS;
process.env.SHORTENER_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.SHORTENER_RATE = "0"; // disable limiter for the round-trip
process.env.SHORTENER_META_REFRESH_OVER = "7000";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ----------------------------- unit ----------------------------- */

const { generate, looksLikeCode, normalizeMode } = await import("../src/codes.mjs");
const { RateLimiter } = await import("../src/ratelimit.mjs");
const { validateTarget } = await import("../src/validate.mjs");
const { config } = await import("../src/config.mjs");
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
  const huge = `${VIEWER}#` + "a".repeat(config.maxUrlBytes);
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
  const huge = `${VIEWER}#` + "a".repeat(config.maxBodyBytes + 64 * 1024); // > maxBodyBytes
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

test("POST /api/shorten applies the default 30-day TTL and returns a keepToken", async () => {
  const r = await api("POST", "/api/shorten", { json: { url: `${VIEWER}#ttl_default` } });
  assert.equal(r.status, 201);
  const body = JSON.parse(r.text);
  assert.match(body.keepToken, /^[2-9a-km-zA-HJ-NP-Z]{22}$/);
  const days = (body.expires - Date.now()) / 86400_000;
  assert.ok(days > 29 && days < 31, `expected ~30 days, got ${days}`);
});

test("GET /new carries the keep token in the X-Keep-Token header", async () => {
  const target = `${VIEWER}#keep_header_probe`;
  const res = await fetch(`${BASE}/new?url=${encodeURIComponent(target)}`, { redirect: "manual" });
  assert.equal(res.status, 200);
  const tok = res.headers.get("x-keep-token");
  assert.match(tok, /^[2-9a-km-zA-HJ-NP-Z]{22}$/);
  assert.match(res.headers.get("access-control-expose-headers") || "", /x-keep-token/);
});

test("POST /api/keep pins a link forever with the right token", async () => {
  const target = `${VIEWER}#keep_pin_probe`;
  const mk = JSON.parse((await api("POST", "/api/shorten", { json: { url: target } })).text);
  assert.ok(mk.expires > Date.now());

  const bad = await api("POST", "/api/keep", { json: { code: mk.code, keepToken: "wrongwrongwrongwrong12" } });
  assert.equal(bad.status, 403);

  const miss = await api("POST", "/api/keep", { json: { code: "no-such-code", keepToken: mk.keepToken } });
  assert.equal(miss.status, 404);

  const ok = await api("POST", "/api/keep", { json: { code: mk.code, keepToken: mk.keepToken } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).expires, null); // pinned
  assert.equal(store.get(mk.code).expires, 0);
});

test("POST /api/keep with ttlDays re-sets a finite window", async () => {
  const target = `${VIEWER}#keep_reset_probe`;
  const mk = JSON.parse((await api("POST", "/api/shorten", { json: { url: target } })).text);
  const ok = await api("POST", "/api/keep", { json: { code: mk.code, keepToken: mk.keepToken, ttlDays: 7 } });
  assert.equal(ok.status, 200);
  const days = (JSON.parse(ok.text).expires - Date.now()) / 86400_000;
  assert.ok(days > 6 && days < 8, `expected ~7 days, got ${days}`);
});

test("POST /api/keep needs both fields", async () => {
  const r = await api("POST", "/api/keep", { json: { code: "x" } });
  assert.equal(r.status, 400);
});

/* --------------------------- admin panel --------------------------- */

const admin = (method, pathname, opts = {}) =>
  api(method, pathname, { ...opts, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...opts.headers } });

test("admin: the tree 404s without a valid token", async () => {
  assert.equal((await api("GET", "/admin")).status, 404);
  assert.equal((await api("GET", "/admin/api/overview")).status, 404);
  assert.equal((await api("GET", "/admin", { headers: { authorization: "Bearer wrong" } })).status, 404);
});

test("admin: token unlocks the dashboard + overview", async () => {
  const page = await admin("GET", "/admin");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const ov = await admin("GET", "/admin/api/overview");
  assert.equal(ov.status, 200);
  assert.equal(JSON.parse(ov.text).ops.backend, "file");
});

test("admin: ?token= sets an HttpOnly cookie and redirects", async () => {
  const r = await api("GET", `/admin?token=${ADMIN_TOKEN}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/admin");
  assert.match(r.headers.get("set-cookie"), /tss_admin=.*HttpOnly/i);
});

test("admin: create then revoke -> the link 404s but the row stays", async () => {
  const mk = await admin("POST", "/admin/api/links", {
    json: { url: `${VIEWER}#admin_made`, slug: "adm-demo" },
  });
  assert.equal(mk.status, 201);
  assert.equal((await api("GET", "/adm-demo")).status, 302);

  const rev = await admin("POST", "/admin/api/links/adm-demo/revoke");
  assert.equal(JSON.parse(rev.text).ok, true);
  assert.equal((await api("GET", "/adm-demo")).status, 404);

  const list = JSON.parse((await admin("GET", "/admin/api/links?q=adm-demo")).text);
  const listed = list.links.find((l) => l.code === "adm-demo");
  assert.ok(listed && listed.revoked > 0);

  assert.equal(JSON.parse((await admin("POST", "/admin/api/links/adm-demo/unrevoke")).text).ok, true);
  assert.equal((await api("GET", "/adm-demo")).status, 302);
});

test("admin: bulk revoke / delete by filter", async () => {
  for (const n of [1, 2, 3]) {
    await admin("POST", "/admin/api/links", { json: { url: `${VIEWER}#bulk${n}`, slug: `bk-${n}` } });
  }
  await admin("POST", "/admin/api/links", { json: { url: `${VIEWER}#keepme`, slug: "bk-keep" } });

  // empty filter is refused -- there is no "act on every link"
  assert.equal((await admin("POST", "/admin/api/links/bulk", { json: { op: "delete", q: "" } })).status, 400);
  assert.equal((await admin("POST", "/admin/api/links/bulk", { json: { op: "nope", q: "bk-" } })).status, 400);

  const rev = JSON.parse((await admin("POST", "/admin/api/links/bulk", { json: { op: "revoke", q: "bk-" } })).text);
  assert.equal(rev.matched, 4);
  assert.equal(rev.affected, 4);
  assert.equal((await api("GET", "/bk-1")).status, 404);
  assert.equal((await api("GET", "/bk-keep")).status, 404);

  // a narrower filter: only the three, restored, then hard-deleted
  assert.equal(
    JSON.parse((await admin("POST", "/admin/api/links/bulk", { json: { op: "unrevoke", q: "bk-1" } })).text).affected,
    1,
  );
  const del = JSON.parse((await admin("POST", "/admin/api/links/bulk", { json: { op: "delete", q: "bk-" } })).text);
  assert.equal(del.matched, 4);
  assert.equal(JSON.parse((await admin("GET", "/admin/api/links?q=bk-")).text).links.length, 0);
});

test("admin: /admin/metrics is Prometheus text behind the token", async () => {
  assert.equal((await api("GET", "/admin/metrics")).status, 404); // no token -> not here
  const m = await admin("GET", "/admin/metrics");
  assert.equal(m.status, 200);
  assert.match(m.headers.get("content-type") || "", /text\/plain/);
  assert.match(m.text, /# TYPE tabshare_shortener_links gauge/);
  assert.match(m.text, /# TYPE tabshare_shortener_redirects_total counter/);
  assert.match(m.text, /^tabshare_shortener_uptime_seconds \d+$/m);
});

test("admin: the link list carries the target host, not the destination URL", async () => {
  await admin("POST", "/admin/api/links", { json: { url: `${VIEWER}#host_only_probe`, slug: "host-probe" } });
  const list = JSON.parse((await admin("GET", "/admin/api/links?q=host-probe")).text);
  const row = list.links.find((l) => l.code === "host-probe");
  assert.equal(row.host, "kaikayy.github.io");
  assert.equal(row.url, undefined); // the browsable list never carries destinations

  // ...revealing one link is a deliberate, per-code request
  const rev = JSON.parse((await admin("GET", "/admin/api/links/host-probe/url")).text);
  assert.equal(rev.url, `${VIEWER}#host_only_probe`);
  assert.equal((await admin("GET", "/admin/api/links/nope-nope/url")).status, 404);
});

test("admin: overview reports the default link TTL", async () => {
  const ov = JSON.parse((await admin("GET", "/admin/api/overview")).text);
  assert.equal(ov.ops.defaultTtlDays, 30);
});

test("admin: create with ttlDays, then keep / expire a link", async () => {
  const mk = await admin("POST", "/admin/api/links", {
    json: { url: `${VIEWER}#admin_ttl`, slug: "adm-ttl", ttlDays: 5 },
  });
  assert.equal(mk.status, 201);
  const days = (JSON.parse(mk.text).expires - Date.now()) / 86400_000;
  assert.ok(days > 4 && days < 6, `expected ~5 days, got ${days}`);
  const row = JSON.parse((await admin("GET", "/admin/api/links?q=adm-ttl")).text).links[0];
  assert.ok(row.expires > Date.now());
  assert.equal(row.keep, undefined); // the browsable list never carries keep tokens

  // operator "keep" pins with no token
  const kept = await admin("POST", "/admin/api/links/adm-ttl/keep");
  assert.equal(JSON.parse(kept.text).ok, true);
  assert.equal(store.get("adm-ttl").expires, 0);

  // operator "expire" in N days
  const exp = await admin("POST", "/admin/api/links/adm-ttl/expire", { json: { days: 2 } });
  const ed = (JSON.parse(exp.text).expires - Date.now()) / 86400_000;
  assert.ok(ed > 1 && ed < 3, `expected ~2 days, got ${ed}`);

  // expire now (days: 0) -> the link stops resolving
  await admin("POST", "/admin/api/links/adm-ttl/expire", { json: { days: 0 } });
  assert.equal((await api("GET", "/adm-ttl")).status, 404);
});

test("admin: editing the host allowlist takes effect immediately", async () => {
  const before = await api("POST", "/api/shorten", { json: { url: "https://added.example.io/#x" } });
  assert.equal(before.status, 403);

  const put = await admin("PUT", "/admin/api/hosts", {
    json: { hosts: ["kaikayy.github.io", "added.example.io"] },
  });
  assert.equal(put.status, 200);

  const after = await api("POST", "/api/shorten", { json: { url: "https://added.example.io/#x" } });
  assert.equal(after.status, 201);

  // put it back so later assertions about the allowlist still hold
  await admin("PUT", "/admin/api/hosts", { json: { hosts: ["kaikayy.github.io"] } });
});

test("admin: rejects a malformed host", async () => {
  const r = await admin("PUT", "/admin/api/hosts", { json: { hosts: ["ok.io", "not a host"] } });
  assert.equal(r.status, 400);
});

test("admin: analytics count redirects, creates and rejects", async () => {
  await api("POST", "/api/shorten", { json: { url: "https://blocked.example/#x" } }); // a reject
  const code = JSON.parse(
    (await api("POST", "/api/shorten", { json: { url: `${VIEWER}#stats_probe` } })).text,
  ).code;
  await api("GET", `/${code}`, { headers: { referer: "https://ref.example/page" } });

  const s = JSON.parse((await admin("GET", "/admin/api/stats?range=7")).text);
  assert.ok(s.summary.totals.hits >= 1);
  assert.ok(s.summary.totals.creates >= 1);
  assert.ok(s.summary.totals.rejects >= 1);
  assert.ok(s.referrers.find((r) => r.host === "ref.example"));
  assert.ok(s.rejects.find((r) => r.reason === "host_not_allowed"));
});

test("admin: browser stats are a family + major version, from the UA", async () => {
  const code = JSON.parse(
    (await api("POST", "/api/shorten", { json: { url: `${VIEWER}#ua_probe` } })).text,
  ).code;
  await api("GET", `/${code}`, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0",
    },
  });
  const s = JSON.parse((await admin("GET", "/admin/api/stats?range=7")).text);
  assert.ok(s.browsers.find((b) => b.browser === "Firefox 130"));
  // no raw UA string is retained anywhere
  const dump = JSON.stringify(s);
  assert.ok(!dump.includes("Gecko/20100101"));
});

test("admin: /admin/api/domains tallies bundled-page domains, not the viewer host", async () => {
  const { createRequire } = await import("node:module");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(path.join(repoRoot, "src/lib/x.js"));
  const ShareCodec = require("./share-codec.js");
  const token = ShareCodec.encode({
    title: "trip",
    pages: [
      { url: "https://old.reddit.com/r/travel/comments/abc/where/", title: "r" },
      { url: "https://www.reddit.com/r/maps/comments/def/", title: "r2" },
      { url: "https://github.com/foo/bar", title: "g" },
      { url: "https://docs.bbc.co.uk/whatever", title: "b" },
    ],
  });
  await api("POST", "/api/shorten", { json: { url: `${VIEWER}#${token}` } });

  const h = JSON.parse((await admin("GET", "/admin/api/domains")).text);
  const by = Object.fromEntries(h.domains.map((d) => [d.domain, d]));
  assert.equal(by["reddit.com"].pages, 2); // www. and old. collapse
  assert.equal(by["reddit.com"].links, 1);
  assert.ok(by["github.com"]);
  assert.ok(by["bbc.co.uk"]); // multi-part TLD kept
  assert.ok(!by["kaikayy.github.io"]); // the viewer host is never counted as content
  assert.ok(h.decoded >= 1 && h.pages >= 4);
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
for (const f of [STORE, `${STORE}.tmp`, HOSTS_FILE, `${HOSTS_FILE}.tmp`, ANALYTICS, `${ANALYTICS}.tmp`]) {
  try { rmSync(f, { force: true }); } catch {}
}

console.log(`\n${passed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
