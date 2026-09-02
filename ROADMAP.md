# Roadmap

Not committed to, roughly in priority order.

## Operator cannot read the shared collections

Today the server stores each short link's full destination URL in the clear
(it has to, to redirect), and the admin panel can reveal any one of them on
request. For a Tab Share link that destination *is* the shared collection
(page URLs + titles, in the `#` fragment). Goal: make it so the operator of a
running instance genuinely **cannot** browse what people shared, while
redirects still work.

Directions being considered:

- **Encrypt the stored destination with a key that only travels in the short
  URL** (e.g. derived from the code, or a second path segment), so `links.json`
  holds ciphertext and the plaintext exists only for the duration of a redirect,
  never at rest in a browsable form. Referrer/host analytics stay possible; a
  full-URL dump does not.
- **Store only what a redirect needs** plus a content hash, and drop the admin
  "reveal" path entirely on instances that opt in (`SHORTENER_OPAQUE=1`).
- Accept that a redirect handler can always log its target, and document that
  the guarantee is "not at rest / not casually", not "never observable".

Interim (shipped in 0.2.1): the admin link list shows the **target host only**;
seeing a destination is a deliberate per-link action, and the JSON export warns
first.

## MySQL / MariaDB storage backend

The `sqlite` backend needs Node 24, so a Node 20 box (KeyHelp, cPanel, shared
hosting) is stuck on the JSON file backend. Those hosts almost always offer a
MySQL/MariaDB database, so a `mysql` backend is the planned durable option
there. It would be the project's first runtime dependency (a driver such as
`mysql2` -- Node has no built-in MySQL client), kept optional and lazy-loaded
the way `node:sqlite` is now. Same `openStore()` surface. The analytics store
(`src/analytics.mjs`) is already flat JSON so it can move in the same step.

## Smaller

- Per-link expiry surfaced in the admin panel (the store already supports
  `ttlDays`).
- Admin: bulk revoke / delete by filter.
- Optional Prometheus-style `/metrics` endpoint (behind the admin token).
