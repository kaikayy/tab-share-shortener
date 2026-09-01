/*!
 * validate.mjs -- decide whether a submitted URL may be stored.
 *
 * The service is purpose-built for Tab Share links, so the target host must be
 * on the allowlist (see SHORTENER_HOSTS). That single rule is what keeps this
 * from becoming an open redirector for phishing.
 */

import { Buffer } from "node:buffer";
import { config, hostAllowed } from "./config.mjs";

/** @typedef {{ ok: true, url: string } | { ok: false, status: number, error: string }} Result */

/**
 * @param {string} raw
 * @returns {Result}
 */
export function validateTarget(raw) {
  if (typeof raw !== "string" || raw === "") {
    return { ok: false, status: 400, error: "missing url" };
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > config.maxUrlBytes) {
    return {
      ok: false,
      status: 413,
      error: `url is ${bytes} bytes, limit is ${config.maxUrlBytes}`,
    };
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, status: 400, error: "not a valid URL" };
  }

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) {
    return { ok: false, status: 400, error: "url must be https://" };
  }

  // Don't shorten our own short links (redirect loops / abuse amplification).
  try {
    const self = new URL(config.base);
    if (u.host === self.host) {
      return { ok: false, status: 400, error: "refusing to shorten a link on this host" };
    }
  } catch {
    /* base misconfigured -- skip the self-check */
  }

  if (!hostAllowed(u.host)) {
    return {
      ok: false,
      status: 403,
      error: `host "${u.host}" is not on this shortener's allowlist`,
    };
  }

  return { ok: true, url: u.href };
}
