# Working on Pi

Pi is a small link compressor. Keep it that way.

- Use plain HTML, CSS, and JavaScript. Don't add a framework for a small change.
- Keep the interface simple and the copy short, informal, and accurate.
- Don't use em dashes in interface copy, page titles, or project prose. Preserve submitted URLs exactly, including any punctuation they contain.
- Prefer straightforward functions and readable code. Comment on why something is needed, not what the next line does.
- Don't add design briefs, task logs, progress reports, or benchmark dumps to the app. Keep experiments outside the working tree or in the ignored `archive/` directory.
- Don't claim the code was written by hand or invent a project backstory.

## Layout

- `public/`: homepage, preview, error and privacy pages, shared styles, and brand files.
- `src/`: browser app, server helpers, workers, and codec selection.
- `codecs/`: compression formats and their decoders.
- `models/`: fixed model data and checksums.
- `test/`: correctness tests and saved link fixtures.
- `docs/`: link format and production notes.
- `.forgejo/workflows/ci.yml`: formatting and test checks for pushes and pull requests.
- `server.mjs` and `build.mjs`: server and browser build.
- `Dockerfile`, `compose*.yaml`, and `Caddyfile`: production image and proxy setup.
- `CLAUDE.md`: a symlink to this file. Keep shared project instructions here.

## Keep these working

- A link must unpack to the exact original URL. Keep query order, repeated keys, escaping, and fragments intact.
- Keep old decoders, transport alphabets, root order, and model data. Don't change the meaning of an existing format marker. A new format needs its own marker, version, or disjoint transport namespace.
- Always return an encoded link, even when it's longer. Show the actual character difference.
- Keep both Unicode and ASCII modes. Extra server compression may replace the browser result only when it's shorter.
- Every encoded Pi link must show the destination before opening. A trailing `~` remains accepted for compatibility but does not change the behavior. Never restore automatic redirects.
- Don't store submitted URLs, fetch their destinations, add accounts, cookies or analytics, or remove worker deadlines and size limits.
- Keep `public/privacy.html` and the production notes accurate when data handling, logging, hosting, or security behavior changes.
- Keep required dependency and dataset notices.

## Research safely

- If `archive/live-research/README.md` exists, read it before starting compression research. It records the current baseline, active experiment, and closed directions.
- Record each experiment's hypothesis, pass threshold, evidence, and decision in that ledger as soon as the result is known.
- Keep one compression experiment active at a time. Start with at most three research subagents, give each a distinct question, and close them after recording their findings.
- Training is allowed, but run only one local training or benchmark job at a time. Subagents must share this limit and may not start compute jobs unless they are explicitly assigned one.
- This Mac has 12 CPU cores and 24 GB of memory. Start with at most 6 CPU threads, `nice -n 10`, an 8 GB process memory limit, and a hard wall-time limit. Keep at least 6 GB of memory available for the system.
- Test each new model shape and batch size for two minutes, then run a 15-minute pilot. Continue a longer run only after the pilot shows stable memory use, useful learning progress, and a reasonable completion estimate.
- MPS is allowed only after the same job passes a CPU smoke test. Use a small batch first, monitor unified memory during the pilot, and stop immediately if the interface begins to lag or memory pressure leaves the green state.
- Prefer papers, source inspection, and small deterministic simulations before training. Increase a proven job's limits gradually instead of starting at full scale.

## Check your changes

Run `npm run check` and `npm test`. For UI changes, also check the homepage, privacy page, and link preview at desktop and phone widths. Check both format options and copying. `npm start` builds and serves Pi at `http://127.0.0.1:8788`. Restart it after editing server files or static assets.

Use the saved fixtures to catch regressions; don't regenerate them just to make a failing test pass. Historical code and measurements are in `archive/before-cleanup/` if you need to trace a decision.

For production, follow `docs/production.md`. Build an image tagged with the exact short commit, test it before replacing the live container, and keep the previous image and release for rollback. After deployment, check `/health`, `/privacy`, both link formats, extra compression, and the destination preview through `https://pi.sg`.
