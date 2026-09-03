/*!
 * admin.mjs -- the /admin panel: link table, revoke, manual links, the host
 * allowlist editor, and redirect analytics.
 *
 * Auth: a single token in SHORTENER_ADMIN_TOKEN. With it unset the whole
 * /admin tree 404s and is not discoverable. With it set:
 *   - visit  /admin?token=<TOKEN>  once  -> sets an HttpOnly cookie
 *   - or send  Authorization: Bearer <TOKEN>  (for curl / scripts)
 * The token is compared in constant time (sha256 + timingSafeEqual).
 *
 * Everything here is server-only -- the Cloudflare Worker build has no admin.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { config, writeAllowedHosts } from "./config.mjs";
import { validateTarget } from "./validate.mjs";
import { generate, normalizeMode, looksLikeCode } from "./codes.mjs";
import * as analytics from "./analytics.mjs";
import { domainHistogram } from "./collections.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version || "?";
  } catch {
    return "?";
  }
})();
const BOOT = Date.now();
const COOKIE = "tss_admin";
const MAX_BODY = 512 * 1024;

/* ------------------------------ auth ------------------------------ */

function tokenOk(given) {
  if (!config.adminToken || !given) return false;
  const a = createHash("sha256").update(String(given)).digest();
  const b = createHash("sha256").update(config.adminToken).digest();
  return timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

function presentedToken(req, urlObj, method) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (m) return m[1].trim();
  // An explicit ?token= login link wins over any existing cookie, so a stale or
  // wrong cookie can't lock you out -- the fresh link always re-authenticates.
  if (method === "GET" && urlObj.searchParams.has("token")) return urlObj.searchParams.get("token");
  const c = readCookie(req, COOKIE);
  if (c) return c;
  return "";
}

function sessionCookie(clear = false) {
  const secure = config.base.startsWith("https:") ? "; Secure" : "";
  return clear
    ? `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict${secure}; Max-Age=0`
    : `${COOKIE}=${encodeURIComponent(config.adminToken)}; Path=/admin; HttpOnly; SameSite=Strict${secure}; Max-Age=2592000`;
}

/* ------------------------------ responses ------------------------------ */

const NOSTORE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...NOSTORE });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...NOSTORE });
  res.end(body);
}
function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.resume();
        reject(Object.assign(new Error("body too large"), { status: 413 }));
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/* ------------------------------ ops snapshot ------------------------------ */

function storeSize() {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(config.storePath + suffix).size;
    } catch {
      /* not present */
    }
  }
  return total;
}

function lastBackup() {
  const dir = process.env.TSS_BACKUP_DIR;
  if (!dir) return null;
  try {
    let newest = 0;
    for (const name of readdirSync(dir)) {
      const t = statSync(path.join(dir, name)).mtimeMs;
      if (t > newest) newest = t;
    }
    return newest || null;
  } catch {
    return null;
  }
}

function ops(store) {
  const s = store.stats();
  return {
    version: PKG_VERSION,
    backend: s.backend,
    base: config.base,
    links: { total: s.total, revoked: s.revoked || 0, expiring: s.expiring || 0 },
    defaultTtlDays: config.ttlDays,
    storeBytes: storeSize(),
    uptimeSec: Math.round((Date.now() - BOOT) / 1000),
    analyticsEnabled: config.analyticsEnabled,
    hostsEditable: !!config.hostsFile,
    lastBackup: lastBackup(),
    countHits: config.countHits,
  };
}

/* ------------------------------ router ------------------------------ */

/**
 * @returns {Promise<boolean>} true if the request was for /admin (handled here)
 */
