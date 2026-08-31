import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate/browser';
import { seal, verify } from '../codecs/core/bytes.mjs';
import { encodeStructured } from '../src/structured.mjs';
import {
  encodePacked,
  decodePacked,
  MAX_INPUT_BYTES,
  MAX_BODY_BYTES
} from '../src/packed-structured.mjs';

const utf8 = new TextEncoder(),
  B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const drive = 'https://drive.google.com/drive/folders/';
const repro =
  'https://drive.google.com/drive/u/1/folders/1ec0HU6_1vqnyvGlO2iFnfZeVNQKh_jpM';
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
// Independent bit-string fixture assembler, intentionally unlike the codec's I/O.
class Bits {
  value = '';
  put(value, width) {
    this.value += value.toString(2).padStart(width, '0');
    return this;
  }
  uint(value) {
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      this.put(byte | (value ? 128 : 0), 8);
    } while (value);
    return this;
  }
  length(value) {
    this.put(value > 0 && value < 64 ? value : 0, 6);
    if (!value || value >= 64) this.uint(value);
    return this;
  }
  data(bytes) {
    for (const byte of bytes) this.put(byte, 8);
    return this;
  }
  symbols(value, alphabet = B64, width = 6) {
    for (const char of value) this.put(alphabet.indexOf(char), width);
    return this;
  }
  text(value) {
    const bytes = utf8.encode(value);
    return this.uint(bytes.length * 4).data(bytes);
  }
  frame() {
    const bitLength = this.value.length,
      padded = this.value.padEnd(Math.ceil(bitLength / 8) * 8, '0');
    return {
      bytes: Uint8Array.from(padded.match(/.{8}/g) || [], (byte) =>
        parseInt(byte, 2)
      ),
      bitLength
    };
  }
}
const decodeFrame = (frame) =>
  decodePacked(frame.bytes, { bitLength: frame.bitLength });
const rejects = (bits) =>
  assert.throws(() => decodeFrame(bits instanceof Bits ? bits.frame() : bits));
const residual = () => new Bits().put(65, 8).length(1).put(0, 6); // Drive/A + tail.
const textResidual = (mode, size, data) =>
  residual()
    .uint(size * 4 + mode)
    .data(data);
function padded(frame, count) {
  const bits = new Bits();
  for (let i = 0; i < frame.bitLength; i++)
    bits.put((frame.bytes[i >> 3] >> (7 - (i & 7))) & 1, 1);
  if (count) bits.put(0, count);
  return bits.frame();
}
function roundtrip(input) {
  const frame = encodePacked(input);
  assert.ok(frame && frame.bytes instanceof Uint8Array, input.slice(0, 160));
  assert.ok(frame.bitLength <= MAX_BODY_BYTES * 8);
  assert.equal(frame.bytes.length, Math.ceil(frame.bitLength / 8));
  assert.deepEqual(decodeFrame(frame), { input, bitLength: frame.bitLength });
  assert.deepEqual(decodePacked(frame.bytes), {
    input,
    bitLength: frame.bitLength
  });
  assert.deepEqual(encodePacked(decodeFrame(frame).input), frame);
  return frame;
}
function tailMode(frame, offset = 20) {
  let value = 0,
    scale = 1;
  while (true) {
    let byte = 0;
    for (let i = 0; i < 8; i++, offset++)
      byte = byte * 2 + ((frame.bytes[offset >> 3] >> (7 - (offset & 7))) & 1);
    value += (byte & 127) * scale;
    if (!(byte & 128)) return value & 3;
    scale *= 128;
  }
}

