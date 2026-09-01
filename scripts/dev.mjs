#!/usr/bin/env node
/**
 * dev.mjs — run the shortener with local-friendly defaults.
 *
 *   - listens on :8779
 *   - short links look like http://localhost:8779/<code>
 *   - accepts targets on the local viewer (localhost:8777) AND the default
 *     hosted viewer (kaikayy.github.io), so you can test either
 *   - separate store file so dev links don't mix with anything real
 *
 * Override any of these by exporting the real env var before running.
 */

process.env.SHORTENER_PORT ??= "8779";
process.env.SHORTENER_BASE ??= "http://localhost:8779";
process.env.SHORTENER_HOSTS ??= "kaikayy.github.io,localhost:8777,127.0.0.1:8777";
process.env.SHORTENER_STORE ??= new URL("../data/dev-links.json", import.meta.url).pathname;
process.env.SHORTENER_TTL_DAYS ??= "0";

await import("../src/server.mjs");