export async function handleAdmin(req, res, urlObj, { store }) {
  const p = urlObj.pathname;
  if (p !== "/admin" && !p.startsWith("/admin/")) return false;

  const method = req.method === "HEAD" ? "GET" : req.method;

  if (!tokenOk(presentedToken(req, urlObj, method))) {
    notFound(res); // not authed == not here
    return true;
  }

  // fresh login: drop the token from the URL, set a cookie
  if (method === "GET" && p === "/admin" && urlObj.searchParams.has("token")) {
    res.writeHead(302, { location: "/admin", "set-cookie": sessionCookie(), ...NOSTORE });
    res.end("ok");
    return true;
  }

  try {
    if (method === "GET" && p === "/admin") return sendHtml(res, 200, PAGE), true;

    if (p === "/admin/logout") {
      res.writeHead(302, { location: "/", "set-cookie": sessionCookie(true), ...NOSTORE });
      res.end("bye");
      return true;
    }

    if (method === "GET" && p === "/admin/api/overview") {
      const range = clampRange(urlObj.searchParams.get("range"));
      return (
        sendJson(res, 200, {
          ops: ops(store),
          summary: analytics.summary(range),
          rejects: analytics.rejectReasons(range),
        }),
        true
      );
    }

    if (method === "GET" && p === "/admin/api/links") {
      const q = (urlObj.searchParams.get("q") || "").toLowerCase();
      const limit = Math.min(Number(urlObj.searchParams.get("limit")) || 500, 5000);
      // The list never carries destination URLs -- only the target host. Seeing
      // the full URL (i.e. the pages someone bundled) is a deliberate per-link
      // reveal: GET /admin/api/links/<code>/url
      let rows = store.list().map(({ url, keep, ...rest }) => {
        let host = "?";
        try {
          host = new URL(url).host;
        } catch {
          /* keep "?" */
        }
        return { ...rest, host }; // no `url`, no per-link `keep` token
      });
      if (q) rows = rows.filter((r) => r.code.toLowerCase().includes(q) || r.host.toLowerCase().includes(q));
      return sendJson(res, 200, { total: rows.length, links: rows.slice(0, limit) }), true;
    }

    if (method === "POST" && p === "/admin/api/links") {
      const body = await readBody(req);
      return createLink(res, store, body), true;
    }

    const linkOp = /^\/admin\/api\/links\/([^/]+)(?:\/(revoke|unrevoke|stats|url|keep|expire))?$/.exec(p);
    if (linkOp) {
      const code = decodeURIComponent(linkOp[1]);
      const action = linkOp[2];
      if (method === "GET" && action === "stats") {
        const range = clampRange(urlObj.searchParams.get("range"));
        return sendJson(res, 200, { code, series: analytics.seriesForCode(code, range) }), true;
      }
      if (method === "GET" && action === "url") {
        // deliberate single-link reveal of the stored destination
        const hit = store.list().find((r) => r.code === code);
        if (!hit) return sendJson(res, 404, { error: "no such code" }), true;
        return sendJson(res, 200, { code, url: hit.url }), true;
      }
      if (method === "POST" && action === "revoke") {
        return sendJson(res, 200, { ok: store.revoke(code) }), true;
      }
      if (method === "POST" && action === "unrevoke") {
        return sendJson(res, 200, { ok: store.unrevoke(code) }), true;
      }
      if (method === "POST" && action === "keep") {
        // operator override -- pin, no keep token needed
        return sendJson(res, 200, { ok: store.setExpiry(code, 0) }), true;
      }
      if (method === "POST" && action === "expire") {
        const body = await readBody(req);
        const d = Number(body.days);
        const expires = Number.isFinite(d) && d > 0 ? Date.now() + d * 86400_000 : Date.now() - 1;
        const ok = store.setExpiry(code, expires);
        return sendJson(res, 200, { ok, expires: expires > Date.now() ? expires : null }), true;
      }
      if (method === "DELETE" && !action) {
        return sendJson(res, 200, { ok: store.delete(code) }), true;
      }
    }

    if (method === "GET" && p === "/admin/api/hosts") {
      return sendJson(res, 200, { hosts: config.allowedHosts, editable: !!config.hostsFile }), true;
    }
    if (method === "PUT" && p === "/admin/api/hosts") {
      const body = await readBody(req);
      try {
        const hosts = writeAllowedHosts(body.hosts || []);
        return sendJson(res, 200, { hosts, editable: true }), true;
      } catch (e) {
        return sendJson(res, 400, { error: e.message }), true;
      }
    }

    if (method === "GET" && p === "/admin/api/stats") {
      const range = clampRange(urlObj.searchParams.get("range"));
      return (
        sendJson(res, 200, {
          summary: analytics.summary(range),
          topLinks: analytics.topLinks(range, 25),
          referrers: analytics.referrers(range, 25),
          browsers: analytics.browsers(range, 25),
          rejects: analytics.rejectReasons(range),
          recent: analytics.recentEvents(120),
        }),
        true
      );
    }

    // On-demand only: decode every stored link's collection and tally the
    // registrable domain of each page. Computed now, kept nowhere.
    if (method === "GET" && p === "/admin/api/domains") {
      return sendJson(res, 200, domainHistogram(store)), true;
    }

    if (method === "GET" && p === "/admin/api/export") {
      const body = JSON.stringify({ exported: Date.now(), version: PKG_VERSION, links: store.list() }, null, 2);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="tab-share-links-${analytics.dayKey()}.json"`,
        ...NOSTORE,
      });
      res.end(body);
      return true;
    }

    if (method === "POST" && p === "/admin/api/purge") {
      const body = await readBody(req);
      const days = Math.max(1, Number(body.days) || 0);
      if (!days) return sendJson(res, 400, { error: "days must be >= 1" }), true;
      const zeroOnly = body.zeroHitsOnly !== false;
      const cutoff = Date.now() - days * 86400_000;
      let deleted = 0;
      for (const row of store.list()) {
        if (row.created >= cutoff) continue;
        if (zeroOnly && row.hits > 0) continue;
        if (store.delete(row.code)) deleted++;
      }
      return sendJson(res, 200, { deleted }), true;
    }

    notFound(res);
    return true;
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || "admin error" });
    return true;
  }
}

function clampRange(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(Math.round(n), 365));
}

function createLink(res, store, body) {
  const check = validateTarget(body && body.url);
  if (!check.ok) return sendJson(res, check.status, { error: check.error });

  const mode = normalizeMode(body.mode);
  let ttlDays;
  if (body.ttlDays != null && body.ttlDays !== "") ttlDays = Number(body.ttlDays) || 0;

  let code = (body.slug || "").trim();
  if (code) {
    if (!looksLikeCode(code)) return sendJson(res, 400, { error: "slug: letters, digits and dashes only" });
    if (store.has(code)) return sendJson(res, 409, { error: `slug "${code}" is already taken` });
  } else {
    const dup = store.findByUrl(check.url);
    if (dup) {
      return sendJson(res, 200, {
        code: dup.code,
        shortUrl: `${config.base}/${dup.code}`,
        reused: true,
      });
    }
    try {
      code = generate(mode, (c) => store.has(c));
    } catch (e) {
      return sendJson(res, 503, { error: e.message });
    }
  }

  const entry = store.put(code, { url: check.url, mode, ttlDays });
  analytics.recordCreate(code, entry.mode);
  return sendJson(res, 201, { code, shortUrl: `${config.base}/${code}`, mode: entry.mode, expires: entry.expires || null });
}

/* ------------------------------ the page ------------------------------ */

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Tab Share shortener -- admin</title>
<style>
:root{
  --ground:#f6f4f8;--surface:#fff;--surface-2:#faf8fb;
  --ink:#221d29;--muted:#6d6478;--faint:#9a90a4;
  --line:#e7e1ec;--line-strong:#d8d0e0;
  --brand:#bb2497;--brand-soft:#f4e2ef;
  --amber:#d9832f;--amber-soft:#f7e9db;
  --good:#3a8f63;--warn:#b9791f;--bad:#cf4257;
  --shadow:0 1px 2px rgba(34,29,41,.04),0 8px 24px -12px rgba(34,29,41,.1);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
}
@media(prefers-color-scheme:dark){:root{
  --ground:#151219;--surface:#1e1a24;--surface-2:#241f2b;
  --ink:#ece7f1;--muted:#9c92a7;--faint:#6f6579;
  --line:#332c3c;--line-strong:#443b4f;
  --brand:#e97ad0;--brand-soft:#3a1f37;
  --amber:#e7a45f;--amber-soft:#3a2c1c;
  --good:#5cbd8a;--warn:#d79a3f;--bad:#e5687c;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -14px rgba(0,0,0,.55);
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.55 var(--sans)}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3{margin:0}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}

header{border-bottom:1px solid var(--line);background:var(--surface);position:sticky;top:0;z-index:20}
.bar{max-width:1120px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mark{display:flex;align-items:center;gap:9px}
.mark .dot{width:9px;height:9px;border-radius:50%;background:var(--brand);box-shadow:0 0 0 4px var(--brand-soft)}
.mark b{font:600 15px/1 var(--mono);letter-spacing:-.01em}
.mark span{font:400 12px/1 var(--mono);color:var(--faint)}
.bar .spacer{flex:1}
.pill{font:500 12px/1 var(--sans);color:var(--muted);border:1px solid var(--line-strong);border-radius:999px;padding:6px 11px;display:inline-flex;gap:7px;align-items:center;background:var(--surface-2)}
.pill .live{width:6px;height:6px;border-radius:50%;background:var(--good)}
.pill .live.off{background:var(--bad)}
select.range{font:500 12px/1 var(--sans);color:var(--ink);background:var(--surface);border:1px solid var(--line-strong);border-radius:8px;padding:5px 8px}

nav{border-bottom:1px solid var(--line);background:var(--surface);overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav .inner{max-width:1120px;margin:0 auto;padding:0 12px;display:flex;gap:2px}
nav button{appearance:none;background:none;border:0;cursor:pointer;font:500 13.5px/1 var(--sans);color:var(--muted);padding:13px 14px;border-bottom:2px solid transparent;white-space:nowrap;display:inline-flex;gap:7px;align-items:center;text-transform:capitalize}
nav button .c{font:500 11px/1 var(--mono);color:var(--faint);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:2px 5px}
nav button:hover{color:var(--ink)}
nav button.on{color:var(--ink);border-bottom-color:var(--brand)}
nav button.on .c{color:var(--brand);border-color:var(--brand-soft);background:var(--brand-soft)}

.wrap{max-width:1120px;margin:0 auto;padding:22px 20px 72px}
.vhead{font:600 12px/1 var(--sans);text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin-bottom:14px}
.grid{display:grid;gap:16px}
.stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.two{grid-template-columns:1.5fr 1fr;align-items:start}
@media(max-width:840px){.two{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
.panel.pad{padding:18px}
.panel+.panel,.grid+.panel,.panel+.grid{margin-top:16px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 16px;box-shadow:var(--shadow)}
.stat .n{font:500 30px/1 var(--mono);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat .k{margin-top:7px;font:600 10.5px/1 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.stat.rev .n{color:var(--muted)}
.cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.cardhead h3{font:600 14px/1 var(--sans)}
.cardhead .sub{font:400 12px/1 var(--mono);color:var(--faint)}

.chart{width:100%;height:auto;display:block;overflow:visible}
.chart text{font:400 10px/1 var(--mono);fill:var(--faint)}
.chart .gridline{stroke:var(--line);stroke-dasharray:2 3}
.chart .base{stroke:var(--line-strong)}
.chart rect.h{fill:var(--brand)} .chart rect.c{fill:var(--amber)}
.chart rect.dim{opacity:.42}
.chart circle.cap{fill:var(--brand);stroke:var(--surface);stroke-width:2}
.legend{display:flex;gap:16px;margin-top:12px;font:500 11.5px/1 var(--sans);color:var(--muted)}
.legend i{width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:-1px}
.legend i.h{background:var(--brand)} .legend i.c{background:var(--amber)}

.bars{display:flex;flex-direction:column;gap:12px}
.bars .brow{display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center}
.bars .lab{font:400 12.5px/1.3 var(--sans);color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bars .lab code{font-family:var(--mono);font-size:12px;color:var(--brand)}
.bars .lab .sub{color:var(--faint);font-size:11px}
.bars .val{justify-self:end;font:500 12px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--muted)}
.bars .track{grid-column:1/-1;height:7px;border-radius:4px;background:var(--surface-2);overflow:hidden}
.bars .fill{height:100%;border-radius:4px;background:var(--brand)}
.bars .fill.bad{background:var(--bad)}
.empty{font:400 12.5px/1 var(--sans);color:var(--faint);padding:4px 0}

.kv{display:grid;grid-template-columns:auto 1fr}
.kv dt{padding:9px 0;font:400 12.5px/1.3 var(--sans);color:var(--muted);border-bottom:1px solid var(--line)}
.kv dd{margin:0;padding:9px 0;font:500 12.5px/1.3 var(--mono);color:var(--ink);border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
.kv dt:last-of-type,.kv dd:last-of-type{border-bottom:0}
.kv .ok{color:var(--good)} .kv .warn{color:var(--warn)}

.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{font:600 10.5px/1 var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--surface-2)}
thead th.sortable{cursor:pointer;user-select:none}
thead th.sortable:hover{color:var(--ink)}
thead th.r,tbody td.r{text-align:right}
tbody td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--surface-2)}
td .slug{font:500 12.5px/1 var(--mono);color:var(--brand);white-space:nowrap}
td.target{max-width:360px}
td.target .t{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;overflow:hidden}
td.target .u{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
td .num{font:500 13px/1 var(--mono);font-variant-numeric:tabular-nums}
td .ago{color:var(--muted);font-size:12px}
td .rage{font:400 11px/1 var(--sans);color:var(--faint);margin-left:4px;white-space:nowrap}
tr.rv td{opacity:.55}
tr.rv td .slug{color:var(--muted);text-decoration:line-through}

.chip{font:600 10px/1 var(--sans);text-transform:uppercase;letter-spacing:.05em;padding:4px 7px;border-radius:6px;display:inline-flex;gap:5px;align-items:center;border:1px solid transparent;white-space:nowrap}
.chip .d{width:5px;height:5px;border-radius:50%;background:currentColor}
.chip.code{color:var(--muted);background:var(--surface-2);border-color:var(--line)}
.chip.words{color:var(--amber);background:var(--amber-soft)}
.chip.live{color:var(--good);background:color-mix(in srgb,var(--good) 14%,transparent)}
.chip.rev{color:var(--bad);background:color-mix(in srgb,var(--bad) 13%,transparent)}
.chip.exp{color:var(--warn);background:var(--amber-soft)}

.rowact{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
button.act,a.act{appearance:none;cursor:pointer;font:500 12px/1 var(--sans);border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);padding:6px 10px;border-radius:8px;text-decoration:none;display:inline-block}
button.act:hover,a.act:hover{border-color:var(--brand);color:var(--brand)}
button.act.d:hover{border-color:var(--bad);color:var(--bad)}
button.act.primary{background:var(--brand);border-color:var(--brand);color:#fff}
button.act.primary:hover{filter:brightness(1.06);color:#fff}
button.act.xs,a.act.xs{padding:3px 7px;font-size:11px}

.toolbar{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.toolbar input,.toolbar select,textarea{font:400 13px/1.3 var(--sans);color:var(--ink);background:var(--surface);border:1px solid var(--line-strong);border-radius:9px;padding:9px 11px}
.toolbar input.grow{flex:1;min-width:200px;font-family:var(--mono);font-size:12.5px}
.toolbar input.slug{width:130px;font-family:var(--mono);font-size:12.5px}
.toolbar input.ttl{width:92px}
.toolbar .push{margin-left:auto;display:flex;gap:9px;flex-wrap:wrap}
textarea{width:100%;font-family:var(--mono);font-size:12.5px;line-height:1.7;resize:vertical}
.hint{font:400 12px/1.5 var(--sans);color:var(--muted);margin:10px 0 0}
.hint code{font-family:var(--mono);font-size:11.5px}
.msg{padding:9px 12px;border-radius:9px;margin-top:10px;font:500 12.5px/1.4 var(--sans)}
.msg.ok{color:var(--good);background:color-mix(in srgb,var(--good) 13%,transparent)}
.msg.err{color:var(--bad);background:color-mix(in srgb,var(--bad) 13%,transparent)}
.note{font:500 12px/1 var(--sans);color:var(--muted)}

.feed td .ev{display:flex;align-items:center;gap:8px;text-transform:capitalize}
.feed .k{width:6px;height:6px;border-radius:50%;flex:none}
.feed .k.hit{background:var(--brand)} .feed .k.create{background:var(--amber)} .feed .k.reject{background:var(--bad)}
.feed td .detail code{font-family:var(--mono);font-size:12px;color:var(--ink)}
.feed td .detail .from{color:var(--muted)}

footer{max-width:1120px;margin:34px auto 0;padding:0 20px;font:400 12px/1.6 var(--mono);color:var(--faint)}
footer .sep{display:inline-block;width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.5;vertical-align:middle;margin:0 8px}
</style></head><body>
<header><div class="bar">
  <div class="mark"><span class="dot"></span><b id="host">shortener</b><span>/admin</span></div>
  <div class="spacer"></div>
  <span class="pill"><span class="live" id="live"></span><span id="health">checking</span></span>
  <label class="pill">range
    <select class="range" id="range"><option>7</option><option selected>30</option><option>90</option><option>365</option></select>
  </label>
  <a href="/admin/logout" class="pill">log out</a>
</div></header>
<nav><div class="inner" id="tabs" role="tablist"></div></nav>
<div class="wrap"><div id="view"></div></div>
<footer>Tab Share link shortener<span class="sep"></span>AGPL-3.0<span class="sep"></span><a href="https://github.com/kaikayy/tab-share-shortener" target="_blank" rel="noopener">source</a></footer>
<script>
const $=s=>document.querySelector(s), api=(u,o)=>fetch('/admin/api/'+u,o).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j});
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtN=n=>Number(n).toLocaleString('en-US');
const ago=t=>{if(!t)return 'never';const s=(Date.now()-t)/1e3;if(s<45)return 'just now';for(const[u,d]of[['d',86400],['h',3600],['m',60]])if(s>=d)return Math.floor(s/d)+u+' ago';return 'just now'};
const until=t=>{if(!t)return 'never';const s=(t-Date.now())/1e3;if(s<=0)return 'expired';for(const[u,d]of[['d',86400],['h',3600],['m',60]])if(s>=d)return 'in '+Math.floor(s/d)+u;return 'soon'};
const kib=b=>b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(2)+' MB';
const hostOf=u=>{try{return new URL(u).host}catch{return '?'}};
let range=30, tab='overview';

const TABS=['overview','links','traffic','hosts','activity'];
$('#tabs').innerHTML=TABS.map(t=>'<button data-t="'+t+'">'+t+'<span class="c" data-c="'+t+'" hidden></span></button>').join('');
$('#tabs').onclick=e=>{const b=e.target.closest('button');if(b&&b.dataset.t){tab=b.dataset.t;render()}};
$('#range').onchange=e=>{range=+e.target.value;render()};
function badge(t,n){const el=$('[data-c="'+t+'"]');if(!el)return;if(n==null){el.hidden=true;return}el.textContent=n;el.hidden=false}
function health(o){
  $('#host').textContent=(o.base||'').replace(/^https?:\\/\\//,'')||'shortener';
  $('#health').textContent='healthy \\u00b7 v'+o.version+' \\u00b7 '+o.backend;
  $('#live').classList.remove('off');
  badge('links',fmtN(o.links.total));
}

function vhead(t){return '<div class="vhead">'+t+'</div>'}
function panel(inner,cls){return '<div class="panel pad'+(cls?' '+cls:'')+'">'+inner+'</div>'}
function cardhead(h,sub){return '<div class="cardhead"><h3>'+h+'</h3>'+(sub?'<span class="sub">'+sub+'</span>':'')+'</div>'}
function chip(kind,txt){return '<span class="chip '+kind+'"><span class="d"></span>'+txt+'</span>'}

function chart(data){
  if(!data||!data.length) return '<p class="empty">no data yet</p>';
  const W=680,H=210,padL=32,padR=8,padT=12,padB=22, iw=W-padL-padR, ih=H-padT-padB;
  const max=Math.max(1,...data.map(d=>d.hits+d.creates)), nice=Math.max(4,Math.ceil(max/20)*20);
  const bw=iw/data.length, x=i=>padL+i*bw, y=v=>padT+ih-(v/nice)*ih;
  let g='';
  for(let t=0;t<=4;t++){const gv=Math.round(nice*t/4),gy=y(gv);
    g+='<line class="gridline" x1="'+padL+'" y1="'+gy.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+gy.toFixed(1)+'"/>';
    g+='<text x="'+(padL-6)+'" y="'+(gy+3).toFixed(1)+'" text-anchor="end">'+gv+'</text>';}
  let bars='';
  data.forEach((d,i)=>{const last=i===data.length-1, w=Math.max(bw-2.4,1), bx=x(i)+1.2;
    const hh=(d.hits/nice)*ih, ch=(d.creates/nice)*ih, top=padT+ih-hh;
    bars+='<rect class="h'+(last?'':' dim')+'" x="'+bx.toFixed(1)+'" y="'+top.toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+Math.max(hh,0).toFixed(1)+'" rx="1.5"><title>'+d.day+': '+d.hits+' redirects</title></rect>';
    if(d.creates) bars+='<rect class="c'+(last?'':' dim')+'" x="'+bx.toFixed(1)+'" y="'+(top-ch).toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+ch.toFixed(1)+'" rx="1.5"><title>'+d.day+': '+d.creates+' created</title></rect>';
    if(last) bars+='<circle class="cap" cx="'+(bx+w/2).toFixed(1)+'" cy="'+(top-ch-3).toFixed(1)+'" r="3.5"/>';});
  const labs=[0,Math.floor(data.length/2),data.length-1].map(i=>{
    const anc=i===0?'start':i===data.length-1?'end':'middle';
    return '<text x="'+(x(i)+bw/2).toFixed(1)+'" y="'+(H-6)+'" text-anchor="'+anc+'">'+data[i].day.slice(5)+'</text>';}).join('');
  return '<svg class="chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Redirects per day">'+
    '<g>'+g+'</g>'+bars+
    '<line class="base" x1="'+padL+'" y1="'+(padT+ih)+'" x2="'+(W-padR)+'" y2="'+(padT+ih)+'"/>'+labs+'</svg>'+
    '<div class="legend"><span><i class="h"></i>redirects</span><span><i class="c"></i>links created</span></div>';
}
function barList(rows,opt){
  opt=opt||{};
  if(!rows.length) return '<p class="empty">'+(opt.empty||'nothing yet')+'</p>';
  const max=Math.max(1,...rows.map(r=>r.v));
  return '<div class="bars">'+rows.map(r=>
    '<div class="brow"><span class="lab">'+(opt.label?opt.label(r):esc(r.k))+'</span>'+
    '<span class="val">'+fmtN(r.v)+'</span>'+
    '<span class="track"><span class="fill'+(opt.bad?' bad':'')+'" style="width:'+Math.max(r.v/max*100,2)+'%"></span></span></div>').join('')+'</div>';
}

async function render(){
  for(const b of $('#tabs').children) b.classList.toggle('on',b.dataset.t===tab);
  const v=$('#view'); v.innerHTML='<p class="empty">loading...</p>';
  try{
    if(tab==='overview') return renderOverview(v);
    if(tab==='links') return renderLinks(v);
    if(tab==='traffic') return renderTraffic(v);
    if(tab==='hosts') return renderHosts(v);
    if(tab==='activity') return renderActivity(v);
  }catch(e){ v.innerHTML=vhead(tab)+panel('<div class="msg err">'+esc(e.message)+'</div>'); }
}

async function renderOverview(v){
  const d=await api('overview?range='+range); const o=d.ops, s=d.summary;
  health(o);
  const stat=(n,k,rev)=>'<div class="stat'+(rev?' rev':'')+'"><div class="n">'+fmtN(n)+'</div><div class="k">'+k+'</div></div>';
  const kv=[
    ['Public base',esc(o.base)],
    ['Store backend','<span class="ok">'+esc(o.backend)+'</span>'],
    ['Store size',kib(o.storeBytes)],
    ['Links',fmtN(o.links.total)+' total, '+fmtN(o.links.revoked)+' revoked'],
    ['Hit counting',o.countHits?'<span class="ok">on</span>':'<span class="warn">off</span>'],
    ['Analytics',o.analyticsEnabled?'<span class="ok">on</span>':'<span class="warn">off</span>'],
    ['Default link TTL',o.defaultTtlDays>0?o.defaultTtlDays+' days':'never'],
    ['Allowlist',o.hostsEditable?'editable':'read-only'],
    ['Last backup',o.lastBackup?ago(o.lastBackup):'unknown'],
    ['Uptime',Math.floor(o.uptimeSec/86400)+'d '+Math.floor(o.uptimeSec%86400/3600)+'h'],
  ];
  v.innerHTML=vhead('Overview')+
    '<div class="grid stats">'+
      stat(s.totals.hits,'redirects, '+s.rangeDays+'d')+
      stat(s.totals.creates,'links created, '+s.rangeDays+'d')+
      stat(s.totals.rejects,'rejected, '+s.rangeDays+'d')+
      stat(o.links.total-o.links.revoked,'active links')+
      stat(o.links.revoked,'revoked',true)+
    '</div>'+
    '<div class="grid two" style="margin-top:16px">'+
      panel(cardhead('Redirects per day','last '+s.rangeDays+' days')+chart(s.series))+
      panel(cardhead('Service')+'<dl class="kv">'+kv.map(r=>'<dt>'+r[0]+'</dt><dd>'+r[1]+'</dd>').join('')+'</dl>')+
    '</div>'+
    panel(cardhead('Why links were rejected','last '+s.rangeDays+' days')+
      barList(d.rejects.map(r=>({k:r.reason,v:r.count})),{bad:true,empty:'none rejected'}));
}

let lsort={k:'created',d:-1};
const revealed=new Set();
const urlCache={};
async function renderLinks(v){
  const d=await api('links');
  badge('links',fmtN(d.links.length));
  v.innerHTML=vhead('Links')+panel(
    '<div class="toolbar">'+
      '<input class="grow" id="nu" placeholder="https://your-viewer/...#token" aria-label="target URL">'+
      '<input class="slug" id="ns" placeholder="slug (optional)" aria-label="custom slug">'+
      '<select id="nm" aria-label="code style"><option value="code">code</option><option value="words">words</option></select>'+
      '<input class="ttl" id="nt" type="number" min="0" placeholder="TTL" title="0 = never; blank = server default" aria-label="TTL days">'+
      '<button class="act primary" id="mk">Create link</button>'+
      '<span class="push"><button class="act" id="export">Export JSON</button>'+
      '<button class="act d" id="purge">Purge old 0-hit</button></span>'+
    '</div>'+
    '<div id="mkmsg"></div>'+
    '<div class="toolbar" style="margin-bottom:0">'+
      '<input class="grow" id="lq" placeholder="filter by slug or host" aria-label="filter">'+
    '</div>'+
    '<p class="hint">The list shows the target host only. <em>show link</em> reveals one stored destination (the pages someone bundled) on request. Revoke is a soft delete: the short link 404s but the row stays and the slug cannot be reused.</p>'
  )+'<div class="tablewrap" id="ltab" style="margin-top:16px"></div>';

  const filtered=()=>{
    const q=$('#lq').value.toLowerCase();
    let rows=d.links.slice();
    if(q)rows=rows.filter(r=>r.code.toLowerCase().includes(q)||(r.host||'').toLowerCase().includes(q));
    rows.sort((a,b)=>{const x=a[lsort.k]||0,y=b[lsort.k]||0;return (x>y?1:x<y?-1:0)*lsort.d});
    return rows;
  };
  const tgt=r=>{
    if(revealed.has(r.code)){
      const u=urlCache[r.code];
      return u
        ? '<span class="u" title="'+esc(u)+'">'+esc(u)+'</span> <a class="act xs" href="/'+encodeURIComponent(r.code)+'" target="_blank" rel="noopener">open</a> <button class="act xs" data-hide="'+esc(r.code)+'">hide</button>'
        : '<span class="note">loading...</span>';
    }
    return '<span class="u">'+esc(r.host||'?')+'</span> <button class="act xs" data-reveal="'+esc(r.code)+'">show link</button>';
  };
  const status=r=>{
    if(r.revoked) return chip('rev','revoked')+'<span class="rage">'+ago(r.revoked)+'</span>';
    if(r.expires) return chip('exp','expires')+'<span class="rage">'+until(r.expires)+'</span>';
    return chip('live','live');
  };
  const cols=[['code','Slug',0],['','Target',0],['mode','Style',0],['hits','Hits',1],['lastHit','Last hit',1],['created','Created',1],['','Status',0],['','',1]];
  const draw=()=>{
    const rows=filtered();
    $('#ltab').innerHTML='<table><thead><tr>'+cols.map(c=>
      '<th class="'+(c[2]?'r ':'')+(c[0]?'sortable':'')+'"'+(c[0]?' data-k="'+c[0]+'"':'')+'>'+c[1]+(c[0]===lsort.k?(lsort.d>0?' \\u2191':' \\u2193'):'')+'</th>').join('')+'</tr></thead><tbody>'+
      (rows.length?rows.map(r=>'<tr class="'+(r.revoked?'rv':'')+'">'+
        '<td><span class="slug">/'+esc(r.code)+'</span></td>'+
        '<td class="target"><span class="t">'+tgt(r)+'</span></td>'+
        '<td>'+chip(r.mode,r.mode)+'</td>'+
        '<td class="r"><span class="num">'+fmtN(r.hits)+'</span></td>'+
        '<td class="r"><span class="ago">'+(r.lastHit?ago(r.lastHit):'not yet')+'</span></td>'+
        '<td class="r"><span class="ago">'+ago(r.created)+'</span></td>'+
        '<td>'+status(r)+'</td>'+
        '<td class="r"><div class="rowact">'+(r.revoked
          ?'<button class="act" data-un="'+esc(r.code)+'">Restore</button>'
          :'<button class="act" data-rv="'+esc(r.code)+'">Revoke</button>'+
           (r.expires?'<button class="act" data-keep="'+esc(r.code)+'">Keep</button>'
                     :'<button class="act" data-expire="'+esc(r.code)+'">Expire</button>'))+
        '<button class="act d" data-del="'+esc(r.code)+'">Delete</button></div></td></tr>').join('')
        :'<tr><td colspan="8"><span class="empty">no links match</span></td></tr>')+
      '</tbody></table>';
  };
  draw();
  const row=c=>d.links.find(r=>r.code===c);
  $('#ltab').addEventListener('click',async e=>{
    const th=e.target.closest('th.sortable');
    if(th){const k=th.dataset.k;lsort={k,d:lsort.k===k?-lsort.d:1};draw();return}
    const t=e.target.closest('button, a'); if(!t)return;
    const ds=t.dataset;
    try{
      if(ds.reveal){revealed.add(ds.reveal);draw();
        try{const r=await api('links/'+encodeURIComponent(ds.reveal)+'/url');urlCache[ds.reveal]=r.url}
        catch(err){urlCache[ds.reveal]='(error: '+err.message+')'}
        draw();return;}
      if(ds.hide){revealed.delete(ds.hide);draw();return;}
      if(ds.rv){await api('links/'+encodeURIComponent(ds.rv)+'/revoke',{method:'POST'});row(ds.rv).revoked=Date.now()}
      else if(ds.un){await api('links/'+encodeURIComponent(ds.un)+'/unrevoke',{method:'POST'});row(ds.un).revoked=0}
      else if(ds.keep){await api('links/'+encodeURIComponent(ds.keep)+'/keep',{method:'POST'});row(ds.keep).expires=0}
      else if(ds.expire){
        const days=prompt('Expire this link in how many days? (0 = now)','0');if(days===null)return;
        const r=await api('links/'+encodeURIComponent(ds.expire)+'/expire',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({days:+days})});
        row(ds.expire).expires=r.expires||Date.now()-1;}
      else if(ds.del){if(!confirm('Delete '+ds.del+' permanently?'))return;await api('links/'+encodeURIComponent(ds.del),{method:'DELETE'});d.links=d.links.filter(r=>r.code!==ds.del)}
      else return;
      draw();badge('links',fmtN(d.links.length));
    }catch(err){alert(err.message)}
  });
  $('#lq').oninput=draw;
  $('#export').onclick=()=>{ if(confirm('The export file contains every stored destination URL (all bundled pages). Download it?')) location.href='/admin/api/export'; };
  $('#mk').onclick=async()=>{
    try{
      const tt=$('#nt').value.trim();
      const payload={url:$('#nu').value,slug:$('#ns').value,mode:$('#nm').value};
      if(tt!=='')payload.ttlDays=+tt;
      const r=await api('links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      $('#mkmsg').innerHTML='<div class="msg ok">'+esc(r.shortUrl)+(r.reused?' (existing)':'')+(r.expires?' \\u00b7 expires '+new Date(r.expires).toISOString().slice(0,10):'')+'</div>';
      d.links.unshift({code:r.code,host:hostOf($('#nu').value),mode:r.mode||$('#nm').value,hits:0,lastHit:0,created:Date.now(),expires:r.expires||0,revoked:0});
      $('#nu').value=$('#ns').value=$('#nt').value='';draw();badge('links',fmtN(d.links.length));
    }catch(err){$('#mkmsg').innerHTML='<div class="msg err">'+esc(err.message)+'</div>'}
  };
  $('#purge').onclick=async()=>{
    const days=prompt('Delete links with 0 hits older than how many days?','90');if(!days)return;
    try{const r=await api('purge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({days:+days})});
      alert(r.deleted+' deleted');render();}catch(err){alert(err.message)}
  };
}

async function renderTraffic(v){
  const d=await api('stats?range='+range); const s=d.summary;
  v.innerHTML=vhead('Traffic')+
    panel(cardhead('Redirects per day','last '+s.rangeDays+' days')+chart(s.series))+
    '<div class="grid two" style="margin-top:16px">'+
      panel(cardhead('Busiest links','last '+range+'d')+barList(d.topLinks.map(r=>({k:r.code,v:r.hits})),{label:r=>'<code>'+esc(r.k)+'</code>'}))+
      panel(cardhead('Referrers','host only')+barList(d.referrers.map(r=>({k:r.host,v:r.hits})),{empty:'no referrers'}))+
    '</div>'+
    '<div class="grid two" style="margin-top:16px">'+
      panel(cardhead('Browsers','last '+range+'d')+barList((d.browsers||[]).map(r=>({k:r.browser,v:r.hits})),{empty:'no data'}))+
      panel(cardhead('Why links were rejected','last '+range+'d')+barList(d.rejects.map(r=>({k:r.reason,v:r.count})),{bad:true,empty:'none rejected'}))+
    '</div>'+
    panel(cardhead('Shared domains','decoded on request')+
      '<p class="hint" style="margin-top:0">Decodes every stored link now and counts the registrable domain of each bundled page (<code>reddit.com</code>, never the post). Computed on request, kept nowhere.</p>'+
      '<button class="act" id="analyze" style="margin-top:12px">Analyze</button><div id="domres" style="margin-top:14px"></div>');
  $('#analyze').onclick=async()=>{
    $('#domres').innerHTML='<span class="note">decoding...</span>';
    try{
      const r=await api('domains');
      $('#domres').innerHTML='<p class="hint" style="margin:0 0 12px">'+r.decoded+' of '+r.links+' links decoded ('+r.encrypted+' encrypted, '+r.undecodable+' undecodable) \\u00b7 '+r.pages+' pages \\u00b7 '+r.uniqueDomains+' domains</p>'+
        barList(r.domains.slice(0,40).map(x=>({k:x.domain,v:x.pages,n:x.links})),{label:x=>esc(x.k)+' <span class="sub">('+x.n+' link'+(x.n===1?'':'s')+')</span>'});
    }catch(err){$('#domres').innerHTML='<span class="note">'+esc(err.message)+'</span>'}
  };
}

async function renderHosts(v){
  const d=await api('hosts');
  badge('hosts',d.hosts.length);
  v.innerHTML=vhead('Allowed redirect targets')+panel(
    cardhead('Host allowlist',d.editable?'editable, hot-reloads':'read-only')+
    (d.editable
      ?'<p class="hint" style="margin-top:0">One host per line. A short link may only redirect to a host on this list -- this is what keeps the shortener from being usable for phishing. <code>localhost</code> and <code>127.0.0.1</code> are always allowed. Saving reloads the running service, no restart.</p>'+
       '<textarea id="ha" rows="7" spellcheck="false" style="margin-top:12px">'+esc(d.hosts.join('\\n'))+'</textarea>'+
       '<div class="toolbar" style="margin:12px 0 0"><button class="act primary" id="sh">Save allowlist</button><span class="note" id="hmsg"></span></div>'
      :'<div class="msg err">Read-only -- set <code>SHORTENER_HOSTS_FILE</code> in the service to edit here.</div>'+
       '<div class="bars" style="margin-top:12px">'+d.hosts.map(h=>'<div class="brow"><span class="lab"><code>'+esc(h)+'</code></span></div>').join('')+'</div>')
  );
  if(d.editable)$('#sh').onclick=async()=>{
    try{const r=await api('hosts',{method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({hosts:$('#ha').value.split('\\n').map(s=>s.trim()).filter(Boolean)})});
      $('#hmsg').textContent='saved -- '+r.hosts.length+' hosts active';badge('hosts',r.hosts.length);
    }catch(err){$('#hmsg').textContent=err.message}
  };
}

async function renderActivity(v){
  const d=await api('stats?range='+range);
  const detail=e=>{
    if(e.type==='hit'){const h=e.host&&e.host!=='(direct)';return '<code>'+esc(e.code)+'</code> <span class="from">'+(h?'referred by '+esc(e.host):'direct / no referrer')+'</span>';}
    if(e.type==='create') return '<code>'+esc(e.code)+'</code> <span class="from">'+esc(e.mode||'code')+' style</span>';
    return '<code>'+esc(e.reason)+'</code>'+(e.host?' <span class="from">tried '+esc(e.host)+'</span>':'');
  };
  v.innerHTML=vhead('Recent activity')+
    '<div class="tablewrap"><table class="feed"><thead><tr><th style="width:120px">When</th><th style="width:90px">Event</th><th>Detail</th></tr></thead><tbody>'+
    (d.recent.length?d.recent.map(e=>'<tr><td><span class="ago">'+ago(e.t)+'</span></td>'+
      '<td><span class="ev"><span class="k '+e.type+'"></span>'+e.type+'</span></td>'+
      '<td class="detail">'+detail(e)+'</td></tr>').join('')
      :'<tr><td colspan="3"><span class="empty">no events yet</span></td></tr>')+
    '</tbody></table></div>'+
    '<p class="hint">The last few hundred events, in memory. Redirects log the referring host only -- never a path, query string or IP.</p>';
}

render();
</script></body></html>`;
