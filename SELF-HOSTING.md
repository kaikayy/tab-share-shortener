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

Re-run it to update -- config is read back from the existing unit, so a bare
`NONINTERACTIVE=1 bash deploy/install.sh` re-deploys cleanly. Preset any answer
via env to change it (`SHORTENER_BASE=... SHORTENER_HOSTS=... bash deploy/install.sh`).

### Auto-update on push

Run the shortener from a **git checkout** (a read-only [deploy
key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
is enough) and install a timer that pulls `main` and redeploys:

```bash
git clone git@github.com:kaikayy/tab-share-shortener.git ~/files/tab-share-shortener
cd ~/files/tab-share-shortener
bash deploy/install.sh            # first deploy (set SHORTENER_BASE=... SHORTENER_HOSTS=...)
bash deploy/install-autoupdate.sh # checks every 10 min; pass e.g. 1h to slow it down
```

[`deploy/auto-update.sh`](deploy/auto-update.sh) does nothing when the checkout
is already current; otherwise it **hard-resets to the upstream branch** (the
checkout is a deploy mirror, it carries no local commits) and re-runs
`install.sh` (which restarts the service). Hard-reset rather than merge so a
force-push upstream self-heals instead of wedging the timer. Watch it with
`journalctl --user -u tab-share-shortener-update.service -f`.

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
    # the compat GET endpoint puts the long link in the request line; the POST
    # endpoint puts it in the body -- raise the limits for whichever you use
    large_client_header_buffers 8 64k;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8779;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

On **Apache** (`mod_proxy`), the equivalents are `LimitRequestLine 65536` (for
the GET compat path) and `LimitRequestBody 2097152`, plus
`ProxyPass / http://127.0.0.1:8779/` and `RemoteIPHeader X-Forwarded-For`. A
KeyHelp box already runs Apache -- add these to the vhost include, not a fresh
`server {}`. Without them a big link gets a `414` (GET) or `413` (POST) from the
proxy before it reaches the service.

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

**Back up the store** either way -- losing it 404s every short link.
[`deploy/backup.sh`](deploy/backup.sh) copies `links.json` daily and keeps the
last 30; add it to cron:

```cron
15 4 * * *  bash "$HOME/files/tab-share-shortener/deploy/backup.sh"
```

For SQLite: `sqlite3 links.sqlite ".backup 'backup.sqlite'"` or just copy the
file (WAL makes a plain `cp` safe enough).

**On the roadmap -- a MySQL / MariaDB backend** for Node 20 boxes (KeyHelp,
cPanel) that can't run the Node 24 `sqlite` backend. Same `openStore()` surface:
`has / get / put / delete / bumpHits / findByUrl / revoke / unrevoke / list /
stats / flushSync / close` in [`src/store-file.mjs`](src/store-file.mjs), wired
into `src/store.mjs`. Details and the other roadmap items in
[`ROADMAP.md`](ROADMAP.md).

Identical links are **de-duplicated**: shortening the same URL twice returns the
same code (the response carries `"reused": true`).

### Link lifetime

A new short code stops resolving `SHORTENER_TTL_DAYS` days after it was created
(default **30**). This keeps unused links -- and the collection URLs stored with
them -- from piling up forever. The full share link the user also copied always
keeps working; only the short code is forgotten. Expired rows are dropped lazily
on read, on store load, and by an hourly sweep. `SHORTENER_TTL_DAYS=0` disables
default expiry. Callers pin an individual link with `POST /api/keep` (using the
`keepToken` from creation); operators pin or expire any link from `/admin`.

The expiry is computed once, at creation, from the `SHORTENER_TTL_DAYS` in effect
then. **Links already in the store when you upgrade to 0.3.0 (or that were made
while `SHORTENER_TTL_DAYS` was `0`) have no expiry and keep resolving** -- raising
the default only affects links created afterwards. To retro-fit an expiry onto
old links, use the admin panel's per-link *expire* button.

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

### Admin panel

`/admin` gives you a link table (with **revoke** -- a soft delete that 404s the
link but keeps the row -- and **bulk revoke / delete by filter**), manual/vanity
link creation, an editor for the host allowlist, and redirect analytics (daily
counts, busiest links, referrer *hosts*, **browser family + major version**, why
links were rejected), plus an on-request histogram of the **registrable domains**
people bundle (`reddit.com`, never the post -- computed when you click, kept
nowhere). It is one page, no build step, no external requests.

`GET /admin/metrics` serves the same numbers as Prometheus text (behind the same
token) -- point a scraper at `https://your-shortener/admin/metrics` with
`Authorization: Bearer <TOKEN>`.

The link table shows the **target host only**. Revealing a stored destination
(for a Tab Share link, the pages someone bundled) is a deliberate per-link
action, and the JSON export asks first. See [`ROADMAP.md`](ROADMAP.md) for where
this is headed -- an instance whose operator genuinely cannot read the shared
collections.

It is **off unless `SHORTENER_ADMIN_TOKEN` is set** -- with the token unset the
whole `/admin` tree returns 404 and is not discoverable. The installer
generates a token on first run and stores it in the systemd unit; to see it:

```bash
systemctl --user show tab-share-shortener -p Environment | tr ' ' '\n' | grep ADMIN
```

Sign in by visiting `https://your-shortener/admin?token=<TOKEN>` once (it sets
an `HttpOnly; Secure; SameSite=Strict` cookie), or send
`Authorization: Bearer <TOKEN>` for scripts. The token is compared in constant
time. Serve `/admin` over HTTPS only.

Analytics are aggregate-only -- no IPs, no geolocation, no cookies, no
per-visitor rows; referrer *host* (never the path) and browser *family + major
version* (never the full User-Agent) -- and live in `<store dir>/analytics.json`
(`SHORTENER_ANALYTICS=0` disables them, `SHORTENER_ANALYTICS_DAYS` sets the
retention, default 365). [`PRIVACY.md`](PRIVACY.md) has the full list of what a
running instance keeps, in plain terms -- worth reading if you run this for
other people. The allowlist editor needs `SHORTENER_HOSTS_FILE` set (the
installer points it at `<data dir>/allowed-hosts.txt`); without it the allowlist
view is read-only.

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

The **installer** seeds `<data dir>/allowed-hosts.txt` from `SHORTENER_HOSTS` on
first run and then points `SHORTENER_HOSTS_FILE` at it -- after that, manage the
list from the [admin panel](#admin-panel) (or edit the file; the server reloads
it on `SIGHUP` and whenever the panel saves).

### Running a shortener other people can use

You can also let other people route *their* self-hosted viewers through your
instance. Keep the list in `deploy/allowed-viewers.txt` (git-tracked in your
fork) and point `SHORTENER_HOSTS_FILE` at it. Self-hosters request an addition
with the **"Add my viewer host to the allowlist"** issue form; you verify the
URL serves the real viewer and merge the one-line change. No code deploy and no
restart -- send the process `SIGHUP` and it re-reads `SHORTENER_HOSTS_FILE` in
place (`systemctl reload` if you add `ExecReload=/bin/kill -HUP $MAINPID` to the
unit).

This is opt-in and up to each operator. The canonical instance run by the Tab
Share author currently serves **only its own viewer** (`kaikayy.github.io`);
accepting other people's viewers is planned, not yet live. Until then, run your
own instance -- it is a few minutes (see Path A above) and it always allows
your own viewer.

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
SHORTENER_BASE     = "https://tab-share-shortener.<you>.workers.dev"
SHORTENER_HOSTS    = "you.github.io"
SHORTENER_TTL_DAYS = "30"
```

`wrangler deploy` bundles `worker.js` + `worker-words.js` for you. Point a
route or custom domain at the Worker and update `SHORTENER_BASE` to match. KV
entries expire after `SHORTENER_TTL_DAYS` (default 30; `0` = never, and a
`ttlDays` in the POST body overrides it per link). The Worker has no `/admin`
and no `/api/keep` -- to pin a link, re-create it with `ttlDays: 0`. No rate
limiter in the Worker -- use a Cloudflare rate-limiting rule if you need one.

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
