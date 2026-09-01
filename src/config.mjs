/*!
 * config.mjs — every knob, read once from the environment.
 *
 * Nothing here is secret. Override any value with an env var of the same name,
 * e.g.  SHORTENER_BASE=https://s.example.com  SHORTENER_HOSTS=me.github.io node src/server.mjs
 */

import path from "node:path";
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

const PORT = envInt("SHORTENER_PORT", 8779);

export const config = {
  root,

  /** Port the HTTP server binds to. */
  port: PORT,
  /** Interface to bind. 127.0.0.1 for local, 0.0.0.0 behind a proxy. */
  host: envStr("SHORTENER_HOST", "127.0.0.1"),

  /**
   * Public origin the short links are built from — no trailing slash.
   * This is what goes in front of the code: `${base}/${code}`.
   */
  base: envStr("SHORTENER_BASE", `http://localhost:${PORT}`).replace(/\/+$/, ""),

  /**
   * Hosts a submitted link is allowed to point at (the Tab Share viewer
   * host, usually). Exact host[:port] match, case-insensitive. `localhost`
   * and `127.0.0.1` on any port are always allowed so local testing works.
   * An empty list means "allow any https host" — only do that behind auth.
   */
  allowedHosts: envList("SHORTENER_HOSTS", ["kaikayy.github.io"]),

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

  /** Path to the JSON link store. */
  storePath: envStr("SHORTENER_STORE", path.join(root, "data", "links.json")),

  /** Trust X-Forwarded-For for the client IP (set only behind a proxy you control). */
  trustProxy: envStr("SHORTENER_TRUST_PROXY", "") === "1",

  /** Count redirect hits. Cheap, but adds a store write on the read path. */
  countHits: envStr("SHORTENER_COUNT_HITS", "1") !== "0",

  /** Random-code length (mode "code"). */
  codeLength: envInt("SHORTENER_CODE_LENGTH", 7),
};

/** True when `host` (which may include :port) is an allowed redirect target. */
export function hostAllowed(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  const bare = h.replace(/:\d+$/, "");
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]") return true;
  if (config.allowedHosts.length === 0) return true; // "any" mode
  return config.allowedHosts.includes(h) || config.allowedHosts.includes(bare);
}
