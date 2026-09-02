/*!
 * codes.mjs -- generate the short code that follows the base URL.
 *
 *   mode "code"  -> 7 chars from an unambiguous base-56 alphabet, e.g. "k7Rm2pq"
 *   mode "words" -> adjective-adjective-noun, e.g. "swift-amber-otter"
 *                   (a "-xx" suffix is added only when the first pick collides)
 *
 * `taken` is any function `(code) => boolean` -- the store's has() check.
 */

import { randomInt } from "node:crypto";
import { config } from "./config.mjs";
import { ADJECTIVES, NOUNS } from "./words.mjs";

// No 0/O, 1/l/I -- safe to read aloud and retype.
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

export const MODES = ["code", "words"];

export function normalizeMode(mode) {
  const m = String(mode || "").toLowerCase();
  return MODES.includes(m) ? m : "code";
}

function pick(list) {
  return list[randomInt(list.length)];
}

function randomCode(length) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

function wordSlug() {
  return `${pick(ADJECTIVES)}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/**
 * @param {"code"|"words"} mode
 * @param {(code: string) => boolean} taken
 * @returns {string}
 * @throws if it can't find a free code (store is effectively full)
 */
export function generate(mode, taken) {
  const m = normalizeMode(mode);

  if (m === "words") {
    for (let i = 0; i < 40; i++) {
      const base = wordSlug();
      if (!taken(base)) return base;
      // collided: try the same-shaped slug with a short disambiguator
      for (let j = 0; j < 6; j++) {
        const cand = `${base}-${randomCode(2)}`;
        if (!taken(cand)) return cand;
      }
    }
    throw new Error("code space exhausted (words)");
  }

  let length = Math.max(4, config.codeLength);
  for (let i = 0; i < 60; i++) {
    const cand = randomCode(length);
    if (!taken(cand)) return cand;
    if (i > 0 && i % 12 === 0) length++; // getting crowded -- widen
  }
  throw new Error("code space exhausted (code)");
}

/** Structural check for an incoming :code path segment (not existence). */
export function looksLikeCode(code) {
  return typeof code === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,79})$/.test(code);
}

/**
 * An unguessable per-link secret, handed back at creation. Whoever holds it can
 * pin the link against expiry (POST /api/keep). 22 chars of the same
 * unambiguous alphabet, ~128 bits.
 */
export function keepToken() {
  let out = "";
  for (let i = 0; i < 22; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export { ALPHABET };