const ytPrefixes = [
  'https://www.youtube.com/watch?v=',
  'https://youtube.com/watch?v=',
  'https://m.youtube.com/watch?v=',
  'https://youtu.be/',
  'https://www.youtube.com/shorts/',
  'https://youtube.com/shorts/',
  'https://www.youtube.com/live/',
  'https://www.youtube.com/embed/'
];
const fixtures = (() => {
  const token = random(0x935781de),
    rows = [{ family: 'drive-development-repro', input: repro }];
  for (const account of ['0', '1', '2', '17', '000123', 'user%40example.com'])
    rows.push({
      family: 'drive-account',
      input: `https://drive.google.com/drive/u/${account}/folders/${token(33)}`
    });
  for (const [family, prefix, size] of [
    ['drive-folder', drive, 33],
    ['drive-file', 'https://drive.google.com/file/d/', 43],
    ['docs', 'https://docs.google.com/document/d/', 44],
    ['sheets', 'https://docs.google.com/spreadsheets/d/', 44],
    ['slides', 'https://docs.google.com/presentation/d/', 44]
  ])
    rows.push({ family, input: prefix + token(size) });
  for (const [i, prefix] of ytPrefixes.entries())
    rows.push({
      family: 'youtube-' + i,
      input: prefix + token(10) + 'AEIMQUYcgkosw048'[i]
    });
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
        'https://team.notion.site/Meeting-notes-' +
        token(32, '0123456789abcdef') +
        '?pvs=4'
    },
    {
      family: 'amazon',
      input: 'https://www.amazon.com/dp/' + token(10, B64.slice(0, 62))
    },
    {
      family: 'amazon-title',
      input:
        'https://www.amazon.com/Notebook/dp/' +
        token(10, B64.slice(0, 62)) +
        '?th=1'
    }
  );
  for (const host of ['www.instagram.com', 'instagram.com'])
    for (const kind of ['p', 'reel'])
      rows.push({
        family: 'instagram-' + kind,
        input: `https://${host}/${kind}/${token(11)}/?igsh=${token(16)}`
      });
  for (const host of [
    'x.com',
    'twitter.com',
    'www.x.com',
    'www.twitter.com',
    'mobile.twitter.com'
  ])
    rows.push({
      family: 'status',
      input: `https://${host}/${token(12, B64.slice(0, 62))}/status/${token(19, '0123456789')}?s=20&t=${token(22)}`
    });
  for (const [family, tail] of [
    [
      'query-sharing',
      '?si=' + token(16) + '&t=001&si=' + token(8) + '&feature=shared'
    ],
    [
      'query-utm',
      '?utm_source=newsletter&utm_medium=email&utm_campaign=summer2026&utm_content=link0001'
    ],
    ['query-case', '?T=001&t=0001&Si=ABc&si=Def&x=&x&&=empty#frag'],
    ['query-unicode', '?q=中文🙂&x=%2f&x=%2F#café'],
    ['query-deflate', '?q=' + 'sharing%20notes&'.repeat(100)]
  ])
    rows.push({ family, input: drive + token(33) + tail });
  return rows;
})();

test('bare Drive is 214 bits and canonical YouTube is 72 bits without internal CRC', () => {
  const frame = roundtrip(repro);
  assert.equal(frame.bitLength, 214);
  assert.equal(frame.bytes.length, 27);
  assert.equal(Math.ceil((1 + 32 + frame.bitLength) / 15), 17);
  for (const prefix of ytPrefixes) {
    const yt = roundtrip(prefix + 'dQw4w9WgXcQ');
    assert.equal(yt.bitLength, 72);
    assert.equal(Math.ceil((1 + 32 + yt.bitLength) / 15), 7);
  }
  assert.deepEqual(roundtrip(drive + 'A'), {
    bytes: Uint8Array.of(1, 4, 0),
    bitLength: 20
  });
  assert.deepEqual(roundtrip('https://youtu.be/' + 'A'.repeat(11)), {
    bytes: Uint8Array.of(9, 0, 0, 0, 0, 0, 0, 0, 0),
    bitLength: 72
  });
  assert.deepEqual(roundtrip('https://youtu.be/' + '_'.repeat(10) + '8'), {
    bytes: Uint8Array.of(9, 255, 255, 255, 255, 255, 255, 255, 255),
    bitLength: 72
  });
  assert.deepEqual(
    roundtrip('https://drive.google.com/drive/u/001/folders/_'),
    { bytes: Uint8Array.of(0, 224, 192, 4, 31, 192), bitLength: 42 }
  );
});

