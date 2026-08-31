import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate/browser';
import { seal, toBase64, verify } from '../codecs/core/bytes.mjs';
import {
  encodeStructured,
  decodeStructured,
  MAX_INPUT_BYTES,
  MAX_BODY_BYTES
} from '../src/structured.mjs';

const utf8 = new TextEncoder(),
  B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const repro =
  'https://drive.google.com/drive/u/1/folders/1ec0HU6_1vqnyvGlO2iFnfZeVNQKh_jpM';
const drive = 'https://drive.google.com/drive/folders/';
function random(seed) {
  let state = seed >>> 0;
  return (length, alphabet = B64) => {
    let value = '';
    for (let i = 0; i < length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value += alphabet[(state >>> 0) % alphabet.length];
    }
    return value;
  };
}
function roundtrip(input) {
  const body = encodeStructured(input);
  assert.ok(body instanceof Uint8Array, input.slice(0, 160));
  assert.ok(body.length <= MAX_BODY_BYTES);
  assert.equal(decodeStructured(body), input);
  assert.deepEqual(encodeStructured(decodeStructured(body)), body);
  return body;
}
function uint(value) {
  const out = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);
  return out;
}
// A known v1 grammar header and one-symbol ID, followed by an explicit residual.
const residualFrame = (mode, size, data) =>
  Uint8Array.from([65, 1, 0, ...uint(size * 4 + mode), ...data]);
