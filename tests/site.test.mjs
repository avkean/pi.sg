import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const occurrences = (source, value) => source.split(value).length - 1;

test("production page preserves the approved content and semantics", () => {
  const html = read("public/index.html");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";

  assert.match(html, /<meta\s+charset="utf-8"\s*\/?>/i);
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"\s*\/?>/i);
  assert.match(html, /<title>pi\.sg \| an irrationally short URL\.<\/title>/);
  assert.doesNotMatch(html, /(?:—|&mdash;|&#(?:0*8212|x0*2014);?)/i);
  assert.match(html, /<meta\s+name="description"\s+content="An irrationally short URL\."\s*\/?>/);
  assert.match(html, /<link\s+rel="canonical"\s+href="https:\/\/pi\.sg\/"\s*\/?>/);

  assert.equal(occurrences(body, "π"), 1);
  assert.equal(occurrences(body, "an irrationally short URL."), 1);
  assert.equal(occurrences(body, "by avkean ↗"), 1);
  assert.match(html, /<main\b[^>]*class="page"[^>]*aria-labelledby="mark tagline"[^>]*>/);
  assert.match(html, /<h1\b[^>]*class="pi"[^>]*id="mark"[^>]*aria-label="Pi"[^>]*>π<\/h1>/);
  assert.match(html, /<p\b[^>]*class="tagline"[^>]*id="tagline"[^>]*>an irrationally short URL\.<\/p>/);
});

test("the attribution is a real, accessible same-tab link", () => {
  const html = read("public/index.html");
  const signatureTag = html.match(/<a\b(?=[^>]*class="signature")[^>]*>/i)?.[0] ?? "";

  assert.match(signatureTag, /href="https:\/\/avkean\.com\/"/);
  assert.doesNotMatch(signatureTag, /\btarget\s*=/i);
  assert.doesNotMatch(signatureTag, /\brel\s*=/i);
  assert.match(signatureTag, /aria-label="Visit avkean"/);
  assert.match(html, /min-width:\s*44px/);
  assert.match(html, /min-height:\s*44px/);
  assert.match(html, /\.signature\s*\{[^}]*justify-self:\s*start/s);
  assert.match(html, /\.signature:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor/s);
});

test("the page is flat, responsive, and has no runtime dependency", () => {
  const html = read("public/index.html");

  assert.match(html, /--paper:\s*#fff/);
  assert.match(html, /--ink:\s*#000/);
  assert.match(html, /@media\s*\(max-width:\s*700px\)/);
  assert.match(html, /min-height:\s*100dvh/);
  assert.doesNotMatch(html, /min-width:\s*320px/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /@import|<link\b[^>]*rel="stylesheet"|url\(\s*["']?(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /(?:box-|text-)?shadow\s*:|gradient\(|animation\s*:/i);

  const loadedUrls = [...html.matchAll(/\b(?:src|href)="(https?:\/\/[^\"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(loadedUrls.sort(), ["https://avkean.com/", "https://pi.sg/"].sort());
});

test("the favicon is a minimal same-palette SVG", () => {
  const svg = read("public/favicon.svg");

  assert.match(svg, /^<svg\b[^>]*viewBox="0 0 100 100"/);
  assert.equal(occurrences(svg, "π"), 1);
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /fill="#000"/);
  assert.doesNotMatch(svg, /<script\b|<(?:image|use)\b[^>]*(?:href|xlink:href)=["'](?:https?:)?\/\//i);
});

test("the container is private, non-root, and health-checked", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");
  const caddy = read("Caddyfile");

  assert.match(dockerfile, /^FROM caddy:2-alpine$/m);
  assert.match(dockerfile, /^RUN setcap -r \/usr\/bin\/caddy$/m);
  assert.match(dockerfile, /^RUN addgroup -S -g 10001 caddy && adduser -S -D -H -u 10001 -G caddy caddy$/m);
  assert.match(dockerfile, /^USER caddy$/m);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.match(dockerfile, /^HEALTHCHECK\b.*http:\/\/127\.0\.0\.1:8080\//m);

  assert.match(compose, /^\s{4}container_name:\s*pi-web$/m);
  assert.match(compose, /^\s{4}read_only:\s*true$/m);
  assert.match(compose, /^\s{6}-\s*no-new-privileges:true$/m);
  assert.match(compose, /^\s{4}cap_drop:\s*$/m);
  assert.match(compose, /^\s{6}-\s*ALL$/m);
  assert.match(compose, /^\s{2}proxy_net:\s*\n\s{4}external:\s*true$/m);
  assert.doesNotMatch(compose, /^\s*ports:\s*$/m);

  assert.match(caddy, /^:8080\s*\{/m);
  assert.match(caddy, /root \* \/srv/);
  assert.match(caddy, /file_server/);
  assert.match(caddy, /Cache-Control "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"/);
});

test("the sg1 Caddy patch preserves Bunny origin protection", () => {
  const patch = read("infra/sg1-caddy.patch");

  assert.match(patch, /^\+pi\.sg \{$/m);
  assert.match(patch, /^\+\timport avkean_bunny_https$/m);
  assert.match(patch, /^\+\treverse_proxy pi-web:8080$/m);
  assert.match(patch, /Content-Security-Policy/);
  assert.match(patch, /Strict-Transport-Security/);
  assert.match(patch, /X-Content-Type-Options/);
  assert.match(patch, /X-Frame-Options/);
  assert.match(patch, /Referrer-Policy/);
  assert.doesNotMatch(patch, /ORIGIN_SECRET|BUNNY_API_KEY|96\.9\.231\.27/);
});

test("the sg1 Caddy patch declares accurate unified-diff hunk lengths", () => {
  const patch = read("infra/sg1-caddy.patch");
  const hunk = patch.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@[^\n]*\n([\s\S]+)$/);

  assert.ok(hunk, "expected one unified-diff hunk");
  const lines = hunk[5].trimEnd().split("\n");
  for (const line of lines) {
    assert.match(line, /^[ +\\-]/, "every hunk line needs a unified-diff marker");
  }
  const oldLineCount = lines.filter((line) => !line.startsWith("+")).length;
  const newLineCount = lines.filter((line) => !line.startsWith("-")).length;

  assert.equal(oldLineCount, Number(hunk[2]));
  assert.equal(newLineCount, Number(hunk[4]));
});
