# Contributing

Small project, simple rules.

- **Questions / ideas** -> [Discussions](https://github.com/kaikayy/tab-share-shortener/discussions).
- **Bugs** -> an issue (there's a template).
- **Security** -> [SECURITY.md](SECURITY.md), privately.

## Working on it

```bash
npm test            # store + Node server + Worker checks, no network
npm run dev         # local instance on :8779
npm run gen:worker  # regenerate deploy/worker-words.js after editing src/words.mjs
```

- **No npm dependencies.** The only vendored code is `src/lib/` (lz-string +
  the Tab Share share-codec). Keep it that way unless there's a very good reason;
  a runtime dependency needs to be discussed first.
- **`npm test` must stay green.** Add a check for anything you change in
  `src/`. All three suites run offline.
- Match the existing style: small modules, JSDoc on the public surface, bound
  SQL parameters only, ASCII punctuation in comments and docs.
- The Node server (`src/server.mjs`) and the Cloudflare Worker
  (`deploy/worker.js`) share a contract -- see [CONTRACT.md](CONTRACT.md). A
  behaviour change usually needs to land in both, with matching tests.

## Pull requests

One change per PR, a description of what and why, tests included. By
contributing you agree your work is licensed under **AGPL-3.0-only**, same as
the project.
