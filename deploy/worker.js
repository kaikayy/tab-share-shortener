/*!
 * worker.js -- the shortener as a Cloudflare Worker + KV.
 *
 * Same contract as the Node server (see ../CONTRACT.md). Differences:
 *   - storage is a KV namespace bound as `LINKS` (value = the long URL,
 *     1-year TTL); no hit counter, no rate limiter (use Cloudflare's).
 *   - config comes from Worker vars, not process.env.
 *   - no `/admin` panel and no analytics -- those are Node-server only
 *     (use Cloudflare's own dashboard/analytics for a Worker deployment).
 *
 * Deploy: see ../SELF-HOSTING.md. Wordlists live in ./worker-words.js and are
 * generated from ../src/words.mjs by `npm run gen:worker` -- keep them in sync.
 */

import { ADJECTIVES, NOUNS } from "./worker-words.js";

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LEN = 7;
const MAX_URL_BYTES = 256 * 1024;
const META_REFRESH_OVER = 7000;
const KV_TTL_SECONDS = 60 * 60 * 24 * 365;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  // Chrome Private Network Access (see ../src/server.mjs). Harmless for a
  // public Worker; needed if the Worker is ever run/proxied on a LAN address.
  "access-control-allow-private-network": "true",
};

const rand = (n) => {
  // rejection sampling for an unbiased 0..n-1
  const max = 256 - (256 % n);
  const b = new Uint8Array(1);
  do {
    crypto.getRandomValues(b);
  } while (b[0] >= max);
  return b[0] % n;
};
const pick = (a) => a[rand(a.length)];
const randomCode = (len) => Array.from({ length: len }, () => ALPHABET[rand(ALPHABET.length)]).join("");
const wordSlug = () => `${pick(ADJECTIVES)}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function allowedHosts(env) {
  return String(env.SHORTENER_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(host, env) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  const bare = h.replace(/:\d+$/, "");
  if (bare === "localhost" || bare === "127.0.0.1") return true;
  const list = allowedHosts(env);
  return list.length === 0 || list.includes(h) || list.includes(bare);
}

function normalizeMode(mode) {
  return String(mode || "").toLowerCase() === "words" ? "words" : "code";
}

function validate(raw, env) {
  if (typeof raw !== "string" || raw === "") return { ok: false, status: 400, error: "missing url" };
  if (new TextEncoder().encode(raw).length > MAX_URL_BYTES) return { ok: false, status: 413, error: "url too long" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, status: 400, error: "not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, status: 400, error: "url must be https://" };
  try {
    if (env.SHORTENER_BASE && u.host === new URL(env.SHORTENER_BASE).host)
      return { ok: false, status: 400, error: "refusing to shorten a link on this host" };
  } catch {
    /* base misconfigured */
  }
  if (!hostAllowed(u.host, env)) return { ok: false, status: 403, error: `host "${u.host}" is not on this shortener's allowlist` };
  return { ok: true, url: u.href };
}

async function freeCode(mode, env) {
  if (mode === "words") {
    for (let i = 0; i < 40; i++) {
      const base = wordSlug();
      if (!(await env.LINKS.get(base))) return base;
      for (let j = 0; j < 6; j++) {
        const cand = `${base}-${randomCode(2)}`;
        if (!(await env.LINKS.get(cand))) return cand;
      }
    }
  } else {
    let len = CODE_LEN;
    for (let i = 0; i < 60; i++) {
      const cand = randomCode(len);
      if (!(await env.LINKS.get(cand))) return cand;
      if (i > 0 && i % 12 === 0) len++;
    }
  }
  throw new Error("code space exhausted");
}

async function urlKey(url) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "u:" + hex;
}

async function shorten(inputUrl, mode, env) {
  const check = validate(inputUrl, env);
  if (!check.ok) return check;
  const m = normalizeMode(mode);
  const base = String(env.SHORTENER_BASE || "").replace(/\/+$/, "");

  // Dedup: identical target already shortened -> return the existing code.
  const uk = await urlKey(check.url);
  const existing = await env.LINKS.get(uk);
  if (existing && (await env.LINKS.get(existing))) {
    return { ok: true, code: existing, mode: m, shortUrl: `${base}/${existing}`, reused: true };
  }

  const code = await freeCode(m, env);
  await env.LINKS.put(code, check.url, { expirationTtl: KV_TTL_SECONDS });
  await env.LINKS.put(uk, code, { expirationTtl: KV_TTL_SECONDS });
  return { ok: true, code, mode: m, shortUrl: `${base}/${code}`, reused: false };
}

function redirectResponse(url) {
  const common = { "cache-control": "no-store", "referrer-policy": "no-referrer", ...CORS };
  if (url.length <= META_REFRESH_OVER) {
    return new Response(`Redirecting to ${url}`, { status: 302, headers: { ...common, location: url } });
  }
  const h = esc(url);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">` +
      `<meta http-equiv="refresh" content="0;url=${h}"><title>Redirecting...</title>` +
      `<p>Redirecting... <a href="${h}">continue</a></p><script>location.replace(${JSON.stringify(url)})</script>`,
    { status: 200, headers: { ...common, "content-type": "text/html; charset=utf-8" } },
  );
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
const text = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    // HEAD is routed like GET; the runtime strips the body from the Response.
    const method = req.method === "HEAD" ? "GET" : req.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (method === "GET" && p === "/api/health") {
      return json({ ok: true, allowedHosts: allowedHosts(env).length ? allowedHosts(env) : ["*"], maxUrlBytes: MAX_URL_BYTES });
    }

    if (p === "/api/shorten" && req.method === "POST") {
      let body;
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("application/json")) body = await req.json().catch(() => null);
      else body = Object.fromEntries(new URLSearchParams(await req.text()));
      if (!body) return json({ error: "invalid body" }, 400);
      const r = await shorten(body.url, body.mode, env);
      return r.ok
        ? json({ code: r.code, shortUrl: r.shortUrl, mode: r.mode, reused: r.reused }, r.reused ? 200 : 201)
        : json({ error: r.error }, r.status);
    }

    if (p === "/new" && method === "GET") {
      const r = await shorten(u.searchParams.get("url"), u.searchParams.get("mode"), env);
      return r.ok ? text(r.shortUrl) : text(r.error, r.status);
    }

    if (method === "GET" && p !== "/" && p.length > 1) {
      const code = decodeURIComponent(p.slice(1));
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,79})$/.test(code)) return text("not found", 404);
      const long = await env.LINKS.get(code);
      return long ? redirectResponse(long) : text("unknown or expired link", 404);
    }

    if (method === "GET") return text("tab-share-shortener");
    return text("method not allowed", 405);
  },
};
