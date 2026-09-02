# Changelog

Notable changes. Dates are `YYYY-MM-DD`.

## [0.2.2] - 2026-09-02

### Added

- **Browser-family analytics.** Each redirect adds a per-day tally of the
  visitor's browser family + major version (`Firefox 130`, `Chrome 141`,
  `bot / preview`), reduced from the User-Agent. The full UA, OS, device and
  exact version are never kept. Still no IP, no geolocation, no cookies.
- **On-request "shared domains" histogram** in the admin panel
  (`GET /admin/api/domains`). Decodes every stored link's collection and counts
  the registrable domain of each bundled page (`reddit.com`, never the post).
  Computed when you click, stored nowhere. Password-protected collections are
  only counted. Vendors lz-string + the Tab Share share-codec into `src/lib/`
  (loaded as CommonJS; still zero npm dependencies).

### Changed

- `PRIVACY.md` reworked: an explicit "never recorded" list, a "we will never
  sell your data" section, and the on-request domain view spelled out.
- `deploy/auto-update.sh` hard-resets to upstream instead of `git pull
  --ff-only`, so a force-push upstream self-heals instead of wedging the timer.
- `deploy/install.sh` reports `kept` / `generated` / `changed` for the admin
  token (was misleadingly "existing token kept" whenever you passed one in).

## [0.2.1] - 2026-09-02

### Changed

- **Admin link list shows the target host only.** `GET /admin/api/links`
  omits destination URLs; a full destination is a deliberate per-link reveal
  (`GET /admin/api/links/<code>/url`). JSON export confirms first. Short codes
  are no longer auto-linked in the table.

### Fixed

- An explicit `/admin?token=` login now takes precedence over an existing
  cookie, so a stale or wrong cookie can't lock you out.

### Added

- `ROADMAP.md` -- the headline item is an instance whose operator genuinely
  cannot read the shared collections; also the MySQL/MariaDB store backend for
  Node 20 hosts.

## [0.2.0] - 2026-09-01

### Added

- **`/admin` panel** -- token-gated (`SHORTENER_ADMIN_TOKEN`; unset = the whole
  tree 404s and is not discoverable). Link table with soft-delete revoke (the
  row stays, the link 404s), hard delete, manual + vanity-slug link creation,
  a host-allowlist editor (rewrites `SHORTENER_HOSTS_FILE`, hot-reload), and
  aggregate redirect analytics. One self-contained HTML page, no build step, no
  external requests.
- **Redirect analytics** (`src/analytics.mjs`) -- per-day hit / create / reject
  counters, hits by code, referrer *host* (never the path), reject reasons, and
  a recent-events ring. Persisted as flat JSON. `SHORTENER_ANALYTICS=0` off.
- Store backends gain `revoke` / `unrevoke` / `list` and a `lastHit` field.
- `PRIVACY.md`; a MySQL/MariaDB backend on the roadmap.

## [0.1.0] - 2026-09-01

Initial release.

- `POST /api/shorten` and the `GET /new?url=` compat shim; `GET /:code` -> 302
  (HTML meta-refresh for very long targets); `GET /api/health`.
- Two code styles: `code` (random base-56) and `words` (adjective-adjective-noun).
- Accepts multi-kilobyte links via POST body or a large GET; raised
  `maxHeaderSize`; a clean 431 for an over-long `GET /new`.
- **Host allowlist** (`SHORTENER_HOSTS` / `SHORTENER_HOSTS_FILE`) -- the service
  only redirects to allow-listed viewer hosts, which keeps it off the phishing
  radar. `localhost` always allowed for local testing.
- Link de-duplication (same URL -> same code). Optional per-link TTL. Per-IP
  creation rate limit. Optional redirect log with truncated IPs, off by default.
- File (JSON) or `node:sqlite` storage backend. Zero npm dependencies.
- Cloudflare Worker port in `deploy/`; `install.sh` (systemd) and `install.ps1`
  (Windows) installers; `install-autoupdate.sh` (systemd timer) and
  `backup.sh`.
