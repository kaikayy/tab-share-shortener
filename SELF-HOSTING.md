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

Run it under systemd / pm2 / a container so it restarts. A ready-to-edit unit
is in [`deploy/tab-share-shortener.service`](deploy/tab-share-shortener.service):

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

Default is one JSON file (`data/links.json`), rewritten atomically after each
change. Fine into the tens of thousands of links. **Back it up** -- losing it
404s every short link. For more volume, replace `src/store.mjs` (its surface is
just `get / has / put / delete / bumpHits / stats`) with SQLite or Redis; the
rest of the service doesn't change.

### Keeping it from becoming a phishing tool

Leave `SHORTENER_HOSTS` set to your viewer host(s). With that allowlist in
place the service can only ever redirect to your own Tab Share viewer, so it's
not useful to abuse. If you clear it ("open mode"), put auth or an IP allowlist
in front and expect to handle takedown requests.

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
