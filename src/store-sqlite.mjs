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
 *   revoke(code) unrevoke(code) list() setExpiry(code,expires) sweepExpired()
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { keepToken } from "./codes.mjs";

/** @typedef {{ url: string, mode: string, created: number, expires: number, hits: number, lastHit: number, revoked: number, keep: string }} Entry */

const SELECT_COLS = "url, mode, created, expires, hits, last_hit AS lastHit, revoked, keep";

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
        hits     INTEGER NOT NULL DEFAULT 0,
        last_hit INTEGER NOT NULL DEFAULT 0,
        revoked  INTEGER NOT NULL DEFAULT 0,
        keep     TEXT NOT NULL DEFAULT ''
      )
    `);
    // migrate an older table in place (ALTER throws if the column exists)
    for (const col of [
      "last_hit INTEGER NOT NULL DEFAULT 0",
      "revoked INTEGER NOT NULL DEFAULT 0",
      "keep TEXT NOT NULL DEFAULT ''",
    ]) {
      try {
        this.db.exec(`ALTER TABLE links ADD COLUMN ${col}`);
      } catch {
        /* column already present */
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS links_url ON links(url)");

    this._get = this.db.prepare(`SELECT ${SELECT_COLS} FROM links WHERE code = ?`);
    this._has = this.db.prepare("SELECT 1 FROM links WHERE code = ?");
    this._byUrl = this.db.prepare(
      `SELECT code, ${SELECT_COLS} FROM links WHERE url = ? AND revoked = 0 ORDER BY created DESC LIMIT 1`,
    );
    this._list = this.db.prepare(`SELECT code, ${SELECT_COLS} FROM links ORDER BY created DESC`);
    this._put = this.db.prepare(
      "INSERT OR REPLACE INTO links (code, url, mode, created, expires, hits, last_hit, revoked, keep) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)",
    );
    this._del = this.db.prepare("DELETE FROM links WHERE code = ?");
    this._bump = this.db.prepare("UPDATE links SET hits = hits + 1, last_hit = ? WHERE code = ?");
    this._revoke = this.db.prepare("UPDATE links SET revoked = ? WHERE code = ? AND revoked = 0");
    this._unrevoke = this.db.prepare("UPDATE links SET revoked = 0 WHERE code = ? AND revoked != 0");
    this._setExpiry = this.db.prepare("UPDATE links SET expires = ? WHERE code = ?");
    this._count = this.db.prepare(
      "SELECT COUNT(*) AS n, SUM(expires > 0 AND revoked = 0) AS e, SUM(revoked != 0) AS r FROM links",
    );
    this._sweep = this.db.prepare("DELETE FROM links WHERE expires != 0 AND expires < ?");

    // drop anything already expired
    this._sweep.run(Date.now());
  }

  /** @param {string} code -- true while the slug is in use (revoked included). */
  has(code) {
    return !!this._has.get(code);
  }

  /** @param {string} code @returns {Entry | null} -- null if missing, expired or revoked */
  get(code) {
    const row = this._get.get(code);
    if (!row) return null;
    if (row.revoked) return null;
    if (row.expires && row.expires < Date.now()) {
      this._del.run(code);
      return null;
    }
    return this._row(row);
  }

  _row(row) {
    return {
      url: row.url,
      mode: row.mode,
      created: row.created,
      expires: row.expires,
      hits: row.hits,
      lastHit: row.lastHit || 0,
      revoked: row.revoked || 0,
      keep: row.keep || "",
    };
  }

  /** @param {string} url @returns {{ code: string, entry: Entry } | null} */
  findByUrl(url) {
    const row = this._byUrl.get(url);
    if (!row) return null;
    if (row.expires && row.expires < Date.now()) {
      this._del.run(row.code);
      return null;
    }
    return { code: row.code, entry: this._row(row) };
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
    const keep = keepToken();
    this._put.run(code, url, mode, now, expires, keep);
    return { url, mode, created: now, expires, hits: 0, lastHit: 0, revoked: 0, keep };
  }

  /** @param {string} code @param {number} expires -- epoch ms, or 0 to pin forever */
  setExpiry(code, expires) {
    return this._setExpiry.run(expires > 0 ? expires : 0, code).changes > 0;
  }

  /** Delete every expired row. @returns {number} how many. */
  sweepExpired() {
    return this._sweep.run(Date.now()).changes || 0;
  }

  /** @param {string} code -- permanent removal (frees the slug). */
  delete(code) {
    return this._del.run(code).changes > 0;
  }

  /** @param {string} code -- soft-delete: 404s on redirect, row kept for the record. */
  revoke(code) {
    return this._revoke.run(Date.now(), code).changes > 0;
  }

  /** @param {string} code -- undo revoke(). */
  unrevoke(code) {
    return this._unrevoke.run(code).changes > 0;
  }

  /** @returns {Array<Entry & { code: string }>} every row, newest first. */
  list() {
    return this._list.all().map((row) => ({ code: row.code, ...this._row(row) }));
  }

  /** @param {string} code */
  bumpHits(code) {
    this._bump.run(Date.now(), code);
  }

  stats() {
    const r = this._count.get();
    return { total: r.n || 0, expiring: r.e || 0, revoked: r.r || 0, backend: "sqlite" };
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
