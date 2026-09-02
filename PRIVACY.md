# Privacy -- Tab Share shortener

_Last updated: 2026-09-02 (0.2.2)_

This covers the **first-party instance at `s.kaikay.de`**, run by the Tab Share
author. If you [self-host](SELF-HOSTING.md) the shortener, you are the operator
and every setting below is yours to change or switch off.

Using the shortener is opt-in: a Tab Share user has to choose *Tab Share
shortener* in the extension's options and turn it on. Until then, `s.kaikay.de`
receives nothing.

## What is stored when a link is created

- **The long URL you shortened**, keyed by the short code, so the short link can
  redirect to it. For a Tab Share link this URL contains every page URL and
  title in the collection, in its `#` fragment. Any shortener you send a link to
  necessarily stores its destination -- pick one you trust, or run your own.
  In the admin panel the link list shows only the **target host**; seeing a
  full destination is a deliberate one-link action. But the URL is stored in
  full on the server (it has to be, to redirect), so the operator *can* read it
  if they choose to. Making an instance where the operator genuinely cannot is
  on the [roadmap](ROADMAP.md).
- The code's **style** (`code` or `words`), its creation time, and an optional
  expiry.
- Nothing about who created it: no account, no IP, no cookie.

Identical URLs are de-duplicated, so re-shortening the same link returns the
same code rather than storing it twice.

## What is recorded when a short link is opened

On each redirect the server keeps, all of it **aggregate** -- day-level
counters, nothing tied to a person:

- a **hit count** per short code, and the time of the last hit;
- aggregated **by calendar day**: the number of redirects; a tally of the
  **host that referred each click** (for example `news.ycombinator.com`, or
  `(direct)` when the browser sends no referrer -- never the full referring
  URL, path or query); and a tally of the visitor's **browser family and major
  version** reduced from the User-Agent header (for example `Firefox 130`,
  `Chrome 141`, `bot / preview`) -- never the full User-Agent, the OS, the
  device, or the exact version;
- day totals of links created and of rejected shorten attempts (with the
  reason, e.g. `host_not_allowed`);
- a rolling list of roughly the last 500 events -- each one a timestamp, an
  event type, a short code, and a referrer host or a reject reason.

**Never recorded:** your **IP address**, **geolocation**, the full User-Agent,
the OS or device, any **cookie**, and any per-visitor or per-device identifier
or fingerprint. The redirect response sets **no cookie** and carries
`Referrer-Policy: no-referrer` (so the destination site does not learn where the
click came from either). There is **no third-party analytics, no advertising or
tracking code** of any kind, first-party or otherwise.

This data is retained for about **365 days**, then the old daily buckets are
dropped. It is visible only to the operator, through a password-gated admin
page (`/admin`).

### We will never sell your data

None of this -- the stored links, the aggregate counters, anything -- is ever
sold, rented, or shared with third parties for advertising, marketing, or
analytics. There is no business model here to make that tempting; it is a small
service run at cost. The only disclosure that could ever happen is a specific,
lawful legal demand, and there is very little to disclose.

## Aggregate view of what is shared (on request)

The admin panel can, **when the operator clicks a button**, decode every stored
link and show a histogram of the **registrable domains** of the bundled pages
(`reddit.com`, `github.com`, `wikipedia.org`) -- never the specific page, post,
or query. This is computed on the spot and **kept nowhere**; nothing about page
contents is logged or retained. Password-protected collections cannot be
decoded and are only counted. Making an instance where the operator genuinely
cannot do even this is on the [roadmap](ROADMAP.md).

## Access logs

Off by default. If the operator sets `SHORTENER_LOG`, one line per redirect is
written to a local file with a **truncated** IP (IPv4 loses its last octet,
IPv6 keeps only its first three groups -- a network, not a person) and is
deleted after `SHORTENER_LOG_DAYS` (default 30). The `s.kaikay.de` instance
runs with this **off**.

## Self-hosting controls

| Setting | Effect |
| --- | --- |
| `SHORTENER_ANALYTICS=0` | no redirect analytics at all (no counts, no referrer/browser tallies, no event list) |
| `SHORTENER_COUNT_HITS=0` | keep analytics off the read path entirely; no per-link hit counter |
| `SHORTENER_ANALYTICS_DAYS=N` | change the retention window from 365 days |
| `SHORTENER_LOG` unset | no per-request access log (the default) |
| `SHORTENER_ADMIN_TOKEN` unset | the `/admin` panel is disabled and returns 404 |

## Contact

Open an issue at
<https://github.com/kaikayy/tab-share-shortener/issues>.