test('two-bit account shortcuts and opaque escapes preserve leading zeros and spelling', () => {
  const token = random(0x19743),
    url = (account) => `https://drive.google.com/drive/u/${account}/folders/A`;
  for (let account = 0; account <= 2; account++) {
    const frame = roundtrip(url(String(account)));
    assert.deepEqual(
      frame,
      new Bits().put(0, 8).put(account, 2).length(1).put(0, 6).frame()
    );
    assert.equal(frame.bitLength, 22);
  }
  for (const account of [
    '3',
    '9',
    '63',
    '64',
    '12345678901234567890',
    '00',
    '01',
    '02',
    '000123',
    '9'.repeat(64),
    'user@example.com',
    'user%40example.com',
    'Ab_C-19',
    'équipe',
    '\ufeffaccount'
  ])
    roundtrip(url(account));
  for (let i = 0; i < 100; i++) {
    const digits = token(1 + (i % 50), '0123456789');
    const frame = roundtrip(url(digits)),
      leading = roundtrip(url('0'.repeat(1 + (i % 8)) + digits));
    assert.notDeepEqual(leading, frame);
  }
  for (const account of ['0', '1', '2']) {
    rejects(
      new Bits()
        .put(0, 8)
        .put(3, 2)
        .put(2, 2)
        .length(1)
        .symbols(account, '0123456789', 4)
        .length(1)
        .put(0, 6)
    );
  }
  rejects(
    new Bits().put(0, 8).put(3, 2).put(0, 2).text('').length(1).put(0, 6)
  );
  assert.equal(encodePacked(url('a'.repeat(65))), null);
  assert.equal(encodePacked(url('é'.repeat(33))), null);
});

test('base64 symbol lengths cross byte boundaries, including the six-bit escape boundary', () => {
  const token = random(0x5eeda11);
  for (const size of [
    1, 2, 3, 4, 7, 11, 22, 32, 33, 43, 62, 63, 64, 65, 127, 128, 1024
  ]) {
    for (const account of ['0', '1', '2', '001', '17', 'opaque%40account']) {
      const id = token(size),
        frame = roundtrip(
          `https://drive.google.com/drive/u/${account}/folders/${id}`
        );
      if (/^[012]$/.test(account))
        assert.equal(
          frame.bitLength,
          10 + 6 + (size >= 64 ? (size < 128 ? 8 : 16) : 0) + size * 6
        );
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

test('YouTube only accepts canonical 64-bit IDs, preserving all other IDs for the old codec', () => {
  const token = random(0xd0982c);
  for (const prefix of ytPrefixes)
    for (let i = 0; i < 64; i++) {
      const input = prefix + token(10) + B64[i];
      if (i % 4) {
        assert.equal(encodePacked(input), null);
        assert.ok(encodeStructured(input));
      } else {
        roundtrip(input);
        roundtrip(
          input +
            (prefix.includes('?') ? '&' : '?') +
            'si=' +
            token(16) +
            '&t=0001#frag'
        );
      }
    }
});

test('fixed IDs, UUID spelling, HTTP, Instagram and status routes roundtrip by grammar', () => {
  const token = random(0xa50ba5ed);
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
      ])
        roundtrip(prefix + id + '?pvs=4');
    }
  }
  for (const host of [
    'www.amazon.com',
    'amazon.com',
    'www.amazon.co.uk',
    'www.amazon.de',
    'www.amazon.ca'
  ])
    roundtrip(`https://${host}/dp/000aBC12de/ref=sr_1_2?tag=keep-me`);
  roundtrip('https://www.amazon.com/gp/product/B012345678?th=1');
  for (const host of ['www.instagram.com', 'instagram.com'])
    for (const kind of ['p', 'reel']) {
      for (const size of [1, 11, 33, 63, 64])
        roundtrip(`https://${host}/${kind}/${token(size)}?igsh=${token(16)}`);
    }
  for (const host of [
    'x.com',
    'twitter.com',
    'www.x.com',
    'www.twitter.com',
    'mobile.twitter.com'
  ]) {
    for (const name of ['_', 'User_Name', token(15, B64.slice(0, 62))])
      for (const size of [1, 19, 64]) {
        roundtrip(
          `https://${host}/${name}/status/${size === 1 ? '0' : '00' + token(size - 2, '0123456789')}`
        );
      }
  }
  roundtrip('https://drive.google.com/drive/u/01/file/d/A/view');
  for (const kind of ['document', 'spreadsheets', 'presentation'])
    roundtrip(
      `https://docs.google.com/${kind}/u/02/d/${token(44)}/edit?usp=sharing`
    );
  for (const { input } of fixtures)
    roundtrip(input.replace('https://', 'http://'));
});

