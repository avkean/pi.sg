import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInput } from '../src/input.mjs';

test('pasted addresses preserve spelling and add https only to a bare domain', () => {
  const exact = 'HtTp://EXAMPLE.com:80/%2f?a=1&a=2&x=a+b#É';
  assert.equal(prepareInput('  ' + exact + '\n'), exact);
  assert.equal(
    prepareInput('example.com/path?q=1#section'),
    'https://example.com/path?q=1#section'
  );
  assert.equal(
    prepareInput('example.com:8443/path'),
    'https://example.com:8443/path'
  );
  assert.equal(prepareInput('例子.测试/路径'), 'https://例子.测试/路径');
  assert.equal(prepareInput('  '), '');
  for (const invalid of [
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'ftp://example.com',
    'not a link',
    '/relative'
  ])
    assert.throws(() => prepareInput(invalid));
});
