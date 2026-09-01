/*!
 * cloudflare-worker.js -- the same service as a Worker + KV.
 *
 * Setup:
 *   wrangler init tab-share-shortener
 *   # wrangler.toml:  [[kv_namespaces]] binding = "LINKS", id = "..."
 *   #                 [vars]  SHORTENER_BASE = "https://s.example.com"
 *   #                         SHORTENER_HOSTS = "you.github.io"
 *   cp deploy/cloudflare-worker.js src/index.js
 *   wrangler deploy
 *
 * Behaviour matches CONTRACT.md. KV values default to a 1-year TTL.
 * Keep the wordlists in sync with ../src/words.mjs if you edit them.
 */

const ADJECTIVES = ["swift", "amber", "calm", "bold", "misty", "lunar", "hardy", "quiet", "brisk", "golden", "hidden", "noble", "rustic", "silver", "sunny", "vivid", "wild", "azure", "cosmic", "gentle"];
const NOUNS = ["otter", "canyon", "harbor", "meadow", "cedar", "falcon", "glacier", "lagoon", "summit", "willow", "beacon", "thicket", "raven", "quartz", "delta", "grove", "heron", "tundra", "vista", "wren"];
// ^ trimmed sample -- paste the full arrays from ../src/words.mjs for production.

const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const rand = (n) => crypto.getRandomValues(new Uint8Array(1))[0] % n;
const pick = (a) => a[rand(a.length)];
const randomCode = (len) => Array.from({ length: len }, () => ALPHABET[rand(ALPHABET.length)]).join("");
const wordSlug = () => `${pick(ADJECTIVES)}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function allowedHosts(env) {
  return (env.SHORTENER_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host, env) {
  const h = host.toLowerCase();
  const bare = h.replace(/:\d+$/, "");
  if (bare === "localhost" || bare === "127.0.0.1") return true;
  const list = allowedHosts(env);
  return list.length === 0 || list.includes(h) || list.includes(bare);
}

function validate(raw, env) {
  if (!raw) return { ok: false, status: 400, error: "missing url" };
  if (raw.length > 256 * 1024) return { ok: false, status: 413, error: "url too long" };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, status: 400, error: "not a valid URL" }; }
  if (u.protocol !== "https:") return { ok: false, status: 400, error: "url must be https://" };
  try { if (u.host === new URL(env.SHORTENER_BASE).host) return { ok: false, status: 400, error: "refusing self" }; } catch {}
  if (!hostAllowed(u.host, env)) return { ok: false, status: 403, error: `host "${u.host}" not allowed` };
  return { ok: true, url: u.href };
}

async function freeCode(mode, env) {
  const make = mode === "words" ? wordSlug : () => randomCode(7);
  for (let i = 0; i < 40; i++) {
    let c = make();
    if (mode === "words" && (await env.LINKS.get(c))) c = `${c}-${randomCode(2)}`;
    if (!(await env.LINKS.get(c))) return c;
  }
  throw new Error("code space exhausted");
}

async function shorten(inputUrl, mode, env) {
  const check = validate(inputUrl, env);
  if (!check.ok) return check;
  const code = await freeCode(mode === "words" ? "words" : "code", env);
  await env.LINKS.put(code, check.url, { expirationTtl: 60 * 60 * 24 * 365 });
  return { ok: true, code, shortUrl: `${env.SHORTENER_BASE.replace(/\/+$/, "")}/${code}`, mode: mode === "words" ? "words" : "code" };
}

function redirect(url) {
  const common = { "cache-control": "no-store", "referrer-policy": "no-referrer", ...CORS };
  if (url.length <= 7000) return new Response(`Redirecting to ${url}`, { status: 302, headers: { ...common, location: url } });
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(url)}">` +
      `<title>Redirecting...</title><a href="${esc(url)}">continue</a><script>location.replace(${JSON.stringify(url)})</script>`,
    { status: 200, headers: { ...common, "content-type": "text/html; charset=utf-8" } },
  );
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (u.pathname === "/api/health") {
      return Response.json({ ok: true, allowedHosts: allowedHosts(env) }, { headers: CORS });
    }

    if (u.pathname === "/api/shorten" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return Response.json({ error: "invalid JSON" }, { status: 400, headers: CORS });
      const r = await shorten(body.url, body.mode, env);
      return r.ok
        ? Response.json({ code: r.code, shortUrl: r.shortUrl, mode: r.mode }, { status: 201, headers: CORS })
        : Response.json({ error: r.error }, { status: r.status, headers: CORS });
    }

    if (u.pathname === "/new" && req.method === "GET") {
      const r = await shorten(u.searchParams.get("url"), u.searchParams.get("mode"), env);
      return r.ok
        ? new Response(r.shortUrl, { status: 200, headers: { "content-type": "text/plain", ...CORS } })
        : new Response(r.error, { status: r.status, headers: CORS });
    }

    if (req.method === "GET" && u.pathname.length > 1) {
      const code = decodeURIComponent(u.pathname.slice(1));
      const long = await env.LINKS.get(code);
      return long ? redirect(long) : new Response("unknown or expired link", { status: 404, headers: CORS });
    }

    return new Response("tab-share-shortener", { status: 200, headers: CORS });
  },
};
