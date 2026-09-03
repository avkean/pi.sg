import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMixedPredictor } from '../codecs/mixed/predictor.mjs';
import { shareContext } from '../codecs/predict/models.mjs';
import { validate } from '../codecs/core/core.mjs';
import {
  decodeAsciiMixed,
  decodeUnicodeMixed,
  encodeMixedFrames,
  isAsciiMixedPayload,
  isMixedInput,
  isUnicodeMixedInput,
  isUnicodeMixedPayload,
  verifyEncodedMixedFrames
} from '../codecs/mixed/frame.mjs';
import { unescapeMixedPayload } from '../src/mixed-surface.mjs';
import { createCompressor } from '../src/server-compressor.mjs';

test('mixed predictor and namespaced frames match fixed vectors', () => {
  const predictor = createMixedPredictor(shareContext());
  const input = 'https://example.com/';
  const candidates = predictor.encodeCandidates(input);
  const frames = encodeMixedFrames(
    candidates[0].bytes,
    candidates,
    () => false
  );
  assert.equal(frames.ascii.payload, '!Ep:PZ');
  assert.equal(frames.unicode.payload, '垮캯');
  assert.equal(
    decodeAsciiMixed(frames.ascii.payload, predictor, () => false).input,
    input
  );
  assert.equal(
    decodeUnicodeMixed(frames.unicode.payload, predictor, () => false).input,
    input
  );
  verifyEncodedMixedFrames(
    frames,
    candidates,
    () => false,
    candidates[0].bytes
  );
  for (const length of [0, 3, frames.ascii.trace.length - 3]) {
    const trace = frames.ascii.trace.slice(0, length);
    const damagedCandidate = { ...frames.ascii, trace };
    assert.throws(() =>
      verifyEncodedMixedFrames(
        { ...frames, ascii: damagedCandidate },
        candidates.map((candidate) =>
          candidate.route === damagedCandidate.route
            ? { ...candidate, trace }
            : candidate
        ),
        () => false,
        candidates[0].bytes
      )
    );
  }
  for (const [format, payload] of [
    ['ascii', '!Ep:Pa'],
    ['unicode', '垮캰']
  ])
    assert.throws(() =>
      verifyEncodedMixedFrames(
        { ...frames, [format]: { ...frames[format], payload } },
        candidates,
        () => false,
        candidates[0].bytes
      )
    );
  const other = predictor
    .encodeCandidates('https://example.org/')
    .map((candidate) => ({ ...candidate, bytes: candidates[0].bytes }));
  const relabeled = encodeMixedFrames(candidates[0].bytes, other, () => false);
  assert.throws(() =>
    verifyEncodedMixedFrames(relabeled, other, () => false, candidates[0].bytes)
  );
  assert.ok(isAsciiMixedPayload(frames.ascii.payload));
  assert.ok(isUnicodeMixedPayload(frames.unicode.payload));
  for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD']) {
    const normalized = frames.unicode.payload.normalize(form);
    assert.ok(isUnicodeMixedInput(normalized));
    assert.equal(
      decodeUnicodeMixed(normalized, predictor, () => false).input,
      input
    );
  }
  const escaped = new URL(
    'https://pi.sg/' + frames.unicode.payload
  ).pathname.slice(1);
  assert.equal(unescapeMixedPayload(escaped), frames.unicode.payload);
  assert.throws(() =>
    decodeUnicodeMixed(frames.unicode.payload + '㐀', predictor, () => false)
  );
  assert.throws(() =>
    decodeAsciiMixed(frames.ascii.payload + 'A', predictor, () => false)
  );
  assert.throws(() => unescapeMixedPayload('%2Fhealth'));
});

test('saved mixed links remain exact at both input limits', async () => {
  const fixtures = JSON.parse(
    await readFile(new URL('fixtures/mixed-links.json', import.meta.url))
  );
  const model = await readFile(
    new URL('../models/context-v1.bin', import.meta.url)
  );
  const compressor = createCompressor(model, { prediction: false });
  const predictor = createMixedPredictor(shareContext());
  compressor.warmup({ decoder: true });

  for (const fixture of fixtures) {
    assert.equal(validate(fixture.input).length, fixture.bytes);
    assert.ok(
      predictor
        .encodeCandidates(fixture.input)
        .some((candidate) => candidate.route === fixture.route)
    );
    for (const payload of [fixture.ascii, fixture.unicode]) {
      assert.ok(isMixedInput(payload));
      assert.equal(compressor.decode(payload), fixture.input);
      const path = new URL('https://pi.sg/' + payload).pathname.slice(1);
      assert.equal(compressor.decode(path), fixture.input);
    }
  }

  const boundary = fixtures.at(-1).input;
  assert.equal(validate(boundary).length, 256);
  assert.deepEqual(predictor.encodeCandidates(boundary + 'a'), []);
  for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD'])
    assert.equal(
      compressor.decode(fixtures[1].unicode.normalize(form)),
      fixtures[1].input
    );
});

test('small seeded mutations never open a different destination', async () => {
  const fixtures = JSON.parse(
    await readFile(new URL('fixtures/mixed-links.json', import.meta.url))
  );
  const model = await readFile(
    new URL('../models/context-v1.bin', import.meta.url)
  );
  const compressor = createCompressor(model, { prediction: false });
  let state = 0x4d495846;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const pools = {
    ascii: {
      first: [..."!$&'()*+,;=:@"],
      middle: [...new Set(fixtures.flatMap((fixture) => [...fixture.ascii]))],
      last: [
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      ]
    },
    unicode: {
      first: fixtures.map((fixture) => [...fixture.unicode][0]),
      middle: [...new Set(fixtures.flatMap((fixture) => [...fixture.unicode]))]
    }
  };

  for (const fixture of fixtures)
    for (const format of ['ascii', 'unicode']) {
      const source = [...fixture[format]];
      for (let round = 0; round < 8; round++) {
        const mutated = source.slice();
        if (round % 3 === 0) {
          const position = random() % mutated.length;
          const choices =
            position === 0
              ? pools[format].first
              : format === 'ascii' && position === mutated.length - 1
                ? pools.ascii.last
                : pools[format].middle;
          let next = choices[random() % choices.length];
          if (next === mutated[position])
            next = choices[(choices.indexOf(next) + 1) % choices.length];
          mutated[position] = next;
        } else if (round % 3 === 1) {
          mutated.splice(1 + (random() % (mutated.length - 2)), 1);
        } else {
          const position = 1 + (random() % (mutated.length - 1));
          const choices = pools[format].middle;
          mutated.splice(position, 0, choices[random() % choices.length]);
        }
        let decoded;
        try {
          decoded = compressor.decode(mutated.join(''));
        } catch {
          continue;
        }
        assert.equal(decoded, fixture.input);
      }
    }
});
