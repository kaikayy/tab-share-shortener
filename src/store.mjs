/*!
 * store.mjs -- pick a storage backend.
 *
 *   SHORTENER_STORE_BACKEND=file    -> JSON file (default; good for local / small)
 *   SHORTENER_STORE_BACKEND=sqlite  -> node:sqlite (durable; for a real server)
 *
 * If unset, a store path ending in .db / .sqlite / .sqlite3 implies sqlite,
 * anything else implies file.
 *
 * Both backends implement the same surface:
 *   has(code) get(code) put(code,{url,mode,ttlDays}) delete(code)
 *   bumpHits(code) findByUrl(url) revoke(code) unrevoke(code) list()
 *   setExpiry(code,expires) sweepExpired() stats() flushSync() close()
 * -- see store-file.mjs for the contract.
 */

import { createRequire } from "node:module";
import { config } from "./config.mjs";
import { FileStore } from "./store-file.mjs";

const require = createRequire(import.meta.url);

function wantsSqlite() {
  const b = (config.storeBackend || "").toLowerCase();
  if (b === "sqlite") return true;
  if (b === "file") return false;
  return /\.(db|sqlite|sqlite3)$/i.test(config.storePath || "");
}

/** @returns {FileStore} a store implementing the shared interface */
export function openStore() {
  if (wantsSqlite()) {
    // Loaded only when chosen, so `node:sqlite` (Node 22.5+) isn't a hard need.
    const { SqliteStore } = require("./store-sqlite.mjs");
    return new SqliteStore();
  }
  return new FileStore();
}

export { FileStore };