const fixtures = (() => {
  const token = random(0x13579bdf),
    rows = [{ family: 'drive-repro', input: repro }];
  for (const account of ['0', '1', '123', '000123'])
    rows.push({
      family: 'drive-account',
      input: `https://drive.google.com/drive/u/${account}/folders/${token(33)}?usp=sharing`
    });
  for (const [family, prefix, length] of [
    ['drive-folder', drive, 33],
    ['drive-file', 'https://drive.google.com/file/d/', 43],
    ['docs', 'https://docs.google.com/document/d/', 44],
    ['sheets', 'https://docs.google.com/spreadsheets/d/', 44],
    ['slides', 'https://docs.google.com/presentation/d/', 44],
    ['youtube-watch', 'https://www.youtube.com/watch?v=', 11],
    ['youtube-short', 'https://www.youtube.com/shorts/', 11],
    ['youtube-share', 'https://youtu.be/', 11]
  ])
    rows.push({ family, input: prefix + token(length) });
  for (const kind of [
    'track',
    'album',
    'playlist',
    'episode',
    'show',
    'artist'
  ])
    rows.push({
      family: 'spotify-' + kind,
      input:
        'https://open.spotify.com/' + kind + '/' + token(22, B64.slice(0, 62))
    });
  rows.push(
    {
      family: 'notion',
      input: 'https://www.notion.so/' + token(32, '0123456789abcdef')
    },
    {
      family: 'notion-title',
      input:
        'https://research.notion.site/Meeting-notes-' +
        token(32, '0123456789abcdef') +
        '?pvs=4'
    },
    {
      family: 'amazon',
      input:
        'https://www.amazon.com/dp/' +
        token(10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    },
    {
      family: 'amazon-title',
      input:
        'https://www.amazon.com/Everyday-Notebook/dp/' +
        token(10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') +
        '?th=1'
    },
    {
      family: 'unicode-tail',
      input: drive + token(43) + '?q=中文🙂&x=%2f&x=%2F#café'
    },
    {
      family: 'compressed-tail',
      input: drive + token(33) + '?q=' + 'sharing%20notes&'.repeat(100)
    }
  );
  return rows;
})();

test('known Drive example is a 28-byte body without a checksum', () => {
  const body = roundtrip(repro);
  assert.equal(body.length, 28);
  assert.equal(('z' + toBase64(seal(body, utf8.encode(repro)))).length, 44);
  // Small golden vectors pin template IDs, nibble/6-bit order, and empty residuals.
  assert.deepEqual([...roundtrip(drive + 'A')], [1, 1, 0]);
  assert.deepEqual(
    [...roundtrip('https://drive.google.com/drive/u/001/folders/_')],
    [0, 3, 0, 16, 1, 252]
  );
});

test('small decimal accounts use canonical one-byte tags, preserving leading-zero spellings', () => {
  const url = (account) =>
    `https://drive.google.com/drive/u/${account}/folders/A`;
  for (let account = 0; account < 64; account++) {
    assert.deepEqual([...roundtrip(url(account))], [0, 128 | account, 1, 0]);
    assert.notDeepEqual(roundtrip(url('0' + account)), roundtrip(url(account)));
  }
  for (const account of [
    '64',
    '99',
    '123',
    '00',
    '01',
    '063',
    '9'.repeat(64)
  ]) {
    const body = roundtrip(url(account));
    assert.equal(body[1], account.length);
  }
  for (let tag = 192; tag <= 255; tag++)
    assert.throws(() => decodeStructured(Uint8Array.of(0, tag, 1, 0)));
  assert.throws(() => decodeStructured(Uint8Array.of(0, 1, 16, 1, 0))); // Noncanonical long form for 1.
  assert.throws(() => decodeStructured(Uint8Array.of(65, 1, 0, 0))); // Empty residual marked present.
});

test('seeded IDs cover lengths and decimal accounts without normalizing spelling', () => {
  const token = random(0x5eeda11);
  for (const length of [1, 2, 3, 4, 7, 11, 22, 32, 33, 43, 64, 128, 1024]) {
    for (const account of ['0', '1', '123', '00001', '9'.repeat(64)]) {
      const id = token(length);
      roundtrip(`https://drive.google.com/drive/u/${account}/folders/${id}`);
      for (const prefix of [
        drive,
        'https://drive.google.com/file/d/',
        'https://docs.google.com/document/d/',
        'https://docs.google.com/spreadsheets/d/',
        'https://docs.google.com/presentation/d/'
      ])
        roundtrip(prefix + id);
    }
  }
  for (const { input } of fixtures) roundtrip(input);
});

test('fixed ID grammars, hex case, leading zeroes, UUID hyphens and HTTP survive exactly', () => {
  const token = random(0xa5a5eedd);
  for (const prefix of [
    'https://www.youtube.com/watch?v=',
    'https://youtube.com/watch?v=',
    'https://m.youtube.com/watch?v=',
    'https://youtu.be/',
    'https://www.youtube.com/shorts/',
    'https://youtube.com/shorts/',
    'https://www.youtube.com/live/',
    'https://www.youtube.com/embed/'
  ]) {
    for (let i = 0; i < 10; i++)
      roundtrip(
        prefix +
          token(11) +
          (prefix.includes('?') ? '&' : '?') +
          'si=x&t=001#frag'
      );
  }
  for (const hex of [
    '0'.repeat(32),
    '0001aBcD'.repeat(4),
    token(32, '0123456789abcdef'),
    token(32, '0123456789ABCDEF')
  ]) {
    for (const id of [
      hex,
      hex.slice(0, 8) +
        '-' +
        hex.slice(8, 12) +
        '-' +
        hex.slice(12, 16) +
        '-' +
        hex.slice(16, 20) +
        '-' +
        hex.slice(20)
    ]) {
      for (const prefix of [
        'https://www.notion.so/',
        'https://notion.so/Notes-',
        'https://team.notion.site/中文-%2f-'
      ]) {
        roundtrip(prefix + id + '?pvs=4');
      }
    }
  }
  for (const host of [
    'www.amazon.com',
    'amazon.com',
    'www.amazon.co.uk',
    'www.amazon.de',
    'www.amazon.ca'
  ]) {
    roundtrip('https://' + host + '/dp/000aBC12de/ref=sr_1_2?tag=keep-me');
  }
  roundtrip('https://www.amazon.com/gp/product/B012345678?th=1');
  roundtrip(repro.replace('https://', 'http://'));
  roundtrip('https://notion.so/\ufeff-' + 'a'.repeat(32));
});

test('residuals preserve duplicate parameters, escaping, Unicode, fragments and path spelling', () => {
  for (const tail of [
    '/',
    '?',
    '#',
    '/view?usp=sharing',
    '/edit/../copy?tab=t.0',
    '?a=%2f&a=%2F&bare&empty=&&x=+&x=%20#F%2f',
    '?q=中文🙂&composed=é&decomposed=e\u0301#\ufeff',
    '?redirect=https://user:password@host.example/a?x=1&x=2',
    '?x=%00%0d%0a#%FF',
    '?q=' + 'a/b%20c=&'.repeat(1000)
  ])
    roundtrip(repro + tail);
});

test('unmatched or invalid schemas return null and never discard authority details', () => {
  for (const input of [
    null,
    undefined,
    123,
    {},
    '',
    'not a URL',
    'ftp://drive.google.com/drive/folders/abc',
    'https://example.com/drive/folders/abc',
    'HTTPS://drive.google.com/drive/folders/abc',
    'https://DRIVE.google.com/drive/folders/abc',
    'https://drive.google.com:443/drive/folders/abc',
    'https://user:pass@drive.google.com/drive/folders/abc',
    'https://drive.google.com@evil.test/drive/folders/abc',
    'https://drive.google.com.evil.test/drive/folders/abc',
    drive,
    drive + 'abc!',
    drive + 'abc%2Fdef',
    drive + 'a'.repeat(1025),
    'https://drive.google.com/drive/u/-1/folders/abc',
    'https://drive.google.com/drive/u/1.2/folders/abc',
    'https://drive.google.com/drive/u/' + '0'.repeat(65) + '/folders/a',
    'https://docs.google.com/forms/d/abc',
    'https://youtu.be/short',
    'https://youtu.be/' + 'a'.repeat(12),
    'https://www.youtube.com/watch?v=' + 'a'.repeat(12),
    'https://open.spotify.com/track/' + '_'.repeat(22),
    'https://www.amazon.com/dp/B0123456789',
    'https://notion.so/' + 'g'.repeat(32),
    repro + '\n',
    repro + '?q=\ud800',
    repro + '#\udfff'
  ])
    assert.equal(encodeStructured(input), null, String(input));
});

test('128 KiB UTF-8 and 6 KiB body limits apply before expansion or large allocations', () => {
  const prefix = drive + 'A?q=';
  roundtrip(prefix + 'a'.repeat(MAX_INPUT_BYTES - utf8.encode(prefix).length));
  assert.equal(
    encodeStructured(prefix + 'a'.repeat(MAX_INPUT_BYTES - prefix.length + 1)),
    null
  );
  const unicode =
    prefix + 'é'.repeat(Math.floor((MAX_INPUT_BYTES - prefix.length) / 2));
  roundtrip(unicode);
  assert.equal(encodeStructured(unicode + 'é'), null);
  assert.equal(encodeStructured(prefix + random(0x3819ab)(12000)), null);
  assert.throws(() => decodeStructured(new Uint8Array(MAX_BODY_BYTES + 1)));
  const bomb = deflateSync(utf8.encode('?' + 'x'.repeat(MAX_INPUT_BYTES)), {
    level: 6
  });
  assert.throws(() => decodeStructured(residualFrame(2, bomb.length, bomb)));
  assert.throws(() =>
    decodeStructured(residualFrame(0, MAX_INPUT_BYTES + 1, []))
  );
  assert.throws(() =>
    decodeStructured(residualFrame(1, MAX_INPUT_BYTES + 1, []))
  );
});

test('decoder rejects truncation, trailing bytes, reserved headers and nonminimal lengths', () => {
  for (const { input } of fixtures) {
    const body = roundtrip(input);
    for (let end = 0; end < body.length; end++)
      assert.throws(() => decodeStructured(body.subarray(0, end)));
    for (const byte of [0, 255])
      assert.throws(() => decodeStructured(Uint8Array.from([...body, byte])));
  }
  for (const value of [
    null,
    [],
    new ArrayBuffer(4),
    new Uint8Array(),
    Uint8Array.of(64, 0),
    Uint8Array.of(63, 0),
    Uint8Array.of(255, 0),
    Uint8Array.of(1, 129, 0, 0, 0),
    Uint8Array.of(1, 0, 0),
    Uint8Array.of(1, 255, 255, 255, 0),
    Uint8Array.of(1, 1, 0, 128, 0)
  ]) {
    assert.throws(() => decodeStructured(value));
  }
});

test('symbol ranges, bit padding, UTF-8 and compressed residual structure are strict', () => {
  const decimal = roundtrip('https://drive.google.com/drive/u/123/folders/A');
  for (const [offset, replacement] of [
    [2, 0xf0],
    [3, 0x31],
    [5, 1]
  ]) {
    const changed = decimal.slice();
    changed[offset] = replacement;
    assert.throws(() => decodeStructured(changed));
  }
  const spotify = roundtrip('https://open.spotify.com/track/' + 'a'.repeat(22));
  spotify[1] = 255;
  assert.throws(() => decodeStructured(spotify));
  const ascii = roundtrip(drive + 'A?abcdefghij');
  assert.equal(ascii[3] & 3, 1);
  ascii[ascii.length - 1] |= 1;
  assert.throws(() => decodeStructured(ascii));
  for (const raw of [
    [63, 0xff],
    [63, 0xc0, 0xaf],
    [63, 0xed, 0xa0, 0x80],
    [63, 0xe2, 0x82]
  ]) {
    assert.throws(() => decodeStructured(residualFrame(0, raw.length, raw)));
  }
  assert.throws(() => decodeStructured(residualFrame(3, 0, [])));
  assert.throws(() => decodeStructured(residualFrame(0, 1, [33]))); // Not a residual delimiter.
  const zip = deflateSync(utf8.encode('?' + 'abc'.repeat(100)), { level: 6 });
  assert.throws(() =>
    decodeStructured(residualFrame(2, zip.length + 1, [...zip, 0]))
  );
  assert.throws(() =>
    decodeStructured(residualFrame(2, zip.length - 1, zip.subarray(0, -1)))
  );
  assert.throws(() => decodeStructured(residualFrame(2, 1, [7]))); // Reserved DEFLATE block.
  const mixed = roundtrip('https://www.notion.so/0aB' + 'c'.repeat(29));
  mixed[19] |= 128; // Uppercase flag on a numeric hex digit.
  assert.throws(() => decodeStructured(mixed));
});

test('outer CRC detects valid ID mutations that a checksum-free grammar cannot', () => {
  const body = roundtrip(repro),
    frame = seal(body, utf8.encode(repro));
  const changed = body.slice();
  changed[4] ^= 4;
  const other = decodeStructured(changed);
  assert.notEqual(other, repro);
  assert.throws(() => verify(frame, utf8.encode(other)));
});

test('seeded malformed bodies remain bounded; corruption is not assumed to always be structural', () => {
  const token = random(0x1234b00b);
  for (let i = 0; i < 800; i++) {
    const body = encodeStructured(fixtures[i % fixtures.length].input).slice();
    const index = token(1).charCodeAt(0) % body.length;
    body[index] ^= 1 << i % 8;
    try {
      const decoded = decodeStructured(body);
      assert.ok(utf8.encode(decoded).length <= MAX_INPUT_BYTES);
      assert.ok(encodeStructured(decoded) instanceof Uint8Array);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof assert.AssertionError));
    }
  }
});
