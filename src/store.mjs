/*!
 * store.mjs — the link table.
 *
 * File-backed JSON: the whole table is held in memory and flushed to disk
 * (atomic write + rename, debounced) after changes. Fine for local use and a
 * small self-host — tens of thousands of links. For anything bigger, swap this
 * module for SQLite / Redis / a KV store; the surface it has to implement is
 * just: get, has, put, delete, stats.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

const SCHEMA = 1;

/** @typedef {{ url: string, mode: string, created: number, expires: number, hits: number }} Entry */

export class LinkStore {
  /** @param {string} [file] */
  constructor(file = config.storePath) {
    this.file = file;
    /** @type {Map<string, Entry>} */
    this.map = new Map();
    this._dirty = false;
    this._timer = null;
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return; // fresh store
      throw e;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new Error(`store file ${this.file} is not valid JSON`);
    }
    const links = doc && typeof doc.links === "object" ? doc.links : {};
    const now = Date.now();
    for (const [code, e] of Object.entries(links)) {
      if (!e || typeof e.url !== "string") continue;
      if (e.expires && e.expires < now) continue; // drop expired on load
      this.map.set(code, {
        url: e.url,
        mode: e.mode || "code",
        created: e.created || now,
        expires: e.expires || 0,
        hits: e.hits || 0,
      });
    }
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flushSync();
    }, 250);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  /** Write immediately (used on shutdown and by the debounce timer). */
  flushSync() {
    if (!this._dirty) return;
    this._dirty = false;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const doc = { schema: SCHEMA, updated: Date.now(), links: Object.fromEntries(this.map) };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), "utf8");
    renameSync(tmp, this.file);
  }

  /** @param {string} code */
  has(code) {
    return this.map.has(code);
  }

  /** @param {string} code @returns {Entry | null} — null if missing or expired */
  get(code) {
    const e = this.map.get(code);
    if (!e) return null;
    if (e.expires && e.expires < Date.now()) {
      this.map.delete(code);
      this._scheduleFlush();
      return null;
    }
    return e;
  }

  /**
   * @param {string} code
   * @param {{ url: string, mode: string, ttlDays?: number }} data
   * @returns {Entry}
   */
  put(code, { url, mode, ttlDays }) {
    const days = ttlDays == null ? config.ttlDays : ttlDays;
    const entry = {
      url,
      mode,
      created: Date.now(),
      expires: days > 0 ? Date.now() + days * 86400_000 : 0,
      hits: 0,
    };
    this.map.set(code, entry);
    this._scheduleFlush();
    return entry;
  }

  /** @param {string} code */
  delete(code) {
    const had = this.map.delete(code);
    if (had) this._scheduleFlush();
    return had;
  }

  /** @param {string} code */
  bumpHits(code) {
    const e = this.map.get(code);
    if (!e) return;
    e.hits++;
    this._scheduleFlush();
  }

  stats() {
    let expiring = 0;
    for (const e of this.map.values()) if (e.expires) expiring++;
    return { total: this.map.size, expiring };
  }
}
