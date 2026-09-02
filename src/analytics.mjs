/*!
 * analytics.mjs -- lightweight redirect analytics for the admin panel.
 *
 * Off unless SHORTENER_ANALYTICS != "0". Everything is aggregate: per-UTC-day
 * counters for hits / creates / rejects, a per-day tally of hits by code, by
 * referrer *host* (never the path or query), and by reject reason. Plus a small
 * ring of the most recent events for a live feed. No IPs, no per-user data.
 *
 * Persisted as one JSON file (config.analyticsPath, atomic write + rename,
 * debounced). Day buckets older than config.analyticsRetentionDays are dropped
 * on load and once a day.
 *
 * This is deliberately a flat JSON structure so a future SQL backend
 * (MariaDB / MySQL, or node:sqlite on Node 24+) can ingest it directly.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { parseUA } from "./ua.mjs";

const SCHEMA = 1;
const RECENT_MAX = 500;
const DIRECT = "(direct)";

/** @typedef {{ hits: number, creates: number, rejects: number,
 *              codes: Record<string, number>, refs: Record<string, number>,
 *              reasons: Record<string, number> }} Day */

/** @type {Map<string, Day>} dayKey -> counters */
const days = new Map();
/** @type {Array<{ t: number, type: string, code?: string, host?: string, reason?: string, mode?: string }>} */
let recent = [];
let startedAt = Date.now();

let dirty = false;
let flushTimer = null;
let pruneTimer = null;

/* ------------------------------ helpers ------------------------------ */

/** UTC calendar day, YYYY-MM-DD. */
export function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The last `n` day keys, oldest first, including today. */
function lastDays(n) {
  const out = [];
  const base = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(base - i * 86400_000));
  return out;
}

function freshDay() {
  return { hits: 0, creates: 0, rejects: 0, codes: {}, refs: {}, reasons: {}, browsers: {} };
}

function bucket(ts) {
  const k = dayKey(ts);
  let d = days.get(k);
  if (!d) {
    d = freshDay();
    days.set(k, d);
  }
  return d;
}

/** Referrer -> bare host, or "(direct)". Never keeps the path/query. */
export function refHost(referer) {
  if (!referer) return DIRECT;
  try {
    const h = new URL(referer).host.toLowerCase();
    return h || DIRECT;
  } catch {
    return DIRECT;
  }
}

function bump(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function pushRecent(ev) {
  recent.push(ev);
  if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX);
}

function scheduleFlush() {
  if (!config.analyticsEnabled) return;
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSync();
  }, 1000);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

function prune() {
  const cutoff = dayKey(Date.now() - config.analyticsRetentionDays * 86400_000);
  let removed = 0;
  for (const k of days.keys()) {
    if (k < cutoff) {
      days.delete(k);
      removed++;
    }
  }
  if (removed) scheduleFlush();
}

/* ------------------------------ lifecycle ------------------------------ */

export function initAnalytics() {
  if (!config.analyticsEnabled) return;
  startedAt = Date.now();
  try {
    const doc = JSON.parse(readFileSync(config.analyticsPath, "utf8"));
    if (doc && doc.days && typeof doc.days === "object") {
      for (const [k, v] of Object.entries(doc.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v) continue;
        days.set(k, {
          hits: v.hits || 0,
          creates: v.creates || 0,
          rejects: v.rejects || 0,
          codes: v.codes && typeof v.codes === "object" ? v.codes : {},
          refs: v.refs && typeof v.refs === "object" ? v.refs : {},
          reasons: v.reasons && typeof v.reasons === "object" ? v.reasons : {},
          browsers: v.browsers && typeof v.browsers === "object" ? v.browsers : {},
        });
      }
    }
    if (Array.isArray(doc.recent)) recent = doc.recent.slice(-RECENT_MAX);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("analytics: could not load store --", e.message);
  }
  prune();
  pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();
  console.log(
    `analytics: ${config.analyticsPath} (${days.size} day buckets, ${config.analyticsRetentionDays}-day retention)`,
  );
}

