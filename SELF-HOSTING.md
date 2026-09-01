# Self-hosting the shortener

Pick one of the two paths. Both end with you pasting one URL into Tab Share's
options.

---

## Path A -- Node on your own server

Prerequisites: **Node 20+**. No npm install (zero dependencies).

```bash
git clone https://github.com/kaikayy/tab-share-shortener
cd tab-share-shortener

SHORTENER_BASE=https://s.example.com \
SHORTENER_HOSTS=you.github.io \
SHORTENER_HOST=127.0.0.1 \
SHORTENER_PORT=8779 \
SHORTENER_TRUST_PROXY=1 \
node src/server.mjs
```

### Installer

[`deploy/install.sh`](deploy/install.sh) does the whole thing -- prompts for the
base URL / allowed hosts / port / backend, copies the source into place, writes a
systemd unit (system-wide as root, else a `--user` unit), and starts it:

```bash
sudo bash deploy/install.sh        # system service at /opt, runs as user `tabshare`
bash deploy/install.sh             # or a per-user service, no root
```

Re-run it to update. Preset any answer via env
(`SHORTENER_BASE=... SHORTENER_HOSTS=... bash deploy/install.sh`).

### Or by hand

A ready-to-edit unit is in
[`deploy/tab-share-shortener.service`](deploy/tab-share-shortener.service):

```bash
# per-user, no root:
mkdir -p ~/.config/systemd/user ~/tab-share-shortener/data
cp deploy/tab-share-shortener.service ~/.config/systemd/user/
# edit the paths + vars in that copy, then:
systemctl --user daemon-reload
systemctl --user enable --now tab-share-shortener
sudo loginctl enable-linger $USER   # optional: survive logout / reboot
```

Then a reverse proxy terminates HTTPS:

```nginx
server {
    server_name s.example.com;
    # the compat GET endpoint puts the long link in the request line
    large_client_header_buffers 8 64k;

    location / {
        proxy_pass http://127.0.0.1:8779;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Storage

Two built-in backends, same interface, selected by `SHORTENER_STORE_BACKEND`
(or inferred from the store path's extension):

| Backend | When | Notes |
|---|---|---|
| `file` (default) | local, small self-host | one JSON file, rewritten atomically after each change; whole table in memory. Fine into the tens of thousands of links. |
| `sqlite` | a real server | `node:sqlite` (built in, Node 24+), WAL mode. Durable per-write, scales far past the file backend, safe to copy for backups while running. Zero extra dependencies. |

```bash
SHORTENER_STORE_BACKEND=sqlite SHORTENER_STORE=/var/lib/tab-share-shortener/links.sqlite node src/server.mjs
```

**Back up the store file** either way -- losing it 404s every short link. For
SQLite: `sqlite3 links.sqlite ".backup 'backup.sqlite'"` or just copy the file
(WAL makes a plain `cp` safe enough; `.backup` is cleaner).

Need Redis / Postgres instead? Implement the surface in
[`src/store-file.mjs`](src/store-file.mjs) (`get / has / put / delete /
bumpHits / findByUrl / stats / flushSync / close`) and wire it into
`openStore()` in `src/store.mjs`. Nothing else changes.

Identical links are **de-duplicated**: shortening the same URL twice returns the
same code (the response carries `"reused": true`).

### Keeping it from becoming a phishing tool

Leave `SHORTENER_HOSTS` set to your viewer host(s). With that allowlist in
place the service can only ever redirect to your own Tab Share viewer, so it's
not useful to abuse. If you clear it ("open mode"), put auth or an IP allowlist
in front and expect to handle takedown requests.

### Access log (optional, off by default)

Out of the box the shortener writes **no per-request log** -- the redirect
endpoint never records who clicked a link.

Set `SHORTENER_LOG=1` (or a directory path) to turn on a minimal log: one JSON
line per redirect (`{ "t", "code", "ip" }`) in a per-day file under
`<store dir>/access-logs/`. The IP is **truncated before it is written** --
IPv4 loses its last octet (`203.0.113.47` -> `203.0.113.0`), IPv6 keeps only
its first three groups -- so a line identifies a network, not a person. Files
older than `SHORTENER_LOG_DAYS` (default 30) are deleted automatically.

For the truncated IP to be the visitor's (not your proxy's), also set
`SHORTENER_TRUST_PROXY=1` and have the proxy pass `X-Forwarded-For`.

---

## Using it with your own viewer

`SHORTENER_HOSTS` and `SHORTENER_HOSTS_FILE` decide which viewer hosts a link
may point at. To allow a self-hosted viewer, add its host:

```bash
SHORTENER_HOSTS=my-viewer.example.com node src/server.mjs
# or several:
SHORTENER_HOSTS=my-viewer.example.com,kaikayy.github.io node src/server.mjs
```

For a longer or growing list, keep it in a file (one host per line, `#`
comments allowed -- see [`deploy/allowed-viewers.example.txt`](deploy/allowed-viewers.example.txt))
and point `SHORTENER_HOSTS_FILE` at it. Both sources are merged.

