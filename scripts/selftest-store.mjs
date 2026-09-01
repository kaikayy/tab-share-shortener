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
