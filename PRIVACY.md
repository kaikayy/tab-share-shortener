# Privacy -- Tab Share shortener

_Last updated: 2026-09-02 (0.2.1)_

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

On each redirect the server keeps:

- a **hit count** per short code, and the time of the last hit;
- aggregated **by calendar day**: the number of redirects, and a tally of the
  **host that referred each click** (for example `news.ycombinator.com`, or
  `(direct)` when the browser sends no referrer). The full referring URL, the
  page path and query string are **not** kept.
- day totals of links created and of rejected shorten attempts (with the
  reason, e.g. `host_not_allowed`);
- a rolling list of roughly the last 500 events -- each one a timestamp, an
  event type, a short code, and a referrer host or a reject reason.

**Not recorded:** IP addresses, user agents, geolocation, any per-visitor or
per-device identifier, any cookie. The redirect response sets no cookie and
carries `Referrer-Policy: no-referrer`.

This data is retained for about **365 days**, then the old daily buckets are
dropped. It is visible only to the operator, through a password-gated admin
page (`/admin`). There is no third-party analytics, no ad or tracking code, and
none of it is shared or sold.

## Access logs

Off by default. If the operator sets `SHORTENER_LOG`, one line per redirect is
written to a local file with a **truncated** IP (IPv4 loses its last octet,
IPv6 keeps only its first three groups -- a network, not a person) and is
deleted after `SHORTENER_LOG_DAYS` (default 30). The `s.kaikay.de` instance
runs with this **off**.

## Self-hosting controls

| Setting | Effect |
| --- | --- |
| `SHORTENER_ANALYTICS=0` | no redirect analytics at all (no counts, no referrers, no event list) |
| `SHORTENER_COUNT_HITS=0` | keep analytics off the read path entirely; no per-link hit counter |
| `SHORTENER_ANALYTICS_DAYS=N` | change the retention window from 365 days |
| `SHORTENER_LOG` unset | no per-request access log (the default) |
| `SHORTENER_ADMIN_TOKEN` unset | the `/admin` panel is disabled and returns 404 |

## Contact

Open an issue at
<https://github.com/kaikayy/tab-share-shortener/issues>.
