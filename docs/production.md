# Production notes

Deploy one Pi process behind HTTPS first. Keep the node port private, use the supplied resource limits, and test with a staging domain before pointing pi.sg at it.

## Before launch

- Build the container and check that it starts with its read-only filesystem. Check the health endpoint and clean shutdown.
- Verify the public origin, both alphabets, previews on and off, and long escaped Unicode paths through the actual proxy. Don't rewrite paths or cache link responses.
- Test a burst of requests within the container limits. Check aggregate CPU, memory, latency, 429s, and 503s. Worker heap limits do not include native allocations.
- Keep proxy and hosting logs free of request paths, bodies, and referrers. Encoded paths still contain the destination.
- Tag each release image before replacing it. Keep the previous image for rollback and preserve codec/model files indefinitely.
- For a compression rollback, set `PI_PREDICTION_ENCODE=0` and recreate the app. This keeps the `n/o` decoders while using the previous encoders. An older image without those decoders would break newly shared links.

## Bot protection

Start without a CAPTCHA on shared links. The app already bounds worker time, memory, queues, and extra-compression request rate. These limits contain work; they aren't DDoS protection. Add traffic limits at the hosting edge if needed, using aggregate status counts instead of URL logs.

If extra compression is abused, use ALTCHA only for that optional feature:

1. Use ALTCHA's official widget and server library. Add a rate-limited challenge endpoint and load the widget beside “Extra compression” only when required, keeping the browser result copyable.
2. Verify the signed proof, expiry, and purpose on the server before admitting `/api/compress`. A browser-only checkbox doesn't protect an API.
3. Give each proof one use. Keep only expiring challenge IDs, not URLs. Never evict unexpired entries to admit more work. If the replay store is memory-only, rotate the signing key on restart. Multiple instances need a shared store or separately scoped challenges. See ALTCHA's [security guide](https://altcha.org/docs/integration/security-recommendations/).
4. Test replay, expired proofs, parallel requests, slow phones, keyboard access, and blocked scripts. Failed verification should skip the extra pass, never block copying the browser link.

Anubis is better suited to a proxy-wide challenge. Its [default policies challenge browser traffic](https://github.com/TecharoHQ/anubis/blob/main/docs/docs/admin/policies.mdx), which would interrupt opening shared links. It also needs care with the extra-compression fetch, which currently sends no cookies and cannot answer an HTML challenge. Don't put its default policy in front of all Pi routes. If used later, deliberately exempt shared links and assets, handle its verification flow separately, and retain API rate limits.

Neither option can stop someone running the public encoder themselves or make a destination trustworthy. CAPTCHA integration is planned, not enabled.
