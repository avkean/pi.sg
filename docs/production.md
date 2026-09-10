# Production notes

Deploy one Pi process behind HTTPS first. Keep the node port private, use the supplied resource limits, and test with a staging domain before pointing pi.sg at it.

## Before launch

- Build the container and check that it starts with its read-only filesystem. Check the health endpoint and clean shutdown.
- Deploy the new image once with `PI_PREDICTION_ENCODE=0`. Verify that saved MIXFRAME links open correctly before the server creates any new ones. Then enable MIXFRAME in a second deployment.
- Verify the public origin, dense ASCII punctuation, long escaped Unicode paths, and mandatory previews through the actual proxy. Don't rewrite paths or cache link responses.
- Test a burst of requests within the container limits. Check aggregate CPU, memory, latency, 429s, and 503s. Worker heap limits do not include native allocations.
- Keep proxy and hosting logs free of request paths, bodies, and referrers. Encoded paths still contain the destination.
- Confirm Bunny access logs and extended logs are off, log forwarding is disabled, and IP anonymisation is on.
- Tag each release image before replacing it. Keep the previous image for rollback and preserve codec/model files indefinitely.
- For a compression rollback, set `PI_PREDICTION_ENCODE=0` and recreate the app. This stops issuing mixed links while keeping their decoder. Keep the decoder-only image as the oldest rollback target because older images cannot open MIXFRAME links.

## Edge limits

The limits inside Pi protect its workers, but they do not replace limits at the network edge. Set these starting limits with [Bunny Shield rate limiting](https://docs.bunny.net/api-reference/shield/ratelimits/patch-shieldrate-limit):

- `POST /api/compress`: 20 requests per minute per client, with a 60 second block.
- Encoded link paths: 120 requests per minute per client, with a 60 second block. Exclude the homepage, `/health`, `/privacy`, static assets, and the model file.

Return `429 Too Many Requests` instead of showing a challenge on shared links. Check aggregate 429 counts and latency, then adjust the limits if normal users are being blocked. Do not forward full request addresses to a logging service because an encoded path contains the destination.

Block direct access to the origin so the edge rules cannot be bypassed. Have Bunny replace a private request header and require that header at the origin proxy. Keep the value outside this repository and rotate it if it leaks.

`/health` returns only `ok`, so it may stay public for outside uptime checks. Exclude it from encoded-link rate limits. Keep the Node port itself private.

## Compose with an existing proxy

`compose.proxy.yaml` is an override for `compose.yaml`, not a standalone file. Build one image and use that same image for both rollout steps:

```sh
PI_RELEASE=$(git rev-parse --short=12 HEAD)
docker build --pull --tag pi-compressor:$PI_RELEASE .

PI_PREDICTION_ENCODE=0 PI_RELEASE=$PI_RELEASE docker compose \
  -f compose.yaml -f compose.proxy.yaml \
  up -d --no-build app
```

Check `/health`, the homepage, and saved MIXFRAME links while encoding is off. If they work, enable the encoder without changing the image:

```sh
PI_PREDICTION_ENCODE=1 PI_RELEASE=$PI_RELEASE docker compose \
  -f compose.yaml -f compose.proxy.yaml \
  up -d --no-build app
```

Check both link formats, extra compression, and the destination preview. Keep this image as the oldest rollback target after it has issued MIXFRAME links.

## Continuous integration

The workflow in `.forgejo/workflows/ci.yml` installs locked dependencies, checks formatting, and runs the full test suite. [Forgejo Actions](https://forgejo.org/docs/latest/user/actions/quick-start/) and a runner still need to be enabled once for the repository. Use an isolated runner for this public repository rather than the production server.

## Monitoring

Use one outside check against a saved Pi link that points to `https://example.com`. It should return the preview page and contain `Open this link?`. Alert after two failed checks so a brief deploy does not page anyone.

## Bot protection

Start without a CAPTCHA. If `/api/compress` is measurably abused after edge limits are active, protect that endpoint with ALTCHA. Never put a challenge in front of shared links.

## Brand assets

`public/avkean_dark.svg` and `public/avkean_light.svg` are the full Avkean Systems
logos from the production pack. Names refer to lettering colour. All four pages
link the logo to `https://avkean.com/`. Preserve its aspect ratio and display it
at 320 CSS pixels where space allows. The homepage footer wraps on small screens.
Update the asset version in all four HTML pages and its exact routes in
`server.mjs` when replacing the artwork so cached copies refresh.