```bash
SHORTENER_HOSTS_FILE=/etc/tab-share-shortener/allowed-viewers.txt node src/server.mjs
```

`localhost` / `127.0.0.1` (any port) are always allowed for local testing.

### Running a shortener other people can use

If you host an instance for others, keep the list in
`deploy/allowed-viewers.txt` (git-tracked in your fork) and point
`SHORTENER_HOSTS_FILE` at it. Self-hosters request an addition with the
**"Add my viewer host to the allowlist"** issue form; you verify the URL serves
the real viewer and merge the one-line change. No code deploy and no restart --
send the process `SIGHUP` and it re-reads `SHORTENER_HOSTS_FILE` in place
(`systemctl reload` if you add `ExecReload=/bin/kill -HUP $MAINPID` to the unit).

---

## Path B -- Cloudflare Worker + KV

Everything the Worker needs is in `deploy/`: `worker.js` (the service),
`worker-words.js` (wordlists, generated from `src/words.mjs` by
`npm run gen:worker` -- rerun and commit if you edit the lists), and
`wrangler.toml.example`.

```bash
git clone https://github.com/kaikayy/tab-share-shortener
cd tab-share-shortener/deploy

npx wrangler kv namespace create LINKS      # prints a namespace id
cp wrangler.toml.example wrangler.toml       # then paste the id + set the vars
npx wrangler deploy
```

`wrangler.toml` (see the example for the annotated version):

```toml
name = "tab-share-shortener"
main = "worker.js"
compatibility_date = "2024-11-01"

[[kv_namespaces]]
binding = "LINKS"
id = "<the id wrangler printed>"

[vars]
SHORTENER_BASE  = "https://tab-share-shortener.<you>.workers.dev"
SHORTENER_HOSTS = "you.github.io"
```

`wrangler deploy` bundles `worker.js` + `worker-words.js` for you. Point a
route or custom domain at the Worker and update `SHORTENER_BASE` to match. KV
values get a 1-year TTL (constant at the top of `worker.js`). No rate limiter
in the Worker -- use a Cloudflare rate-limiting rule if you need one.

Test the deployed Worker the same way as Path A (`curl .../api/health`, then
shorten and open a link).

---

## Connect Tab Share to it

Today, without any extension change, use the compat endpoint:

**Tab Share -> Options -> Shorten links -> Custom endpoint**

```
https://s.example.com/new?url=
```

For readable slugs:

```
https://s.example.com/new?mode=words&url=
```

Save, approve the one-time host-access prompt, optionally tick **Shorten
automatically**, and create a link to test. If it fails the popup shows why and
keeps the full link.

## The domain

Short links are only as short as the domain in front of them. In order of
preference:

- **A short domain you own** (`s.example.com`, or a dedicated 4-6 letter
  domain). Point an A/AAAA record at your server (Path A) or add it as a
  custom domain on the Worker (Path B), set `SHORTENER_BASE` to it, redeploy.
- **A subdomain of a domain you already own** -- zero extra cost, e.g.
  `go.yoursite.com`.
- **`*.workers.dev`** (Path B) -- free, works immediately, just long.

`SHORTENER_BASE` must exactly match the origin the links are served from
(scheme + host + optional port, no trailing slash), because the code builds
`${SHORTENER_BASE}/${code}` and also uses it for the self-redirect loop guard.

Whatever the domain, it must be HTTPS -- the Tab Share extension rejects a
non-HTTPS shortener endpoint (except `localhost` for testing).

## Verify

```bash
curl -s https://s.example.com/api/health
curl -s -X POST https://s.example.com/api/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://you.github.io/multi-link-share/#test","mode":"words"}'
# open the shortUrl -- it must land on your viewer with the #fragment intact
```
