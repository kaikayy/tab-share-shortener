# The shortener contract

What this service guarantees, and what any drop-in replacement (or the
Cloudflare Worker port) must also do. It mirrors
[`docs/CUSTOM-SHORTENER.md`](https://github.com/kaikayy/multi-link-share/blob/main/docs/CUSTOM-SHORTENER.md)
in the extension repo.

## Creating a short link

### Native -- `POST /api/shorten`

Request body, `application/json` (or `application/x-www-form-urlencoded`):

| field | required | |
|---|---|---|
| `url` | yes | the full `https://<viewer>/#<token>` link, fragment included |
| `mode` | no | `"code"` (default) or `"words"` |
| `ttlDays` | no | overrides `SHORTENER_TTL_DAYS`; `0` = never expires |

Response `201`:

```json
{ "code": "swift-amber-otter",
  "shortUrl": "https://s.example.com/swift-amber-otter",
  "mode": "words",
  "expires": null }
```

Errors: `400` bad/again-missing url or wrong scheme · `403` host not on the
allowlist · `413` url over `SHORTENER_MAX_URL` · `429` rate limited ·
`503` code space exhausted.

### Compat -- `GET /new?url=<percent-encoded link>&mode=<code|words>`

This is the shape the Tab Share extension's **custom endpoint** field already
produces (`<endpoint>` + `encodeURIComponent(link)`). Returns the bare short
URL as `text/plain`, `200`. Same validation and errors (as plain text).

> The long link rides in the query string here, so the request line can be
> 10 KB+. This server raises Node's `maxHeaderSize` to accept it; a reverse
> proxy in front of it needs the same (`large_client_header_buffers` on nginx).
> Prefer `POST` when you control the caller.

## Redirecting -- `GET /:code`

- **`302`** with `Location: <the exact stored URL>` and `Cache-Control: no-store`.
- The stored URL is kept **verbatim** -- the `#fragment` is never normalised,
  re-encoded, or stripped. The whole Tab Share collection lives after the `#`.
- If the target URL is longer than `SHORTENER_META_REFRESH_OVER` (7000 by
  default), the response is instead `200 text/html` with
  `<meta http-equiv="refresh">` + a JS `location.replace` + a plain link --
  because some proxies cap response headers near 8 KB.
- Unknown or expired code -> `404`.
- `Referrer-Policy: no-referrer` so the target host isn't leaked the short URL.

## Rules a target URL must satisfy

1. Parseable as a URL.
2. `https:` scheme (except `http://localhost` / `127.0.0.1` for testing).
3. Host (with port) on `SHORTENER_HOSTS`. `localhost` / `127.0.0.1` are always
   allowed. An empty `SHORTENER_HOSTS` disables the check ("open mode") -- only
   safe behind auth or a trusted network.
4. Not already a link on this shortener's own host (loop guard).
5. At most `SHORTENER_MAX_URL` bytes (256 KB default).

## CORS

All responses carry `Access-Control-Allow-Origin: *` and answer `OPTIONS`
preflights. In MV3 the extension is granted host access to the endpoint origin,
so the `fetch` usually skips preflight anyway.

## What the operator can see

Every stored link contains every page URL in the collection (in the `#`
fragment). Password-protected Tab Share links (`E1.` tokens) are encrypted
client-side, so the operator sees only ciphertext for those. The redirect
endpoint also sees the recipient's IP -- set a logging/retention policy.
