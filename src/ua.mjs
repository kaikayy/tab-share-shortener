/*!
 * ua.mjs -- reduce a User-Agent string to "<browser> <major version>".
 *
 * Aggregate analytics only: the result is a low-entropy label like "Firefox 130"
 * or "Chrome 141" that is tallied by day. The full UA string, the OS, the device
 * and the exact version are never kept.
 */

const RULES = [
  [/(?:edg|edga|edgios)\/(\d+)/i, "Edge"],
  [/(?:opr|opera)\/(\d+)/i, "Opera"],
  [/samsungbrowser\/(\d+)/i, "Samsung Internet"],
  [/vivaldi\/(\d+)/i, "Vivaldi"],
  [/(?:firefox|fxios)\/(\d+)/i, "Firefox"],
  [/(?:chrome|crios|chromium)\/(\d+)/i, "Chrome"],
  [/version\/(\d+)[.\d]* (?:mobile\/\w+ )?safari/i, "Safari"],
];

const BOT = /bot|crawler|spider|crawl|slurp|facebookexternalhit|embedly|preview|monitor|curl|wget|python-requests|okhttp|headless/i;

/** @param {string|undefined} ua @returns {string} */
export function parseUA(ua) {
  const s = String(ua || "").trim();
  if (!s) return "unknown";
  if (BOT.test(s)) return "bot / preview";
  for (const [re, name] of RULES) {
    const m = s.match(re);
    if (m) return `${name} ${m[1]}`;
  }
  return "other";
}
