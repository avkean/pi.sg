import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompressionPool } from '../src/compression-pool.mjs';
import { enhance } from '../src/enhance.mjs';
import { renderResult } from '../src/surface.mjs';

const workerURL = new URL(
  'data:text/javascript,' +
    encodeURIComponent(`
 import {parentPort,threadId} from 'node:worker_threads';
 parentPort.on('message',({id,input})=>{
 if(input==='https://hang.example/')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  if(input==='https://crash.example/')process.exit(1);
  if(input==='https://fail.example/'){
   parentPort.postMessage({id,type:'failed'});
   return;
  }
  const candidate=input==='https://direct.example/'
   ?{codec:'mixed-v1',asciiPayload:'!Ep:PZ',unicodePayload:'垮캯'}
   :{codec:String(threadId),payload:'DAAAAAAA'};
  parentPort.postMessage({id,type:'encoded',candidates:[candidate]});
 });
 parentPort.postMessage({type:'ready'});
`)
);
const code = (expected) => (error) => error.code === expected;

test('extra compression has a hard deadline and four queued jobs; a stopped worker is replaced', async () => {
  const pool = await createCompressionPool({ workerURL });
  try {
    const before = await pool.encode('https://example.com/');
    await assert.rejects(
      pool.encode('https://fail.example/'),
      code('UNAVAILABLE')
    );
    assert.notEqual(
      (await pool.encode('https://example.com/'))[0].codec,
      before[0].codec
    );
    assert.equal(
      (await pool.encode('https://direct.example/'))[0].unicodePayload,
      '垮캯'
    );
    const jobs = Promise.allSettled([
      pool.encode('https://hang.example/'),
      ...Array.from({ length: 4 }, () => pool.encode('https://example.com/'))
    ]);
    await assert.rejects(pool.encode('https://example.com/'), code('BUSY'));
    const results = await jobs;
    assert.ok(
      results.every(
        (r) => r.status === 'rejected' && r.reason.code === 'DEADLINE'
      )
    );
    const after = await pool.encode('https://example.com/');
    assert.notEqual(after[0].codec, before[0].codec);
    for (const input of [
      'javascript:alert(1)',
      'https://example.com/\n',
      'https://example.com/' + 'x'.repeat(32768)
    ])
      await assert.rejects(pool.encode(input), code('INVALID'));
  } finally {
    await pool.close();
  }
});

test('extra compression cancellation removes pending work and closing releases the worker', async () => {
  const pool = await createCompressionPool({ workerURL, deadlineMs: 1000 });
  try {
    const controller = new AbortController(),
      job = pool.encode('https://hang.example/', { signal: controller.signal });
    const stopped = assert.rejects(job, code('ABORTED'));
    controller.abort();
    await stopped;
    assert.equal((await pool.encode('https://example.com/')).length, 1);
  } finally {
    await pool.close();
    await pool.close();
  }
  await assert.rejects(pool.encode('https://example.com/'), code('CLOSED'));
});

test('client extra pass uses same-origin POST without cookies and renders the selected format', async () => {
  const fixture = { codec: 'test', payload: 'DAAAAAAA' },
    origin = 'http://127.0.0.1:8788';
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url.href, origin + '/api/compress');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, 'https://example.com/');
    assert.equal(options.headers['X-Pi-Format'], 'compact');
    return Response.json(fixture);
  };
  assert.deepEqual(
    await enhance('https://example.com/', { origin, fetchImpl }),
    { ...renderResult(fixture, { origin }), enhanced: true }
  );
  assert.equal(calls, 1);
});

test('client accepts validated mixed Unicode and ASCII results', async () => {
  const origin = 'http://127.0.0.1:8788';
  const fixture = {
    codec: 'mixed-v1',
    asciiPayload: '!Ep:PZ',
    unicodePayload: '垮캯'
  };
  const result = await enhance('https://example.com/', {
    origin,
    fetchImpl: async () => Response.json(fixture)
  });
  assert.equal(result.payload, fixture.unicodePayload);
  assert.equal(result.asciiPayload, fixture.asciiPayload);
  assert.equal(result.transport, 'direct');
});

test('client extra pass fails quietly on errors, huge bodies, bad frames and oversized inputs', async () => {
  const origin = 'http://127.0.0.1:8788',
    input = 'https://example.com/';
  for (const response of [
    new Response('', { status: 429 }),
    new Response(null, { status: 204 }),
    new Response('nope'),
    new Response('x'.repeat(10001), {
      headers: { 'Content-Type': 'application/json' }
    }),
    Response.json({ codec: 'bad', payload: '../../evil' }),
    Response.json({ codec: 'bad', payload: 'https://evil.example/' }),
    Response.json({
      codec: 'bad',
      payload: 'DAAAAAAA',
      unicodePayload: '垮캯'
    }),
    Response.json({
      codec: 'predict-v2',
      payload: 'DAAAAAAA',
      unicodePayload: '🙂🙂🙂'
    }),
    Response.json({
      codec: 'mixed-v1',
      payload: 'DAAAAAAA',
      unicodePayload: '垮캯'
    }),
    Response.json({
      codec: 'mixed-v1',
      asciiPayload: '!Ep:PZ',
      unicodePayload: '🙂🙂🙂'
    })
  ])
    assert.equal(
      await enhance(input, { origin, fetchImpl: async () => response }),
      null
    );
  assert.equal(
    await enhance(input, {
      origin,
      fetchImpl: async () => {
        throw Error('offline');
      }
    }),
    null
  );
  assert.equal(
    await enhance(input + 'x'.repeat(32768), {
      origin,
      fetchImpl: async () => {
        throw Error('must not be called');
      }
    }),
    null
  );
});
