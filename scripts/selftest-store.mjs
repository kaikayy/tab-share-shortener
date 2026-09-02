#!/usr/bin/env node
/**
 * selftest-store.mjs -- run the same assertions against both storage backends.
 * `npm test` runs this alongside the server and worker checks.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { FileStore } = await import("../src/store-file.mjs");
const { SqliteStore } = await import("../src/store-sqlite.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);
const paths = [];

function suite(label, Ctor, ext) {
  let n = 0;
  const fresh = () => {
    const p = path.join(tmpdir(), `tss-store-${label}-${process.pid}-${n++}.${ext}`);
    paths.push(p);
    return new Ctor(p);
  };

  test(`[${label}] put / get / has`, () => {
    const s = fresh();
    s.put("abc", { url: "https://kaikayy.github.io/x#1", mode: "code" });
    assert.ok(s.has("abc"));
    assert.equal(s.get("abc").url, "https://kaikayy.github.io/x#1");
    assert.equal(s.get("abc").mode, "code");
    assert.equal(s.has("nope"), false);
    assert.equal(s.get("nope"), null);
    s.close();
  });

  test(`[${label}] findByUrl (dedup lookup)`, () => {
    const s = fresh();
    const url = "https://kaikayy.github.io/multi-link-share/#token";
    s.put("code1", { url, mode: "words" });
    const hit = s.findByUrl(url);
    assert.equal(hit.code, "code1");
    assert.equal(hit.entry.mode, "words");
    assert.equal(s.findByUrl("https://kaikayy.github.io/other#x"), null);
    s.close();
  });

  test(`[${label}] expiry drops the entry`, async () => {
    const s = fresh();
    s.put("gone", { url: "https://kaikayy.github.io/e#1", mode: "code", ttlDays: 0.12 / 86400 }); // ~120ms
    assert.ok(s.get("gone")); // still alive
    await sleep(200);
    assert.equal(s.get("gone"), null);
    assert.equal(s.findByUrl("https://kaikayy.github.io/e#1"), null);
    s.close();
  });

  test(`[${label}] delete + bumpHits + stats`, () => {
    const s = fresh();
    s.put("h", { url: "https://kaikayy.github.io/h#1", mode: "code" });
    s.bumpHits("h");
    s.bumpHits("h");
    assert.equal(s.get("h").hits, 2);
    assert.equal(s.stats().total, 1);
    assert.equal(s.stats().backend, label);
    assert.equal(s.delete("h"), true);
    assert.equal(s.delete("h"), false);
    assert.equal(s.stats().total, 0);
    s.close();
  });

  test(`[${label}] revoke: 404s but keeps the row and the slug`, () => {
    const s = fresh();
    const url = "https://kaikayy.github.io/r#1";
    s.put("rev", { url, mode: "code" });
    s.bumpHits("rev");
    assert.equal(s.revoke("rev"), true);
    assert.equal(s.revoke("rev"), false); // idempotent
    assert.equal(s.get("rev"), null); // redirect would 404
    assert.equal(s.has("rev"), true); // slug still reserved
    assert.equal(s.findByUrl(url), null); // drops out of dedup
    const row = s.list().find((e) => e.code === "rev");
    assert.ok(row && row.revoked > 0);
    assert.equal(row.hits, 1);
    assert.equal(s.stats().revoked, 1);
    assert.equal(s.unrevoke("rev"), true);
    assert.equal(s.get("rev").url, url);
    assert.ok(s.findByUrl(url));
    s.close();
  });

  test(`[${label}] list + lastHit`, () => {
    const s = fresh();
    s.put("a", { url: "https://kaikayy.github.io/a#1", mode: "code" });
    s.put("b", { url: "https://kaikayy.github.io/b#1", mode: "words" });
    assert.equal(s.get("a").lastHit, 0);
    s.bumpHits("a");
    assert.ok(s.get("a").lastHit > 0);
    const codes = s.list().map((e) => e.code).sort();
    assert.deepEqual(codes, ["a", "b"]);
    s.close();
  });

  test(`[${label}] put returns a keepToken; setExpiry pins and re-sets`, () => {
    const s = fresh();
    const e = s.put("kt", { url: "https://kaikayy.github.io/k#1", mode: "code", ttlDays: 30 });
    assert.match(e.keep, /^[0-9a-zA-Z]{22}$/);
    assert.ok(e.expires > Date.now());
    assert.equal(s.get("kt").keep, e.keep);
    // pin forever
    assert.equal(s.setExpiry("kt", 0), true);
    assert.equal(s.get("kt").expires, 0);
    // re-set a fresh window
    const soon = Date.now() + 86400_000;
    assert.equal(s.setExpiry("kt", soon), true);
    assert.equal(s.get("kt").expires, soon);
    assert.equal(s.setExpiry("nope", 0), false);
    s.close();
  });

  test(`[${label}] sweepExpired deletes only past-due rows`, () => {
    const s = fresh();
    s.put("live", { url: "https://kaikayy.github.io/s#1", mode: "code", ttlDays: 30 });
    s.put("dead", { url: "https://kaikayy.github.io/s#2", mode: "code" });
    s.setExpiry("dead", Date.now() - 1000);
    s.put("kept", { url: "https://kaikayy.github.io/s#3", mode: "code" });
    s.setExpiry("kept", 0); // pinned -- never swept
    assert.equal(s.sweepExpired(), 1);
    assert.equal(s.has("dead"), false);
    assert.ok(s.has("live"));
    assert.ok(s.has("kept"));
    assert.equal(s.sweepExpired(), 0); // idempotent
    s.close();
  });

  test(`[${label}] keepToken survives reopen`, () => {
    const p = path.join(tmpdir(), `tss-store-${label}-${process.pid}-keep.${ext}`);
    paths.push(p);
    const s1 = new Ctor(p);
    const e = s1.put("kp", { url: "https://kaikayy.github.io/kp#1", mode: "code" });
    s1.flushSync();
    s1.close();
    const s2 = new Ctor(p);
    assert.equal(s2.get("kp").keep, e.keep);
    s2.close();
  });

  test(`[${label}] survives reopen`, () => {
    const p = path.join(tmpdir(), `tss-store-${label}-${process.pid}-reopen.${ext}`);
    paths.push(p);
    const s1 = new Ctor(p);
    s1.put("persist", { url: "https://kaikayy.github.io/p#1", mode: "words" });
    s1.flushSync();
    s1.close();
    const s2 = new Ctor(p);
    assert.equal(s2.get("persist").url, "https://kaikayy.github.io/p#1");
    assert.equal(s2.findByUrl("https://kaikayy.github.io/p#1").code, "persist");
    s2.close();
  });
}

suite("file", FileStore, "json");
suite("sqlite", SqliteStore, "sqlite");

let failed = 0;
for (const [n, f] of tests) {
  try {
    await f();
    passed++;
    console.log(`  ok  ${n}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${n}\n      ${e.stack || e.message}`);
  }
}
for (const p of paths) {
  for (const suffix of ["", ".tmp", "-wal", "-shm"]) {
    try { rmSync(p + suffix, { force: true }); } catch {}
  }
}
console.log(`\nstore: ${passed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
