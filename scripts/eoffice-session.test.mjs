import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageState } from './eoffice-session.mjs';

test('buildStorageState wraps cookies into Playwright storageState shape', () => {
  const cookies = [{
    name: 'session', value: 'abc', domain: 'eoffice.novagroup.vn', path: '/',
    expires: -1, secure: true, httpOnly: true, sameSite: 'Lax',
  }];
  assert.deepEqual(buildStorageState(cookies), { cookies, origins: [] });
});

test('buildStorageState handles an empty cookie list', () => {
  assert.deepEqual(buildStorageState([]), { cookies: [], origins: [] });
});
