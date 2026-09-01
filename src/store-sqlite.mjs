/*!
 * store-sqlite.mjs -- the link table, backed by SQLite via node:sqlite.
 *
 * node:sqlite is built into Node 22.5+ (unflagged since Node 24). Still zero
 * npm dependencies. Use this backend for a real deployment: durable, handles
 * far more rows than the JSON file, safe to back up with a file copy while
 * running (WAL mode).
 *
 * Every query uses bound parameters -- no string interpolation into SQL.
 *
 * Interface shared with store-file.mjs:
 *   has(code) get(code) put(code,{url,mode,ttlDays}) delete(code)
 *   bumpHits(code) findByUrl(url) stats() flushSync() close()
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

/** @typedef {{ url: string, mode: string, created: number, expires: number, hits: number }} Entry */

export class SqliteStore {
  /** @param {string} [file] */
  constructor(file = config.storePath) {
    this.file = file;
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });

    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 4000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        code     TEXT PRIMARY KEY,
        url      TEXT NOT NULL,
        mode     TEXT NOT NULL DEFAULT 'code',
        created  INTEGER NOT NULL,
        expires  INTEGER NOT NULL DEFAULT 0,
        hits     INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS links_url ON links(url)");

    this._get = this.db.prepare("SELECT url, mode, created, expires, hits FROM links WHERE code = ?");
    this._has = this.db.prepare("SELECT 1 FROM links WHERE code = ?");
    this._byUrl = this.db.prepare(
      "SELECT code, url, mode, created, expires, hits FROM links WHERE url = ? ORDER BY created DESC LIMIT 1",
    );
    this._put = this.db.prepare(
      "INSERT OR REPLACE INTO links (code, url, mode, created, expires, hits) VALUES (?, ?, ?, ?, ?, 0)",
    );
    this._del = this.db.prepare("DELETE FROM links WHERE code = ?");
    this._bump = this.db.prepare("UPDATE links SET hits = hits + 1 WHERE code = ?");
    this._count = this.db.prepare("SELECT COUNT(*) AS n, SUM(expires > 0) AS e FROM links");
    this._sweep = this.db.prepare("DELETE FROM links WHERE expires != 0 AND expires < ?");

    // drop anything already expired
    this._sweep.run(Date.now());
  }

  /** @param {string} code */
  has(code) {
    return !!this._has.get(code);
  }

  /** @param {string} code @returns {Entry | null} */
  get(code) {
    const row = this._get.get(code);
    if (!row) return null;
    if (row.expires && row.expires < Date.now()) {
      this._del.run(code);
      return null;
    }
    return { url: row.url, mode: row.mode, created: row.created, expires: row.expires, hits: row.hits };
  }

  /** @param {string} url @returns {{ code: string, entry: Entry } | null} */
  findByUrl(url) {
    const row = this._byUrl.get(url);
    if (!row) return null;
    if (row.expires && row.expires < Date.now()) {
      this._del.run(row.code);
      return null;
    }
    return {
      code: row.code,
      entry: { url: row.url, mode: row.mode, created: row.created, expires: row.expires, hits: row.hits },
    };
  }

  /**
   * @param {string} code
   * @param {{ url: string, mode: string, ttlDays?: number }} data
   * @returns {Entry}
   */
  put(code, { url, mode, ttlDays }) {
    const days = ttlDays == null ? config.ttlDays : ttlDays;
    const now = Date.now();
    const expires = days > 0 ? now + days * 86400_000 : 0;
    this._put.run(code, url, mode, now, expires);
    return { url, mode, created: now, expires, hits: 0 };
  }

  /** @param {string} code */
  delete(code) {
    return this._del.run(code).changes > 0;
  }

  /** @param {string} code */
  bumpHits(code) {
    this._bump.run(code);
  }

  stats() {
    const r = this._count.get();
    return { total: r.n || 0, expiring: r.e || 0, backend: "sqlite" };
  }

  /** No-op: writes are already durable. Kept for interface parity. */
  flushSync() {}

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