test('ordered query packing is generic and smaller for shared keys across different platforms', () => {
  const tail =
    '?si=ABcd0123efGH4567&t=001&si=z_19&feature=shared&utm_source=newsletter&utm_medium=email';
  const frame = roundtrip(drive + 'A' + tail);
  assert.equal(tailMode(frame), 3);
  assert.ok(frame.bitLength < 20 + 16 + utf8.encode(tail).length * 7);
  assert.ok(frame.bitLength < encodeStructured(drive + 'A' + tail).length * 8);
  for (const path of ['/', '/edit', '/view/../copy', '/a&b']) {
    assert.equal(tailMode(roundtrip(drive + 'A' + path + tail)), 3);
  }
  for (const prefix of [
    drive + 'A',
    'https://youtu.be/0123456789A',
    'https://www.instagram.com/p/Abcd0123',
    'https://x.com/User_1/status/0001234567890',
    'https://open.spotify.com/track/' + '0'.repeat(22),
    'https://www.amazon.com/dp/000ABC1234'
  ])
    roundtrip(prefix + tail);
  roundtrip(
    'https://www.youtube.com/watch?v=0123456789A' + tail.replace('?', '&')
  );
  for (const value of [
    '00000000123',
    '0123456789abcdef',
    '0123456789ABCDEF',
    '0123aBcD',
    'ABcd_01-23',
    '',
    'a=b=c',
    'é中🙂',
    '%2f%2F+%20'
  ]) {
    roundtrip(
      drive +
        'A?resourcekey=' +
        value +
        '&t=0001&resourcekey=' +
        value +
        '&si=1234567890123456'
    );
  }
});

test('literal key case, exact order, repeats, bare/empty entries, separators and fragments survive', () => {
  for (const tail of [
    '/',
    '?',
    '#',
    '?#',
    '?&',
    '?&&',
    '?=',
    '?=&=',
    '?a&',
    '?&a',
    '?a=1&&b=2&',
    '/view?usp=sharing',
    '/edit/../copy?tab=t.0',
    '?T=001&t=0001&SI=x&si=y&Si=z&x=&x&=value&&#',
    '?a=%2f&a=%2F&bare&empty=&&x=+&x=%20#F%2f',
    '?q=中文🙂&composed=é&decomposed=e\u0301#\ufeff',
    '?redirect=https://user:password@host.example/a?x=1&x=2',
    '?x=%00%0d%0a#%FF',
    '?q=a?b=c==&unknown%26key=+&utm_custom=X#one#two?three&four',
    '?q=' + 'a/b%20c=&'.repeat(1000)
  ])
    roundtrip(repro + tail);
  const token = random(0x20fee21),
    keyPool = [
      't',
      'T',
      'si',
      'Si',
      '',
      'unknown',
      '%26',
      'utm_source',
      'utm_custom',
      '中文'
    ];
  const valuePool = [
    '',
    '000001',
    'ABCabc_-',
    '%2F%2f',
    '+',
    '%20',
    'x=y=z',
    '🙂',
    'a?b',
    '\ufeff'
  ];
  for (let i = 0; i < 400; i++) {
    const entries = [];
    for (let j = 0; j < i % 13; j++) {
      const key = keyPool[token(1).charCodeAt(0) % keyPool.length];
      const value = valuePool[token(1).charCodeAt(0) % valuePool.length];
      entries.push(key + (j % 3 ? '=' + value : ''));
    }
    const tail =
      '?' + entries.join('&') + (i % 2 ? '#' + token(i % 19) + '#?&=' : '');
    roundtrip(drive + token(1 + (i % 64)) + tail);
  }
});

