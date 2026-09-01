/*!
 * server.mjs -- the whole HTTP service.
 *
 *   POST /api/shorten     { url, mode?: "code"|"words", ttlDays?: number }
 *                         -> { code, shortUrl, mode, expires }
 *   GET  /new?url=<enc>&mode=words
 *                         -> text/plain short URL   (drop-in for the Tab Share
 *                            extension's existing "custom endpoint" contract)
 *   GET  /:code           -> 302 (or an HTML meta-refresh for very long targets)
 *   GET  /api/health      -> { ok: true, ... }
 *
 * No dependencies. `node src/server.mjs` (see src/config.mjs for env knobs).
 */

import http from "node:http";
import { Buffer } from "node:buffer";
import { config } from "./config.mjs";
import { openStore } from "./store.mjs";
import { RateLimiter } from "./ratelimit.mjs";
import { validateTarget } from "./validate.mjs";
import { generate, normalizeMode, looksLikeCode } from "./codes.mjs";
import { KEYSPACE_BITS } from "./words.mjs";

const store = openStore();
const limiter = new RateLimiter(config.ratePerMinute);
setInterval(() => limiter.sweep(), 60_000).unref?.();

/* ------------------------------ helpers ------------------------------ */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  // Chrome Private Network Access: a page on a public origin (or an extension,
  // in newer Chrome) fetching a private address (localhost / LAN) sends a
  // preflight with `Access-Control-Request-Private-Network: true` and needs
  // this header back or the request is blocked before it reaches us.
  "access-control-allow-private-network": "true",
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...CORS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(obj));
}

