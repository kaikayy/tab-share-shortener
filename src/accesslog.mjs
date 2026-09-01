/*!
 * accesslog.mjs -- optional, privacy-reduced redirect log.
 *
 * Off unless SHORTENER_LOG is set. When on, each redirect appends one JSON line
 * to a per-UTC-day file (access-YYYY-MM-DD.log) with:
 *   { "t": <epoch ms>, "code": "<code>", "ip": "<truncated>" }
 *
 * The IP is truncated before it is written -- IPv4 loses its last octet (/24),
 * IPv6 keeps only the first three groups (/48) -- so a line points at a network,
 * not a person. Files older than SHORTENER_LOG_DAYS (default 30) are deleted on
 * startup and once a day.
 */

import { appendFile, readdir, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

/** @param {string} ip @returns {string} network-level prefix, no host bits */
export function truncateIp(ip) {
  if (typeof ip !== "string" || !ip) return "";
  let s = ip.replace(/^::ffff:/i, ""); // IPv4-mapped IPv6
  if (s.includes(".") && !s.includes(":")) {
    const p = s.split(".");
    if (p.length === 4) return `${p[0]}.${p[1]}.${p[2]}.0`;
    return "";
  }
  if (s.includes(":")) {
    let full;
    if (s.includes("::")) {
      const [l, r] = s.split("::");
      const lg = l ? l.split(":") : [];
      const rg = r ? r.split(":") : [];
      const mid = Array(Math.max(0, 8 - lg.length - rg.length)).fill("0");
      full = [...lg, ...mid, ...rg];
    } else {
      full = s.split(":");
    }
    if (full.length < 3) return "";
    return full.slice(0, 3).map((g) => g || "0").join(":") + "::";
  }
  return "";
}

function enabled() {
  return !!config.logPath;
}

function logDir() {
  const v = config.logPath;
  if (v === "1" || v === "true") {
    return path.join(path.dirname(config.storePath), "access-logs");
  }
  return v;
}

function dayFile(dir, d = new Date()) {
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return path.join(dir, `access-${iso}.log`);
}

let dir = null;
let pruneTimer = null;

export function initAccessLog() {
  if (!enabled()) return;
  dir = logDir();
  mkdirSync(dir, { recursive: true });
  prune();
  pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();
  console.log(`access log: ${dir} (truncated IPs, ${config.logDays}-day retention)`);
}

export function logHit(code, rawIp) {
  if (!enabled() || !dir) return;
  const line = JSON.stringify({ t: Date.now(), code, ip: truncateIp(rawIp) }) + "\n";
  appendFile(dayFile(dir), line).catch((e) => console.warn("access log write failed:", e.message));
}

async function prune() {
  if (!dir) return;
  const cutoff = Date.now() - config.logDays * 86400_000;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^access-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (!m) continue;
    if (Date.parse(m[1] + "T00:00:00Z") < cutoff) {
      await rm(path.join(dir, name)).catch(() => {});
    }
  }
}

export function stopAccessLog() {
  if (pruneTimer) clearInterval(pruneTimer);
}
