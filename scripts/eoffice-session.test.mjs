import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStorageState, saveStorageState } from './eoffice-session.mjs';

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

test('saveStorageState stores session credentials with owner-only permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-task-session-test-'));
  const sessionPath = join(dir, 'session.json');
  const cookies = [{ name: 'session', value: 'secret' }];

  saveStorageState(sessionPath, cookies);

  assert.deepEqual(JSON.parse(readFileSync(sessionPath, 'utf8')), { cookies, origins: [] });
  assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
});