test('text residuals can select UTF-8, raw seven-bit ASCII, or canonical DEFLATE', () => {
  for (const [tail, mode] of [
    ['#🙂', 0],
    ['?abcdefghij', 1],
    ['?q=' + 'sharing%20notes&'.repeat(100), 2]
  ]) {
    assert.equal(tailMode(roundtrip(drive + 'A' + tail)), mode);
  }
  const raw = utf8.encode('?q=中文🙂'),
    zipped = deflateSync(raw, { level: 6 });
  assert.equal(
    decodeFrame(textResidual(0, raw.length, raw).frame()).input,
    drive + 'A?q=中文🙂'
  );
  assert.equal(
    decodeFrame(textResidual(2, zipped.length, zipped).frame()).input,
    drive + 'A?q=中文🙂'
  );
});

test('unsupported or invalid input returns null without normalizing URLs', () => {
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
    'https://docs.google.com/forms/d/abc',
    'https://youtu.be/short',
    'https://youtu.be/' + 'a'.repeat(12),
    'https://open.spotify.com/track/' + '_'.repeat(22),
    'https://www.amazon.com/dp/B0123456789',
    'https://notion.so/' + 'g'.repeat(32),
    'https://x.com/a-b/status/123',
    'https://x.com/abcdefghijklmnop/status/1',
    'https://twitter.com/u/status/12x',
    'https://www.instagram.com/p/abc%2f',
    repro + '\n',
    repro + '?q=\ud800',
    repro + '#\udfff'
  ]) {
    assert.equal(encodePacked(input), null, String(input));
  }
});

test('decoder stops at self-described end and permits only 0..14 zero transport padding bits', () => {
  for (const { input } of fixtures) {
    const frame = roundtrip(input);
    for (let count = 0; count <= 14; count++) {
      const wrapped = padded(frame, count);
      assert.deepEqual(decodeFrame(wrapped), {
        input,
        bitLength: frame.bitLength
      });
      if (count) {
        const bad = { ...wrapped, bytes: wrapped.bytes.slice() },
          index = frame.bitLength + count - 1;
        bad.bytes[index >> 3] |= 1 << (7 - (index & 7));
        rejects(bad);
      }
    }
    rejects(padded(frame, 15));
    const widePadding = (15 - ((1 + 32 + frame.bitLength) % 15)) % 15;
    assert.equal(
      decodeFrame(padded(frame, widePadding)).bitLength,
      frame.bitLength
    );
    for (let end = 0; end < frame.bitLength; end++) {
      const truncated = {
        bytes: frame.bytes.slice(0, Math.ceil(end / 8)),
        bitLength: end
      };
      if (end % 8)
        truncated.bytes[truncated.bytes.length - 1] &= 255 << (8 - (end % 8));
      rejects(truncated);
    }
  }
  const frame = roundtrip(drive + 'A'),
    corruptStorage = { ...frame, bytes: frame.bytes.slice() };
  corruptStorage.bytes[corruptStorage.bytes.length - 1] |= 1;
  rejects(corruptStorage);
  for (const bitLength of [-1, 0, 7, 20.5, NaN, Infinity, '20', 25])
    rejects({ ...frame, bitLength });
  rejects({
    bytes: Uint8Array.from([...frame.bytes, 0]),
    bitLength: frame.bitLength
  });
  for (const bytes of [
    null,
    [],
    new ArrayBuffer(4),
    new Uint8Array(),
    new Uint8Array(MAX_BODY_BYTES + 3)
  ])
    assert.throws(() => decodePacked(bytes));
});

