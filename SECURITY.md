# Security

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- Use GitHub's [private vulnerability reporting](https://github.com/kaikayy/tab-share-shortener/security/advisories/new)
  ("Report a vulnerability" on the Security tab), or
- open an issue titled `security: contact request` with no details and a
  maintainer will reach out.

Expect a first response within a few days. This is a small project run in spare
time; there is no bounty, but fixes for real issues are prioritized and you will
be credited if you want.

## Scope

In scope:

- the Node service (`src/`) and the Cloudflare Worker port (`deploy/worker*.js`);
- the `deploy/` install and update scripts;
- the `/admin` panel and its auth.

Out of scope:

- the public `s.kaikay.de` instance's infrastructure (report those to the
  operator via the channels above);
- denial of service from traffic volume (put a rate limiter / CDN in front --
  `SHORTENER_RATE` and a reverse proxy are the built-in and recommended knobs);
- social-engineering a maintainer or the operator.

## What this service is designed to resist

- **Open-redirect abuse.** A link is only stored if its target host is on the
  allowlist (`SHORTENER_HOSTS` / `SHORTENER_HOSTS_FILE`). With the allowlist set
  to your viewer host(s), the service can only ever redirect there.
- **Admin discovery.** With `SHORTENER_ADMIN_TOKEN` unset the entire `/admin`
  tree returns 404. With it set, the token is compared in constant time and a
  wrong/absent token also 404s.
- **Header / body abuse.** Request size caps, a per-IP creation rate limit, and
  a bounded redirect log (truncated IPs, off by default).

It does **not** vet the *content* behind an allow-listed viewer host -- a link
can point at any tab collection someone chose to bundle. The viewer shows every
page plainly; nothing is hidden. Report abusive links via the channels above.
