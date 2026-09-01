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
  const c = readCookie(req, COOKIE);
  if (c) return c;
  if (method === "GET" && urlObj.searchParams.has("token")) return urlObj.searchParams.get("token");
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
      let rows = store.list();
      if (q) rows = rows.filter((r) => r.code.toLowerCase().includes(q) || r.url.toLowerCase().includes(q));
      return sendJson(res, 200, { total: rows.length, links: rows.slice(0, limit) }), true;
    }

    if (method === "POST" && p === "/admin/api/links") {
      const body = await readBody(req);
      return createLink(res, store, body), true;
    }

    const linkOp = /^\/admin\/api\/links\/([^/]+)(?:\/(revoke|unrevoke|stats))?$/.exec(p);
    if (linkOp) {
      const code = decodeURIComponent(linkOp[1]);
      const action = linkOp[2];
      if (method === "GET" && action === "stats") {
        const range = clampRange(urlObj.searchParams.get("range"));
        return sendJson(res, 200, { code, series: analytics.seriesForCode(code, range) }), true;
      }
      if (method === "POST" && action === "revoke") {
        return sendJson(res, 200, { ok: store.revoke(code) }), true;
      }
      if (method === "POST" && action === "unrevoke") {
        return sendJson(res, 200, { ok: store.unrevoke(code) }), true;
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
          rejects: analytics.rejectReasons(range),
          recent: analytics.recentEvents(120),
        }),
        true
      );
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
:root{--bg:#fbfbfd;--card:#fff;--ink:#1a1a1f;--mut:#6b6b76;--line:#e4e4ea;--brand:#c026a8;--accent:#f4a259;--ok:#2f9e44;--bad:#e03131}
@media(prefers-color-scheme:dark){:root{--bg:#141417;--card:#1d1d21;--ink:#ececf0;--mut:#9a9aa6;--line:#33333b;--brand:#e879d4;--accent:#f4a259}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--brand)}h1{font-size:18px;margin:0}h2{font-size:14px;margin:0 0 .6rem;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
header{display:flex;align-items:center;gap:1rem;padding:1rem 1.2rem;border-bottom:1px solid var(--line);flex-wrap:wrap}
header .sp{flex:1}main{max-width:1080px;margin:0 auto;padding:1.2rem}
nav{display:flex;gap:.3rem;flex-wrap:wrap;margin-bottom:1rem}
nav button{background:var(--card);border:1px solid var(--line);color:var(--ink);padding:.4rem .8rem;border-radius:7px;cursor:pointer;font:inherit}
nav button.on{background:var(--brand);border-color:var(--brand);color:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem;margin-bottom:1rem}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.kpi{font-size:26px;font-weight:600}.kpi small{display:block;font-size:12px;font-weight:400;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;cursor:pointer;white-space:nowrap}td.u{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr.rv{opacity:.5}code{background:color-mix(in srgb,var(--brand) 12%,transparent);padding:.05em .35em;border-radius:4px;font-size:.92em}
button.act{background:none;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:.2rem .5rem;cursor:pointer;font-size:12px}
button.act:hover{border-color:var(--brand)}button.act.d:hover{border-color:var(--bad);color:var(--bad)}
input,select{font:inherit;padding:.4rem .5rem;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink)}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.bars>div{display:flex;align-items:center;gap:.5rem;margin:.2rem 0}
.bars .b{height:14px;background:var(--brand);border-radius:3px;min-width:2px}.bars .n{color:var(--mut);font-variant-numeric:tabular-nums}
.bars .l{width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
svg .ax{stroke:var(--line)}svg .h{fill:var(--brand)}svg .c{fill:var(--accent)}
.msg{padding:.5rem .7rem;border-radius:7px;margin-bottom:.6rem;font-size:13px}.msg.ok{background:color-mix(in srgb,var(--ok) 15%,transparent)}.msg.err{background:color-mix(in srgb,var(--bad) 15%,transparent)}
.mut{color:var(--mut)}.tag{font-size:11px;border:1px solid var(--line);border-radius:20px;padding:.05rem .5rem;color:var(--mut)}
</style></head><body>
<header><h1>Tab Share shortener</h1><span class="tag" id="ver"></span><span class="sp"></span>
<label class="mut">range <select id="range"><option>7</option><option selected>30</option><option>90</option><option>365</option></select></label>
<a href="/admin/logout">log out</a></header>
<main>
<nav id="tabs"></nav>
<div id="view"></div>
</main>
<script>
const $=s=>document.querySelector(s), api=(u,o)=>fetch('/admin/api/'+u,o).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j});
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtN=n=>n.toLocaleString(), ago=t=>{if(!t)return 'never';const s=(Date.now()-t)/1e3;for(const[u,d]of[['d',86400],['h',3600],['m',60]])if(s>=d)return Math.floor(s/d)+u+' ago';return 'just now'};
const kib=b=>b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(2)+' MB';
let range=30, tab='overview';
$('#range').onchange=e=>{range=+e.target.value;render()};
const TABS=['overview','links','traffic','hosts','activity'];
$('#tabs').innerHTML=TABS.map(t=>'<button data-t="'+t+'">'+t+'</button>').join('');
$('#tabs').onclick=e=>{const t=e.target.dataset.t;if(t){tab=t;render()}};

function barChart(series){
  if(!series||!series.length) return '<p class="mut">no data</p>';
  const w=Math.max(series.length*14,320),h=90,max=Math.max(1,...series.map(d=>d.hits+d.creates));
  const bw=w/series.length;
  const bars=series.map((d,i)=>{const x=i*bw+1,bwi=Math.max(bw-2,1);
    const hh=(d.hits/max)*(h-16),ch=(d.creates/max)*(h-16);
    return '<rect class="h" x="'+x+'" y="'+(h-16-hh)+'" width="'+bwi+'" height="'+hh+'"><title>'+d.day+': '+d.hits+' hits</title></rect>'+
           (ch?'<rect class="c" x="'+x+'" y="'+(h-16-hh-ch)+'" width="'+bwi+'" height="'+ch+'"><title>'+d.day+': '+d.creates+' created</title></rect>':'')}).join('');
  const labels=[series[0],series[series.length-1]].map((d,i)=>'<text x="'+(i?w:0)+'" y="'+h+'" font-size="10" fill="currentColor" text-anchor="'+(i?'end':'start')+'">'+d.day.slice(5)+'</text>').join('');
  return '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="110" preserveAspectRatio="none"><line class="ax" x1="0" y1="'+(h-16)+'" x2="'+w+'" y2="'+(h-16)+'"/>'+bars+labels+'</svg>';
}
function bars(rows,label){
  if(!rows.length) return '<p class="mut">nothing yet</p>';
  const max=Math.max(1,...rows.map(r=>r.v));
  return '<div class="bars">'+rows.map(r=>
    '<div><span class="l" title="'+esc(r.k)+'">'+label(r)+'</span><span class="b" style="width:'+(r.v/max*100)+'%"></span><span class="n">'+fmtN(r.v)+'</span></div>').join('')+'</div>';
}

async function render(){
  for(const b of $('#tabs').children) b.classList.toggle('on',b.dataset.t===tab);
  const v=$('#view'); v.innerHTML='<p class="mut">loading...</p>';
  try{
    if(tab==='overview') return renderOverview(v);
    if(tab==='links') return renderLinks(v);
    if(tab==='traffic') return renderTraffic(v);
    if(tab==='hosts') return renderHosts(v);
    if(tab==='activity') return renderActivity(v);
  }catch(e){ v.innerHTML='<div class="msg err">'+esc(e.message)+'</div>'; }
}
async function renderOverview(v){
  const d=await api('overview?range='+range); const o=d.ops, s=d.summary;
  $('#ver').textContent='v'+o.version+' \\u00b7 '+o.backend;
  v.innerHTML='<div class="card"><h2>last '+s.rangeDays+' days</h2><div class="grid">'+
    kpi(s.totals.hits,'redirects')+kpi(s.totals.creates,'links created')+kpi(s.totals.rejects,'rejected')+
    kpi(o.links.total,'links total')+kpi(o.links.revoked,'revoked')+'</div>'+
    '<div style="margin-top:1rem;color:var(--mut)">'+barChart(s.series)+
    '<small>magenta = redirects, orange = created</small></div></div>'+
    '<div class="card"><h2>service</h2><table>'+
    tr('version',o.version)+tr('store backend',o.backend)+tr('store size',kib(o.storeBytes))+
    tr('public base',o.base)+tr('uptime',Math.floor(o.uptimeSec/3600)+'h '+Math.floor(o.uptimeSec%3600/60)+'m')+
    tr('hit counting',o.countHits?'on':'off')+tr('analytics',o.analyticsEnabled?'on':'off')+
    tr('allowlist editable',o.hostsEditable?'yes':'no (set SHORTENER_HOSTS_FILE)')+
    tr('last backup',o.lastBackup?ago(o.lastBackup):'unknown')+'</table></div>'+
    (d.rejects.length?'<div class="card"><h2>why links were rejected</h2>'+bars(d.rejects.map(r=>({k:r.reason,v:r.count})),r=>esc(r.k))+'</div>':'');
}
const kpi=(n,l)=>'<div><span class="kpi">'+fmtN(n)+'<small>'+l+'</small></span></div>';
const tr=(k,x)=>'<tr><td class="mut">'+k+'</td><td>'+esc(x)+'</td></tr>';

let lsort={k:'created',d:-1};
async function renderLinks(v){
  const d=await api('links');
  v.innerHTML='<div class="card"><div class="row" style="margin-bottom:.6rem">'+
    '<input id="nu" placeholder="https://your-viewer/...#token" style="flex:1;min-width:220px">'+
    '<input id="ns" placeholder="slug (optional)" size="12">'+
    '<select id="nm"><option value="code">code</option><option value="words">words</option></select>'+
    '<button class="act" id="mk">create</button></div><div id="mkmsg"></div>'+
    '<div class="row" style="margin-bottom:.6rem"><input id="lq" placeholder="filter code or url" style="flex:1">'+
    '<a class="act" href="/admin/api/export">export JSON</a>'+
    '<button class="act d" id="purge">purge old 0-hit</button></div>'+
    '<div id="ltab"></div></div>';
  const draw=()=>{
    let rows=d.links.slice();
    const q=$('#lq').value.toLowerCase();
    if(q)rows=rows.filter(r=>r.code.toLowerCase().includes(q)||r.url.toLowerCase().includes(q));
    rows.sort((a,b)=>{const x=a[lsort.k],y=b[lsort.k];return (x>y?1:x<y?-1:0)*lsort.d});
    $('#ltab').innerHTML='<table><thead><tr>'+
      ['code','url','mode','hits','lastHit','created','revoked',''].map(h=>h?'<th data-k="'+h+'">'+h+'</th>':'<th></th>').join('')+
      '</tr></thead><tbody>'+rows.map(r=>'<tr class="'+(r.revoked?'rv':'')+'">'+
      '<td><a href="/'+encodeURIComponent(r.code)+'" target="_blank"><code>'+esc(r.code)+'</code></a></td>'+
      '<td class="u" title="'+esc(r.url)+'">'+esc(r.url)+'</td><td>'+r.mode+'</td><td>'+fmtN(r.hits)+'</td>'+
      '<td class="mut">'+(r.lastHit?ago(r.lastHit):'--')+'</td><td class="mut">'+ago(r.created)+'</td>'+
      '<td class="mut">'+(r.revoked?ago(r.revoked):'')+'</td>'+
      '<td class="row">'+(r.revoked
        ?'<button class="act" data-un="'+esc(r.code)+'">restore</button>'
        :'<button class="act d" data-rv="'+esc(r.code)+'">revoke</button>')+
      '<button class="act d" data-del="'+esc(r.code)+'">del</button></td></tr>').join('')+
      '</tbody></table><p class="mut">'+rows.length+' shown</p>';
  };
  draw();
  $('#ltab').onclick=async e=>{
    const rv=e.target.dataset.rv,un=e.target.dataset.un,del=e.target.dataset.del;
    try{
      if(rv){await api('links/'+encodeURIComponent(rv)+'/revoke',{method:'POST'});row(rv).revoked=Date.now()}
      else if(un){await api('links/'+encodeURIComponent(un)+'/unrevoke',{method:'POST'});row(un).revoked=0}
      else if(del){if(!confirm('Delete '+del+' permanently?'))return;await api('links/'+encodeURIComponent(del),{method:'DELETE'});d.links=d.links.filter(r=>r.code!==del)}
      else return;
      draw();
    }catch(err){alert(err.message)}
  };
  const row=c=>d.links.find(r=>r.code===c);
  $('#ltab').addEventListener('click',e=>{const k=e.target.dataset.k;if(k){lsort={k,d:lsort.k===k?-lsort.d:1};draw()}});
  $('#lq').oninput=draw;
  $('#mk').onclick=async()=>{
    try{
      const r=await api('links',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({url:$('#nu').value,slug:$('#ns').value,mode:$('#nm').value})});
      $('#mkmsg').innerHTML='<div class="msg ok">'+esc(r.shortUrl)+(r.reused?' (existing)':'')+'</div>';
      d.links.unshift({code:r.code,url:$('#nu').value,mode:r.mode||$('#nm').value,hits:0,lastHit:0,created:Date.now(),revoked:0});
      $('#nu').value=$('#ns').value='';draw();
    }catch(err){$('#mkmsg').innerHTML='<div class="msg err">'+esc(err.message)+'</div>'}
  };
  $('#purge').onclick=async()=>{
    const days=prompt('Delete links with 0 hits older than how many days?','90');if(!days)return;
    try{const r=await api('purge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({days:+days})});
      alert(r.deleted+' deleted');render();}catch(err){alert(err.message)}
  };
}
async function renderTraffic(v){
  const d=await api('stats?range='+range);
  v.innerHTML='<div class="card"><h2>daily</h2><div style="color:var(--mut)">'+barChart(d.summary.series)+'</div></div>'+
    '<div class="card"><h2>busiest links ('+range+'d)</h2>'+bars(d.topLinks.map(r=>({k:r.code,v:r.hits})),r=>'<code>'+esc(r.k)+'</code>')+'</div>'+
    '<div class="card"><h2>referrers ('+range+'d)</h2>'+bars(d.referrers.map(r=>({k:r.host,v:r.hits})),r=>esc(r.k))+'</div>'+
    (d.rejects.length?'<div class="card"><h2>rejected ('+range+'d)</h2>'+bars(d.rejects.map(r=>({k:r.reason,v:r.count})),r=>esc(r.k))+'</div>':'');
}
async function renderHosts(v){
  const d=await api('hosts');
  v.innerHTML='<div class="card"><h2>allowed redirect-target hosts</h2>'+
    (d.editable?'<p class="mut">One host per line. localhost / 127.0.0.1 are always allowed.</p>'+
      '<textarea id="ha" rows="8" style="width:100%;font-family:ui-monospace,monospace">'+esc(d.hosts.join('\\n'))+'</textarea>'+
      '<div class="row" style="margin-top:.6rem"><button class="act" id="sh">save</button><span id="hmsg" class="mut"></span></div>'
      :'<div class="msg err">Read-only: set <code>SHORTENER_HOSTS_FILE</code> in the service to edit here.</div><ul>'+
       d.hosts.map(h=>'<li><code>'+esc(h)+'</code></li>').join('')+'</ul>')+'</div>';
  if(d.editable)$('#sh').onclick=async()=>{
    try{const r=await api('hosts',{method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({hosts:$('#ha').value.split('\\n').map(s=>s.trim()).filter(Boolean)})});
      $('#hmsg').textContent='saved -- '+r.hosts.length+' hosts active';
    }catch(err){$('#hmsg').textContent=err.message}
  };
}
async function renderActivity(v){
  const d=await api('stats?range='+range);
  v.innerHTML='<div class="card"><h2>recent events</h2><table><thead><tr><th>when</th><th>type</th><th>detail</th></tr></thead><tbody>'+
    d.recent.map(e=>'<tr><td class="mut">'+ago(e.t)+'</td><td>'+e.type+'</td><td>'+
      esc(e.type==='hit'?e.code+'  <-  '+(e.host||'(direct)'):e.type==='create'?e.code+' ('+(e.mode||'code')+')':e.reason+(e.host?'  '+e.host:''))+
    '</td></tr>').join('')+'</tbody></table></div>';
}
render();
</script></body></html>`;