test('reserved template IDs, nonminimal lengths and invalid symbol values are rejected', () => {
  for (let id = 43; id < 64; id++)
    for (const flags of [0, 64, 128, 192])
      rejects(new Bits().put(id | flags, 8));
  rejects(new Bits().put(1, 8).put(0, 6).uint(1).put(0, 6)); // Short length encoded through escape.
  rejects(new Bits().put(1, 8).put(0, 6).uint(0)); // Empty ID.
  rejects(new Bits().put(1, 8).put(0, 6).put(192, 8).put(0, 8)); // Nonminimal LEB128.
  rejects(new Bits().put(1, 8).put(0, 6).uint(1025));
  rejects(new Bits().put(1, 8).put(0, 6).put(255, 8).put(255, 8).put(255, 8));
  rejects(new Bits().put(14, 8).put(63, 6).symbols('A'.repeat(21))); // Base62 fixed ID.
  rejects(new Bits().put(23, 8).put(62, 6).symbols('A'.repeat(9)));
  rejects(new Bits().put(34, 8).length(1).symbols('-').length(1).put(1, 4)); // Invalid user.
  rejects(new Bits().put(34, 8).length(1).symbols('a').length(1).put(10, 4)); // Decimal nibble.
  rejects(
    new Bits()
      .put(0, 8)
      .put(3, 2)
      .put(2, 2)
      .length(1)
      .put(15, 4)
      .length(1)
      .put(0, 6)
  );
  rejects(residual().uint(0)); // Present but empty residual.
  rejects(textResidual(0, 1, [33])); // Wrong residual delimiter.
  rejects(residual().put(128, 8).put(0, 8)); // Nonminimal text tag.
});

test('UTF-8, UUID modes/masks and DEFLATE boundaries are strict', () => {
  for (const raw of [
    [63, 255],
    [63, 0xc0, 0xaf],
    [63, 0xed, 0xa0, 0x80],
    [63, 0xe2, 0x82],
    [63, 0xf4, 0x90, 0x80, 0x80],
    [63, 0]
  ])
    rejects(textResidual(0, raw.length, raw));
  const zip = deflateSync(utf8.encode('?' + 'abc'.repeat(100)), { level: 6 });
  rejects(textResidual(2, zip.length + 1, [...zip, 0]));
  rejects(textResidual(2, zip.length - 1, zip.subarray(0, -1)));
  rejects(textResidual(2, 1, [7])); // Reserved block type.
  rejects(textResidual(2, 6, [0xf9, 1, 0, 254, 255, 63])); // Nonzero stored-block alignment.
  const notion = () => new Bits().put(20, 8).text('');
  rejects(notion().put(3, 2).put(0, 1));
  rejects(
    notion().put(1, 2).put(0, 1).symbols('0'.repeat(32), '0123456789abcdef', 4)
  );
  rejects(
    notion()
      .put(2, 2)
      .put(0, 1)
      .symbols('0abc' + 'a'.repeat(28), '0123456789abcdef', 4)
      .put(1, 1)
      .put(0, 31)
  );
  rejects(
    notion()
      .put(2, 2)
      .put(0, 1)
      .symbols('a'.repeat(32), '0123456789abcdef', 4)
      .put(0, 32)
  );
  rejects(
    notion()
      .put(2, 2)
      .put(0, 1)
      .symbols('a'.repeat(32), '0123456789abcdef', 4)
      .put(0xffffffff, 32)
  );
});

test('query decoder validates dictionary IDs, literal keys, typed strings and empty-query form', () => {
  const query = (count = 1) =>
    residual()
      .uint(count * 4 + 3)
      .put(0, 2)
      .put(0, 1);
  rejects(query().put(63, 6).put(0, 1));
  for (const key of ['t', 'a&b', 'a=b', '#'])
    rejects(query().put(0, 6).text(key).put(0, 1));
  rejects(query().put(0, 6).text('').put(0, 1));
  for (const value of ['a&b', '#fragment'])
    rejects(query().put(1, 6).put(1, 1).put(0, 2).text(value));
  rejects(query().put(1, 6).put(1, 1).put(2, 2).length(1).put(10, 4));
  rejects(query().put(1, 6).put(1, 1).put(1, 2).length(0));
  rejects(query().put(1, 6).put(1, 1).put(1, 2).put(0, 6).uint(1).put(0, 6));
  rejects(query().put(1, 6).put(1, 1).put(3, 2).put(1, 1).length(1).put(1, 4)); // Uppercase numbers.
  rejects(query(10000));
  rejects(residual().uint(3).put(3, 2).put(0, 1)); // Reserved query start.
  for (const path of ['', 'x', '/a?b', '/#fragment'])
    rejects(residual().uint(3).put(2, 2).put(0, 1).text(path));
  // Forced literal mixed-case keys demonstrate case sensitivity even when raw text would win.
  const explicit = query()
    .put(0, 6)
    .text('T')
    .put(1, 1)
    .put(2, 2)
    .length(3)
    .symbols('001', '0123456789', 4);
  assert.equal(decodeFrame(explicit.frame()).input, drive + 'A?T=001');
  const emptyFragment = residual().uint(3).put(0, 2).put(1, 1).text('');
  assert.equal(decodeFrame(emptyFragment.frame()).input, drive + 'A?#');
});