function sendText(res, status, text) {
  send(res, status, { "content-type": "text/plain; charset=utf-8" }, text);
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        // Stop buffering, but drain the rest of the upload (req.resume) so the
        // socket stays healthy long enough for the caller to send a clean 413
        // instead of the client seeing an ECONNRESET.
        req.resume();
        reject(Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function parseBody(raw, contentType) {
  const ct = String(contentType || "");
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return null;
    }
  }
  // form-encoded fallback
  const params = new URLSearchParams(raw || "");
  return Object.fromEntries(params);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Redirect to `url`, falling back to an HTML meta-refresh when the header
 *  would be uncomfortably long for upstream proxies. */
function redirect(res, url) {
  const common = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (url.length <= config.metaRefreshOver) {
    send(res, 302, { ...common, location: url }, `Redirecting to ${url}`);
    return;
  }
  const h = esc(url);
  const j = JSON.stringify(url);
  send(
    res,
    200,
    { ...common, "content-type": "text/html; charset=utf-8" },
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">` +
      `<meta http-equiv="refresh" content="0;url=${h}"><title>Redirecting...</title>` +
      `<p>Redirecting... <a href="${h}">continue</a></p><script>location.replace(${j})</script>`,
  );
}

/* ------------------------------ handlers ------------------------------ */

async function handleShorten(req, res, urlObj) {
  if (!limiter.allow(clientIp(req))) {
    return sendJson(res, 429, { error: "rate limited -- try again in a minute" });
  }

  let inputUrl;
  let mode = "code";
  let ttlDays;

  if (req.method === "POST") {
    let raw;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
    const body = parseBody(raw, req.headers["content-type"]);
    if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
    inputUrl = body.url;
    mode = normalizeMode(body.mode);
    if (body.ttlDays != null && body.ttlDays !== "") ttlDays = Number(body.ttlDays) || 0;
  } else {
    // GET /new?url=...&mode=...
    inputUrl = urlObj.searchParams.get("url");
    mode = normalizeMode(urlObj.searchParams.get("mode"));
  }

  const check = validateTarget(inputUrl);
  if (!check.ok) {
    const payload = { error: check.error };
    return req.method === "POST"
      ? sendJson(res, check.status, payload)
      : sendText(res, check.status, check.error);
  }

  // Dedup: an identical target that already has a live code gets that code back
  // (idempotent -- avoids minting a fresh code every time the same link is
  // shortened). Requesting a different style does not re-mint; the stored code
  // and its style are returned as-is.
  let code;
  let entry;
  let reused = false;
  const hit = store.findByUrl(check.url);
  if (hit) {
    ({ code, entry } = hit);
    reused = true;
  } else {
    try {
      code = generate(mode, (c) => store.has(c));
    } catch (e) {
      return sendJson(res, 503, { error: e.message });
    }
    entry = store.put(code, { url: check.url, mode, ttlDays });
  }

  const shortUrl = `${config.base}/${code}`;

  if (req.method === "POST") {
    return sendJson(res, reused ? 200 : 201, {
      code,
      shortUrl,
      mode: entry.mode,
      expires: entry.expires || null,
      reused,
    });
  }
  // Compat contract: bare short URL as text/plain.
  return sendText(res, 200, shortUrl);
}

function handleRedirect(res, code) {
  const entry = store.get(code);
  if (!entry) return sendText(res, 404, "unknown or expired link");
  if (config.countHits) store.bumpHits(code);
  redirect(res, entry.url);
}

const INFO_PAGE =
  `<!doctype html><meta charset="utf-8"><title>Tab Share shortener</title>` +
  `<style>body{font:14px/1.6 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}code{background:#8881;padding:.1em .3em;border-radius:3px}</style>` +
  `<h1>Tab Share link shortener</h1>` +
  `<p>Shorten a Tab Share link:</p>` +
  `<pre><code>curl -X POST ${esc(config.base)}/api/shorten \\\n  -H 'content-type: application/json' \\\n  -d '{"url":"https://.../#token","mode":"words"}'</code></pre>` +
  `<p>Modes: <code>code</code> (random) or <code>words</code> (readable). ` +
  `Source: <a href="https://github.com/kaikayy/multi-link-share">AGPL-3.0</a>.</p>`;

/* ------------------------------ router ------------------------------ */

const server = http.createServer(
  { maxHeaderSize: Math.max(64 * 1024, config.maxBodyBytes + 16 * 1024) },
  async (req, res) => {
    let urlObj;
    try {
      urlObj = new URL(req.url, config.base);
    } catch {
      return sendText(res, 400, "bad request");
    }
    const pathname = urlObj.pathname;

    try {
      if (req.method === "OPTIONS") return send(res, 204, {}, "");

      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          store: store.stats(),
          allowedHosts: config.allowedHosts.length ? config.allowedHosts : ["*"],
          maxUrlBytes: config.maxUrlBytes,
          wordsKeyspaceBits: Math.round(KEYSPACE_BITS),
        });
      }

      if (pathname === "/api/shorten" && (req.method === "POST" || req.method === "GET")) {
        return await handleShorten(req, res, urlObj);
      }

      if (req.method === "GET" && pathname === "/new") {
        return await handleShorten(req, res, urlObj);
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "")) {
        return send(res, 200, { "content-type": "text/html; charset=utf-8" }, INFO_PAGE);
      }

      if (req.method === "GET" && pathname === "/favicon.ico") {
        return send(res, 204, {}, "");
      }

      if (req.method === "GET") {
        const code = decodeURIComponent(pathname.slice(1));
        if (looksLikeCode(code)) return handleRedirect(res, code);
        return sendText(res, 404, "not found");
      }

      return sendText(res, 405, "method not allowed");
    } catch (err) {
      console.error("unhandled:", err);
      return sendJson(res, 500, { error: "internal error" });
    }
  },
);

// A GET /new URL longer than maxHeaderSize trips the HTTP parser before the
// request handler runs. Answer with a clear 431 pointing at POST instead of
// letting the client see a bare connection drop.
server.on("clientError", (err, socket) => {
  if (!socket.writable) return socket.destroy();
  const tooBig = err && err.code === "HPE_HEADER_OVERFLOW";
  const status = tooBig ? "431 Request Header Fields Too Large" : "400 Bad Request";
  const body = tooBig
    ? "The request URL is too long for GET /new -- use POST /api/shorten for very large links."
    : "Bad request.";
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
});

function shutdown() {
  try {
    store.flushSync();
    store.close();
  } catch (e) {
    console.error("store close on exit failed:", e);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(config.port, config.host, () => {
  console.log(`tab-share-shortener on http://${config.host}:${config.port}  (public base: ${config.base})`);
  console.log(
    `allowed target hosts: ${config.allowedHosts.length ? config.allowedHosts.join(", ") : "ANY (open mode)"}`,
  );
});

export { server, store };
