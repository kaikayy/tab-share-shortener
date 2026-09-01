/*!
 * config.mjs -- every knob, read once from the environment.
 *
 * Nothing here is secret. Override any value with an env var of the same name,
 * e.g.  SHORTENER_BASE=https://s.example.com  SHORTENER_HOSTS=me.github.io node src/server.mjs
 */

import path from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function envStr(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Read a newline-delimited host file (blank lines and `#` comments ignored). */
function readHostsFile(name) {
  const p = process.env[name];
  if (!p) return [];
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    console.warn(`${name}: cannot read ${p} -- ${e.message}`);
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
    .filter(Boolean);
}

/** Merge SHORTENER_HOSTS (comma list) with SHORTENER_HOSTS_FILE (a file). */
function computeAllowedHosts() {
  const fromEnv = envList("SHORTENER_HOSTS", null);
  const fromFile = readHostsFile("SHORTENER_HOSTS_FILE");
  if (fromEnv == null && fromFile.length === 0) return ["kaikayy.github.io"];
  return [...new Set([...(fromEnv || []), ...fromFile])];
}

const PORT = envInt("SHORTENER_PORT", 8779);
const STORE_PATH = envStr("SHORTENER_STORE", path.join(root, "data", "links.json"));
const DATA_DIR = path.dirname(STORE_PATH);

export const config = {
  root,

  /** Port the HTTP server binds to. */
  port: PORT,
  /** Interface to bind. 127.0.0.1 for local, 0.0.0.0 behind a proxy. */
  host: envStr("SHORTENER_HOST", "127.0.0.1"),

  /**
   * Public origin the short links are built from -- no trailing slash.
   * This is what goes in front of the code: `${base}/${code}`.
   */
  base: envStr("SHORTENER_BASE", `http://localhost:${PORT}`).replace(/\/+$/, ""),

  /**
   * Hosts a submitted link is allowed to point at (the Tab Share viewer
   * host, usually). Exact host[:port] match, case-insensitive. `localhost`
   * and `127.0.0.1` on any port are always allowed so local testing works.
   * An empty list means "allow any https host" -- only do that behind auth.
   *
   * From SHORTENER_HOSTS (comma list) plus SHORTENER_HOSTS_FILE (a
   * newline-delimited file, easier to manage / PR for a shared instance).
   * If SHORTENER_HOSTS is unset AND no file is given, defaults to the one
   * Tab Share viewer host.
   */
  allowedHosts: computeAllowedHosts(),

  /** Largest URL (in bytes) the service will store. 256 KB by default. */
  maxUrlBytes: envInt("SHORTENER_MAX_URL", 256 * 1024),

  /** Largest request body accepted, a little above maxUrlBytes for JSON overhead. */
  maxBodyBytes: envInt("SHORTENER_MAX_BODY", 320 * 1024),

  /**
   * Above this Location-header length, redirect with an HTML meta-refresh page
   * instead of a 302 (some proxies cap response headers near 8 KB).
   */
  metaRefreshOver: envInt("SHORTENER_META_REFRESH_OVER", 7000),

  /** Default link lifetime in days. 0 = never expires. */
  ttlDays: envInt("SHORTENER_TTL_DAYS", 0),

  /** Creation requests allowed per IP per rolling minute. 0 disables the limit. */
  ratePerMinute: envInt("SHORTENER_RATE", 30),

  /** Path to the link store file. */
  storePath: STORE_PATH,

  /** Directory the store lives in -- also where analytics / logs default to. */
  dataDir: DATA_DIR,

  /**
   * Path to the writable host-allowlist file (SHORTENER_HOSTS_FILE). When set,
   * the admin panel can edit the allowlist -- it rewrites this file and the
   * server reloads it. Unset = allowlist is env-only (admin edit disabled).
   */
  hostsFile: envStr("SHORTENER_HOSTS_FILE", ""),

  /**
   * Storage backend: "file" (JSON, default for local) or "sqlite" (node:sqlite,
   * Node 22.5+, for a real server). Empty = infer from the store path
   * (.db/.sqlite/.sqlite3 -> sqlite, else file).
   */
  storeBackend: envStr("SHORTENER_STORE_BACKEND", ""),

  /** Trust X-Forwarded-For for the client IP (set only behind a proxy you control). */
  trustProxy: envStr("SHORTENER_TRUST_PROXY", "") === "1",

  /** Count redirect hits. Cheap, but adds a store write on the read path. */
  countHits: envStr("SHORTENER_COUNT_HITS", "1") !== "0",

  /**
   * Redirect access log. Unset = off (no per-request logging at all). "1" =
   * on, into <store dir>/access-logs. A path = on, into that directory.
   * IPs are truncated to a network prefix before writing (see accesslog.mjs).
   */
  logPath: envStr("SHORTENER_LOG", ""),
  /** Days to keep access-log files. */
  logDays: envInt("SHORTENER_LOG_DAYS", 30),

  /** Random-code length (mode "code"). */
  codeLength: envInt("SHORTENER_CODE_LENGTH", 7),

  /**
   * Admin panel token (SHORTENER_ADMIN_TOKEN). Unset = the whole /admin tree
   * 404s and is not discoverable. Set it to a long random string; visit
   * /admin?token=<it> once to get a cookie, or send `Authorization: Bearer`.
   */
  adminToken: envStr("SHORTENER_ADMIN_TOKEN", ""),

  /** Redirect analytics (daily counts, referrers, rejects). "0" turns it off. */
  analyticsEnabled: envStr("SHORTENER_ANALYTICS", "1") !== "0",
  /** Where the analytics JSON lives. Default: <data dir>/analytics.json */
  analyticsPath: envStr("SHORTENER_ANALYTICS_STORE", path.join(DATA_DIR, "analytics.json")),
  /** Days of per-day analytics buckets to keep. */
  analyticsRetentionDays: envInt("SHORTENER_ANALYTICS_DAYS", 365),
};

/** Re-read SHORTENER_HOSTS_FILE and update the allowlist in place (SIGHUP). */
export function reloadAllowedHosts() {
  config.allowedHosts = computeAllowedHosts();
  return config.allowedHosts;
}

/** A syntactically valid redirect-target host, optionally with :port. */
export function isValidHost(h) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i.test(
    String(h || "").trim(),
  );
}

/**
 * Replace the writable host allowlist (SHORTENER_HOSTS_FILE) with `list` and
 * reload. Throws if no hosts file is configured or a host is malformed.
 * @param {string[]} list
 * @returns {string[]} the new effective allowlist
 */
export function writeAllowedHosts(list) {
  if (!config.hostsFile) {
    throw new Error("no SHORTENER_HOSTS_FILE configured -- allowlist is read-only here");
  }
  const clean = [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((h) => String(h || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const bad = clean.find((h) => !isValidHost(h));
  if (bad) throw new Error(`"${bad}" is not a valid host`);

  const body =
    "# Tab Share shortener -- allowed redirect-target hosts (one per line).\n" +
    "# Managed by the admin panel; edits here are picked up on the next reload.\n" +
    clean.join("\n") +
    (clean.length ? "\n" : "");
  const tmp = `${config.hostsFile}.tmp`;
  mkdirSync(path.dirname(config.hostsFile), { recursive: true });
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, config.hostsFile);
  return reloadAllowedHosts();
}

/** True when `host` (which may include :port) is an allowed redirect target. */
export function hostAllowed(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  const bare = h.replace(/:\d+$/, "");
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]") return true;
  if (config.allowedHosts.length === 0) return true; // "any" mode
  return config.allowedHosts.includes(h) || config.allowedHosts.includes(bare);
}
