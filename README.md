# pi.sg

A cool link compressor that doesn't store your links.

Paste a URL and copy the result. The destination lives inside the link, so there's no account or link database.

- Unicode makes shorter-looking links. ASCII works better in apps that struggle with Unicode URLs.
- “Show destination first” is on by default. Untick it for a direct redirect. The preview adds one `~`; existing links still work as before.
- Extra compression asks the server to try a few more methods. It only replaces the browser result if it's shorter. Untick it to keep creation in your browser.
- Some URLs get longer. Pi always shows the actual difference, including the preview marker.

Pi doesn't visit destinations or log submitted URLs. This isn't encryption: anyone with a link can unpack it. The preview doesn't check whether a site is safe.

## Run locally

Use Node 26.5 or newer. The container pins Node 26.8.1.

```sh
npm ci
npm start
```

Open [localhost:8788](http://127.0.0.1:8788). Restart after changing server files or static assets.

## Deploy

The included Docker Compose setup runs Pi behind Caddy with HTTPS. Pi runs as a non-root user with a read-only filesystem and resource limits. Its port isn't exposed to the internet. No database or volume is needed for links; Caddy's volumes hold certificates and configuration.

1. Put the project on a Linux server with Docker Compose. Run `npm ci && npm test` before releasing.
2. Point `pi.sg` at the server and allow ports 80 and 443. Set `PI_APP_DOMAIN` to use a staging domain first.
3. Run `docker compose config --quiet`, then `docker compose up -d --build`.
4. Check `/health`, copy and open both link formats, and check previews on a phone. Test long Unicode links through the actual proxy before opening the site to traffic.

Keep the previous image for rollback. Back up the Caddy certificate volume and keep every codec and model when updating; old links depend on them.

With an existing proxy on `proxy_net`, start only the app:

```sh
docker compose -p pi-compressor -f compose.yaml -f compose.proxy.yaml up -d --build app
```

Point the proxy at `pi-compressor:8788`. Let the app set its Content Security Policy; a policy from a static landing page will block the compressor. Disable CDN request logging and cache overrides for link responses, and purge the old site when switching over.

Without Docker, build once with `npm ci && npm run build`, then run `node server.mjs` under a service manager behind an HTTPS proxy:

| Variable        | Default          | Purpose                                                                    |
| --------------- | ---------------- | -------------------------------------------------------------------------- |
| `PI_APP_PORT`   | `8788`           | HTTP port                                                                  |
| `PI_APP_HOST`   | `127.0.0.1`      | Listening address; use `0.0.0.0` only inside an isolated container/network |
| `PI_APP_ORIGIN` | Listening origin | Public origin, such as `https://pi.sg`; required behind HTTPS              |

Don't rewrite or decode the compressed path at the proxy. Don't cache redirects, previews, or API responses. Static files support gzip, Brotli, and conditional caching. The Caddyfile disables request logging; keep URL paths, bodies, and referrers out of any CDN or hosting logs too.

## Bot protection

No CAPTCHA is enabled. Start with the existing work limits and add edge rate limits if needed. If the extra-compression API is abused, add ALTCHA there without blocking browser compression or shared links. Anubis needs custom routing and changes to the current cookie-free API request.

The [production notes](docs/production.md) cover the launch checks and integration plan, including proof verification, expiry, and replay protection.

## Development

```sh
npm test
npm run format
```

`public/` holds the pages, `src/` the app and server helpers, and `codecs/` the formats. Keep the [format rules](docs/format.md), saved link fixtures, and model checksums intact. Dependency and dataset credits are in [NOTICE.md](NOTICE.md).
