# Tab Share link shortener

![Tab Share link shortener -- one short link for a whole tab collection](assets/promo-banner-shortener.png)

A tiny, self-hostable shortener for [Tab Share](https://github.com/kaikayy/multi-link-share)
links -- the ones that carry a whole tab collection in the URL `#fragment` and
can run to several kilobytes.

Part of the **Tab Share suite**: the companion to the
[Tab Share browser extension](https://github.com/kaikayy/multi-link-share)
([Chrome Web Store](https://chromewebstore.google.com/detail/meieckangeakbekjbijbgfkkelneplfe)),
which packs a group of tabs into one link that **opens in any browser with no
extension**. This service shortens that link -- and because it just redirects to
the viewer, the short URL opens the same way, no extension either. (The
extension links here from **Options -> Shorten links**, where *Tab Share
shortener* is the recommended provider.)

- **Any length.** A 40-page collection is ~4 KB; a 100-page encrypted one ~6 KB.
  This service takes it (POST body, or a large GET) where TinyURL / is.gd choke.
- **Two code styles.**
  - `code` -- short and random: `s.example.com/k7Rm2pq`
  - `words` -- readable, Twitch-clip style: `s.example.com/swift-amber-otter`
- **No account, aggregate-only stats.** By day: per-link hit counts, the
  referring host of each click, and the visitor's browser family + major version
  -- **no IP, no geolocation, no full User-Agent, no cookies, no third-party
  trackers, never sold.** See [PRIVACY.md](PRIVACY.md); turn it all off with
  `SHORTENER_ANALYTICS=0`. Identical links are de-duplicated.
- **Optional admin panel** at `/admin` (token-gated, off by default): link
  table (target **host only**; a destination is revealed one link at a time),
  revoke, manual/vanity links, host-allowlist editor, the analytics above, and
  an on-request histogram of the *domains* people bundle (`reddit.com`, never
  the post). See [SELF-HOSTING.md](SELF-HOSTING.md#admin-panel).
- **Not an open redirector.** It only shortens links pointing at a host on its
  allowlist (your Tab Share viewer), which is what keeps it off the phishing radar.
- **No npm dependencies.** Plain Node 20+ (24+ for the SQLite backend). Storage
  is a JSON file or `node:sqlite`, both built in. Vendors two files in
  [`src/lib/`](src/lib/) -- lz-string (MIT) and the Tab Share share-codec
  (AGPL-3.0, same project) -- used to decode a link's bundled-page domains for
  the admin histogram. A Cloudflare Worker port and Linux / Windows installers
  are in [`deploy/`](deploy/).

Licensed **AGPL-3.0-only** (it's a network service -- same terms as Tab Share).

## Run it locally

```bash
npm test          # store + Node server + Worker checks, no network
npm run dev       # http://localhost:8779, accepts localhost:8777 + kaikayy.github.io targets
npm run gen:worker  # regenerate deploy/worker-words.js after editing src/words.mjs
```

```bash
# shorten something
curl -X POST localhost:8779/api/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://kaikayy.github.io/multi-link-share/#NoZg...","mode":"words"}'
# -> {"code":"swift-amber-otter","shortUrl":"http://localhost:8779/swift-amber-otter",...}
```

## Wire it into the extension

Tab Share ships a built-in **Tab Share shortener** provider (Options -> Shorten
links) with a *Normal / Readable words* toggle. It's pre-filled with the
first-party public instance at **`https://s.kaikay.de`**, which allow-lists the
built-in viewer -- so the default setup needs no configuration. Off until you
turn it on; still opt-in per link.

> The public `s.kaikay.de` instance currently shortens links pointing at
> **`kaikayy.github.io` only** (the built-in viewer). If you run your own
> viewer, self-host the shortener too (below), or open an issue to have your
> host added to the public instance's allowlist.

To point it at your own instance, put its address in that same field. For a
local dev instance: `npm run dev` here, then set the address to
`http://localhost:8779` in a `DEV_LOCALHOST=1` extension build.

Native contract: `GET <address>/new?url=<enc>` (add `&mode=words`) -> the short
URL as plain text.

## How it compares

What each shortener keeps when someone opens a short link:

| Shortener | Logged on each click | Cookies / 3rd-party trackers | Data sold or shared |
| --- | --- | --- | --- |
| **this one** (`s.kaikay.de` or self-hosted) | aggregate day counts only: hits, referrer *host*, browser family + major version. No IP, no geolocation, no full User-Agent, no per-visitor row. | none | never |
| **da.gd** (built into the extension) | a hit counter; small open-source service, no ad or analytics scripts | none observed | no |
| **TinyURL** (built into the extension) | IP address, browser type + version, referring URLs, timestamps; forwards your **full referrer** to the destination | yes | not stated in its policy |
| **Bitly** (not offered) | per click: timestamp, IP, user-agent, country, city, device, browser, referring domain | yes | yes -- selling click analytics is a paid feature |

TinyURL / Bitly rows are summarised from their published policies and
independent testing as of 2026 and can change. Full detail for this one is in
[PRIVACY.md](PRIVACY.md).

## API

| Route | | |
|---|---|---|
| `POST /api/shorten` | `{ url, mode?, ttlDays? }` | `201 { code, shortUrl, mode, expires }` |
| `GET /new?url=<enc>&mode=` | compat shim | `200` `text/plain` short URL |
| `GET /:code` | | `302` to the target (HTML meta-refresh if the target is very long) |
| `GET /api/health` | | `200 { ok, store, allowedHosts, ... }` |
| `/admin`, `/admin/api/*` | `Bearer` / cookie token | panel + JSON API; `404` when `SHORTENER_ADMIN_TOKEN` is unset |

See [`CONTRACT.md`](CONTRACT.md) for the exact rules a response/redirect must
follow, and [`SELF-HOSTING.md`](SELF-HOSTING.md) to deploy.

## Configuration

Every knob is an env var -- full list and defaults in [`src/config.mjs`](src/config.mjs).
The ones you'll actually set:

| Env | Default | |
|---|---|---|
| `SHORTENER_BASE` | `http://localhost:8779` | public origin, no trailing slash |
| `SHORTENER_HOSTS` | `kaikayy.github.io` | comma list of allowed target hosts (empty = open mode) |
| `SHORTENER_HOSTS_FILE` | -- | newline-delimited host file, merged with `SHORTENER_HOSTS`; re-read on `SIGHUP` |
| `SHORTENER_LOG` | off | `1` or a dir: log redirects (truncated IP) to per-day files |
| `SHORTENER_PORT` / `SHORTENER_HOST` | `8779` / `127.0.0.1` | bind address |
| `SHORTENER_STORE` | `data/links.json` | store file path |
| `SHORTENER_STORE_BACKEND` | infer from path | `file` or `sqlite` (Node 24+) |
| `SHORTENER_TTL_DAYS` | `0` | default link lifetime (`0` = forever) |
| `SHORTENER_RATE` | `30` | creates per IP per minute (`0` = off) |
| `SHORTENER_TRUST_PROXY` | off | set `1` behind a reverse proxy to read `X-Forwarded-For` |
| `SHORTENER_ADMIN_TOKEN` | off | set a long random string to enable `/admin`; unset = the tree 404s |
| `SHORTENER_ANALYTICS` | `1` | `0` disables redirect analytics; `SHORTENER_ANALYTICS_DAYS` sets retention (365) |

## Contributing

Bugs -> an issue. Questions and ideas -> [Discussions](https://github.com/kaikayy/tab-share-shortener/discussions).
See [CONTRIBUTING.md](CONTRIBUTING.md). Version history in
[CHANGELOG.md](CHANGELOG.md).

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md) -- please report it
privately, not as a public issue.

## Support

If this project is useful to you, you can support development on Ko-fi:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/B3L1265MM0)