export function flushSync() {
  if (!config.analyticsEnabled || !dirty) return;
  dirty = false;
  try {
    mkdirSync(path.dirname(config.analyticsPath), { recursive: true });
    const doc = {
      schema: SCHEMA,
      updated: Date.now(),
      days: Object.fromEntries(days),
      recent,
    };
    const tmp = `${config.analyticsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), "utf8");
    renameSync(tmp, config.analyticsPath);
  } catch (e) {
    console.warn("analytics: write failed --", e.message);
  }
}

export function stopAnalytics() {
  if (flushTimer) clearInterval(flushTimer);
  if (pruneTimer) clearInterval(pruneTimer);
}

/* ------------------------------ recording ------------------------------ */

export function recordHit(code, referer, ua) {
  if (!config.analyticsEnabled) return;
  const d = bucket(Date.now());
  d.hits++;
  bump(d.codes, code);
  const host = refHost(referer);
  bump(d.refs, host);
  bump(d.browsers, parseUA(ua));
  pushRecent({ t: Date.now(), type: "hit", code, host });
  scheduleFlush();
}

export function recordCreate(code, mode) {
  if (!config.analyticsEnabled) return;
  const d = bucket(Date.now());
  d.creates++;
  pushRecent({ t: Date.now(), type: "create", code, mode: mode || "code" });
  scheduleFlush();
}

export function recordReject(reason, host) {
  if (!config.analyticsEnabled) return;
  const d = bucket(Date.now());
  d.rejects++;
  bump(d.reasons, reason || "other");
  pushRecent({ t: Date.now(), type: "reject", reason: reason || "other", host: host || "" });
  scheduleFlush();
}

/* ------------------------------ queries ------------------------------ */

/** @param {number} range days back to include (default 30) */
export function summary(range = 30) {
  const keys = lastDays(Math.max(1, Math.min(range, config.analyticsRetentionDays)));
  const series = keys.map((day) => {
    const d = days.get(day) || freshDay();
    return { day, hits: d.hits, creates: d.creates, rejects: d.rejects };
  });
  const totals = series.reduce(
    (a, s) => ({ hits: a.hits + s.hits, creates: a.creates + s.creates, rejects: a.rejects + s.rejects }),
    { hits: 0, creates: 0, rejects: 0 },
  );
  return {
    rangeDays: keys.length,
    activeDays: series.filter((s) => s.hits || s.creates || s.rejects).length,
    since: keys[0],
    totals,
    series,
    startedAt,
  };
}

function tally(range, field) {
  const keys = new Set(lastDays(Math.max(1, Math.min(range, config.analyticsRetentionDays))));
  const acc = {};
  for (const [k, d] of days) {
    if (!keys.has(k)) continue;
    for (const [name, n] of Object.entries(d[field] || {})) bump(acc, name, n);
  }
  return acc;
}

/** [{ code, hits }] over the range, busiest first. */
export function topLinks(range = 30, limit = 20) {
  return Object.entries(tally(range, "codes"))
    .map(([code, hits]) => ({ code, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}

/** [{ host, hits }] over the range, busiest first. */
export function referrers(range = 30, limit = 20) {
  return Object.entries(tally(range, "refs"))
    .map(([host, hits]) => ({ host, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}

/** [{ browser, hits }] over the range -- "Chrome 141", "Firefox 130", ... */
export function browsers(range = 30, limit = 20) {
  return Object.entries(tally(range, "browsers"))
    .map(([browser, hits]) => ({ browser, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}

/** [{ reason, count }] over the range. */
export function rejectReasons(range = 30) {
  return Object.entries(tally(range, "reasons"))
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/** Per-day hit series for a single code. */
export function seriesForCode(code, range = 30) {
  return lastDays(Math.max(1, Math.min(range, config.analyticsRetentionDays))).map((day) => ({
    day,
    hits: (days.get(day)?.codes || {})[code] || 0,
  }));
}

/** Most recent events, newest first. */
export function recentEvents(limit = 100) {
  return recent.slice(-limit).reverse();
}

/** Test hook: wipe in-memory state. */
export function _reset() {
  days.clear();
  recent = [];
  dirty = false;
}