test('128 KiB input and 6 KiB consumed-body limits bound decoding and decompression', () => {
  const prefix = drive + 'A?q=';
  roundtrip(prefix + 'a'.repeat(MAX_INPUT_BYTES - prefix.length));
  assert.equal(
    encodePacked(prefix + 'a'.repeat(MAX_INPUT_BYTES - prefix.length + 1)),
    null
  );
  const unicode =
    prefix + 'é'.repeat(Math.floor((MAX_INPUT_BYTES - prefix.length) / 2));
  roundtrip(unicode);
  assert.equal(encodePacked(unicode + 'é'), null);
  assert.equal(encodePacked(prefix + random(0x3819ab)(12000)), null);
  const bomb = deflateSync(utf8.encode('?' + 'x'.repeat(MAX_INPUT_BYTES)), {
    level: 6
  });
  rejects(textResidual(2, bomb.length, bomb));
  rejects(textResidual(0, MAX_INPUT_BYTES + 1, []));
  rejects(textResidual(1, MAX_INPUT_BYTES + 1, []));
  // Two individually bounded compressed values must also obey the shared URL budget.
  const large = deflateSync(utf8.encode('x'.repeat(70000)), { level: 6 });
  const query = residual().uint(11).put(0, 2).put(0, 1);
  for (let i = 0; i < 2; i++)
    query
      .put(1, 6)
      .put(1, 1)
      .put(0, 2)
      .uint(large.length * 4 + 2)
      .data(large);
  rejects(query);
  // A maximal body can acquire transport padding, but consumed fields cannot exceed 6 KiB.
  const exact = textResidual(0, 6138, [63, ...Array(6137).fill(97)]).frame();
  assert.equal(exact.bitLength, MAX_BODY_BYTES * 8 - 4);
  assert.equal(decodeFrame(padded(exact, 14)).bitLength, exact.bitLength);
  rejects(textResidual(0, 6139, [63, ...Array(6138).fill(97)]));
});

test('CRC belongs to the parent: a valid ID mutation decodes, then fails the parent checksum', () => {
  const frame = roundtrip(repro),
    sealed = seal(frame.bytes, utf8.encode(repro)),
    changed = { ...frame, bytes: frame.bytes.slice() };
  changed.bytes[3] ^= 4;
  const other = decodeFrame(changed).input;
  assert.notEqual(other, repro);
  assert.throws(() => verify(sealed, utf8.encode(other)));
});

test('seeded malformed bodies stay bounded; valid mutations retain re-encodable exact values', () => {
  const token = random(0xc3eed18);
  for (let i = 0; i < 1200; i++) {
    const source = encodePacked(fixtures[i % fixtures.length].input),
      frame = { ...source, bytes: source.bytes.slice() };
    frame.bytes[token(1).charCodeAt(0) % frame.bytes.length] ^= 1 << i % 8;
    let decoded;
    try {
      decoded = decodeFrame(frame);
    } catch (error) {
      assert.ok(error instanceof Error);
      continue;
    }
    assert.ok(utf8.encode(decoded.input).length <= MAX_INPUT_BYTES);
    assert.equal(decodeFrame(roundtrip(decoded.input)).input, decoded.input);
  }
});
