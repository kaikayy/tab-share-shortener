/*!
 * collections.mjs -- on-demand, aggregate-only view of what is behind the
 * stored links.
 *
 * A Tab Share link redirects to the viewer host; the pages someone bundled sit
 * in the URL `#fragment` as an lz-string blob. This module decodes that blob
 * for every currently stored link and tallies the *registrable domain* of each
 * page (`reddit.com`, never `reddit.com/r/x/comments/...`). Nothing here is
 * persisted or logged -- it is computed when the admin panel asks and thrown
 * away. Encrypted (password) collections cannot be decoded and are only
 * counted.
 *
 * The decoder is a vendored copy of the Tab Share share-codec + lz-string
 * (src/lib/), loaded as CommonJS. If the codec schema ever moves past what the
 * vendored copy understands, newer links just count as "undecodable".
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @type {{ decode(fragment: string): any }} */
const ShareCodec = require("./lib/share-codec.js");

// A small public-suffix list -- enough for a histogram, not the full PSL.
const MULTI_TLD = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "org.nz", "net.nz", "govt.nz",
  "co.za", "org.za", "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br", "gov.br", "com.cn", "net.cn", "org.cn",
  "co.in", "com.mx", "com.tr", "com.sg", "com.hk", "co.kr",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app",
  "netlify.app", "web.app", "firebaseapp.com", "r2.dev", "onrender.com",
]);

/** `www.a.b.co.uk` -> `a.b.co.uk` ; `x.reddit.com` -> `reddit.com` */
export function registrableDomain(host) {
  let h = String(host || "").toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  if (!h || h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return h || "?";
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  if (MULTI_TLD.has(last2)) return last3;
  return last2;
}

/** The `#fragment` token of a stored URL, or "" if there is none. */
function fragmentOf(url) {
  const i = url.indexOf("#");
  return i === -1 ? "" : url.slice(i + 1);
}

/**
 * @param {{ list(): Array<{code: string, url: string, revoked?: number}> }} store
 * @param {{ includeRevoked?: boolean }} [opts]
 */
export function domainHistogram(store, opts = {}) {
  const rows = store.list().filter((r) => opts.includeRevoked || !r.revoked);

  /** domain -> { pages, links } */
  const tally = new Map();
  const add = (domain, linkSeen) => {
    let e = tally.get(domain);
    if (!e) tally.set(domain, (e = { pages: 0, links: 0 }));
    e.pages += 1;
    if (linkSeen && !linkSeen.has(domain)) {
      e.links += 1;
      linkSeen.add(domain);
    }
  };

  let decoded = 0;
  let encrypted = 0;
  let undecodable = 0;
  let totalPages = 0;

  for (const r of rows) {
    let frag = "";
    let host = "?";
    try {
      const u = new URL(r.url);
      host = u.host;
      frag = fragmentOf(r.url);
    } catch {
      undecodable += 1;
      continue;
    }

    if (!frag) {
      // a plain (non-Tab-Share) shortened URL -- its own domain is the target
      add(registrableDomain(host), new Set());
      totalPages += 1;
      decoded += 1;
      continue;
    }

    let col;
    try {
      col = ShareCodec.decode(frag);
    } catch {
      col = null;
    }
    if (col && col.encrypted) {
      encrypted += 1;
      continue;
    }
    if (!col || !Array.isArray(col.pages) || !col.pages.length) {
      undecodable += 1;
      continue;
    }

    decoded += 1;
    const linkSeen = new Set();
    for (const p of col.pages) {
      let ph = "?";
      try {
        ph = new URL(p.url).host;
      } catch {
        continue;
      }
      add(registrableDomain(ph), linkSeen);
      totalPages += 1;
    }
  }

  const domains = [...tally.entries()]
    .map(([domain, e]) => ({ domain, pages: e.pages, links: e.links }))
    .sort((a, b) => b.pages - a.pages || b.links - a.links);

  return {
    links: rows.length,
    decoded,
    encrypted,
    undecodable,
    pages: totalPages,
    uniqueDomains: domains.length,
    domains,
  };
}
