# Tab Share link shortener

A tiny, self-hostable shortener for [Tab Share](https://github.com/kaikayy/multi-link-share)
links -- the ones that carry a whole tab collection in the URL `#fragment` and
can run to several kilobytes.

- **Any length.** A 40-page collection is ~4 KB; a 100-page encrypted one ~6 KB.
  This service takes it (POST body, or a large GET) where TinyURL / is.gd choke.
- **Two code styles.**
  - `code` -- short and random: `s.example.com/k7Rm2pq`
  - `words` -- readable, Twitch-clip style: `s.example.com/swift-amber-otter`
- **No account, no tracking beyond an optional hit counter.** Identical links
  are de-duplicated -- shortening the same URL twice returns the same code.
- **Not an open redirector.** It only shortens links pointing at a host on its
  allowlist (your Tab Share viewer), which is what keeps it off the phishing radar.
- **Zero dependencies.** Plain Node 20+ (24+ for the SQLite backend). Storage is
  a JSON file or `node:sqlite`, both built in. A Cloudflare Worker port and
  Linux / Windows installers are in [`deploy/`](deploy/).

Licensed **AGPL-3.0-only** (it's a network service -- same terms as Tab Share).

## Run it locally

```bash
npm test          # 27 checks (Node server + Worker), no network
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

## Wire it into the extension (local)

The service already speaks the extension's existing **custom endpoint** contract,
so no extension changes are needed to try it:

1. `npm run dev` here.
2. In Tab Share's **Options -> Shorten links -> Custom endpoint**, paste
   `http://localhost:8779/new?url=` and Save (approve the host prompt).
3. Optionally tick **Shorten automatically**.
4. Create a share link -- it comes back as `http://localhost:8779/<code>`.

For the readable mode over the compat endpoint, use
`http://localhost:8779/new?mode=words&url=`.

A native provider entry (and a mode toggle in the popup) is a follow-up change
in the extension repo -- see [`ROADMAP` in multi-link-share](https://github.com/kaikayy/multi-link-share/blob/main/ROADMAP.md).

## API

| Route | | |
|---|---|---|
| `POST /api/shorten` | `{ url, mode?, ttlDays? }` | `201 { code, shortUrl, mode, expires }` |
| `GET /new?url=<enc>&mode=` | compat shim | `200` `text/plain` short URL |
| `GET /:code` | | `302` to the target (HTML meta-refresh if the target is very long) |
| `GET /api/health` | | `200 { ok, store, allowedHosts, ... }` |

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
