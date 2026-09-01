# Working on Pi

Pi is a small link compressor. Keep it that way.

- Use plain HTML, CSS, and JavaScript. Don't add a framework for a small change.
- Keep the interface simple and the copy short, informal, and accurate.
- Don't use em dashes in interface copy, page titles, or project prose. Preserve submitted URLs exactly, including any punctuation they contain.
- Prefer straightforward functions and readable code. Comment on why something is needed, not what the next line does.
- Don't add design briefs, task logs, progress reports, or benchmark dumps to the app. Keep experiments outside the working tree or in the ignored `archive/` directory.
- Don't claim the code was written by hand or invent a project backstory.

## Layout

- `public/`: page, styles, and icon.
- `src/`: browser app, workers, HTTP handling, and codec selection.
- `codecs/`: compression formats and their decoders.
- `models/`: shared model data and checksums.
- `test/`: correctness tests and saved link fixtures.
- `server.mjs` and `build.mjs`: server and browser build.

## Keep these working

- A link must unpack to the exact original URL. Keep query order, repeated keys, escaping, and fragments intact.
- Keep old decoders and model data. Don't change the meaning of an existing format marker. A new format needs its own marker or version.
- Always return an encoded link, even when it's longer. Show the actual character difference.
- Keep both Unicode and ASCII modes. Extra server compression may replace the browser result only when it's shorter.
- Keep confirmation optional and on by default for new links. A trailing `~` shows the destination; it is not part of the codec payload or a safety check. Existing links without it still redirect directly.
- Don't store submitted URLs, fetch their destinations, add analytics, or remove worker deadlines and size limits.
- Keep required dependency and dataset notices.

## Check your changes

Run `npm test`. For UI changes, also check the page at desktop and phone widths, both format options, and copying. `npm start` builds and serves it at `http://127.0.0.1:8788`. Restart after editing server files or static assets.

Use the saved fixtures to catch regressions; don't regenerate them just to make a failing test pass. Historical code and measurements are in `archive/before-cleanup/` if you need to trace a decision.
