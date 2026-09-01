# Self-hosting the shortener

Pick one of the two paths. Both end with you pasting one URL into Tab Share's
options.

---

## Path A — Node on your own server

Prerequisites: **Node ≥ 20**. No npm install (zero dependencies).

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

Run it under systemd / pm2 / a container so it restarts. Then a reverse proxy
terminates HTTPS:

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
change. Fine into the tens of thousands of links. **Back it up** — losing it
404s every short link. For more volume, replace `src/store.mjs` (its surface is
just `get / has / put / delete / bumpHits / stats`) with SQLite or Redis; the
rest of the service doesn't change.

### Keeping it from becoming a phishing tool

Leave `SHORTENER_HOSTS` set to your viewer host(s). With that allowlist in
place the service can only ever redirect to your own Tab Share viewer, so it's
not useful to abuse. If you clear it ("open mode"), put auth or an IP allowlist
in front and expect to handle takedown requests.

---

## Path B — Cloudflare Worker + KV

```bash
npm create cloudflare@latest tab-share-shortener   # "Hello World" Worker
cd tab-share-shortener
npx wrangler kv namespace create LINKS
```

`wrangler.toml`:

```toml
main = "src/index.js"
compatibility_date = "2024-11-01"

[[kv_namespaces]]
binding = "LINKS"
id = "<the id wrangler printed>"

[vars]
SHORTENER_BASE  = "https://s.example.com"
SHORTENER_HOSTS = "you.github.io"
```

```bash
cp deploy/cloudflare-worker.js src/index.js
# paste the full wordlists from src/words.mjs into src/index.js
npx wrangler deploy
```

Point a route / custom domain at the Worker. KV values get a 1-year TTL by
default (edit in the file).

---

## Connect Tab Share to it

Today, without any extension change, use the compat endpoint:

**Tab Share → Options → Shorten links → Custom endpoint**

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

## Verify

```bash
curl -s https://s.example.com/api/health
curl -s -X POST https://s.example.com/api/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://you.github.io/multi-link-share/#test","mode":"words"}'
# open the shortUrl — it must land on your viewer with the #fragment intact
```
