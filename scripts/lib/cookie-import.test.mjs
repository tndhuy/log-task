import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  decryptCookieValue,
  chromiumEpochToUnix,
  mapSameSite,
  toPlaywrightCookie,
} from './cookie-import.mjs';

function encryptForFixture(plainValue, key) {
  const iv = Buffer.alloc(16, 0x20); // Chromium's cookie store uses 16 space chars as IV
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const metadata = Buffer.alloc(32, 0); // Chromium prefixes 32 bytes of metadata
  const payload = Buffer.concat([metadata, Buffer.from(plainValue, 'utf-8')]);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), encrypted]);
}

test('decryptCookieValue decrypts a v10-encoded cookie', () => {
  const key = crypto.pbkdf2Sync('test-password', 'saltysalt', 1003, 16, 'sha1');
  const encrypted = encryptForFixture('session-token-abc123', key);
  const row = { value: '', encrypted_value: encrypted };
  const keys = new Map([['v10', key]]);
  assert.equal(decryptCookieValue(row, keys), 'session-token-abc123');
});

test('decryptCookieValue returns the unencrypted value directly when present', () => {
  const row = { value: 'plain-value', encrypted_value: Buffer.alloc(0) };
  assert.equal(decryptCookieValue(row, new Map()), 'plain-value');
});

test('decryptCookieValue throws a clear error for v20 (unsupported encoding)', () => {
  const row = { value: '', encrypted_value: Buffer.concat([Buffer.from('v20'), Buffer.alloc(10)]) };
  assert.throws(() => decryptCookieValue(row, new Map()), /not supported/);
});

test('decryptCookieValue throws when no key is available for the prefix', () => {
  const encrypted = Buffer.concat([Buffer.from('v11'), Buffer.alloc(20)]);
  const row = { value: '', encrypted_value: encrypted };
  assert.throws(() => decryptCookieValue(row, new Map()), /No decryption key/);
});

test('chromiumEpochToUnix converts a known Chromium timestamp back to Unix seconds', () => {
  const unixSeconds = 1767225600n; // 2026-01-01T00:00:00Z
  const chromiumMicros = unixSeconds * 1000000n + 11644473600000000n;
  assert.equal(chromiumEpochToUnix(chromiumMicros, 1), Number(unixSeconds));
});

test('chromiumEpochToUnix returns -1 for session cookies (has_expires = 0)', () => {
  assert.equal(chromiumEpochToUnix(0n, 0), -1);
});

test('mapSameSite maps Chromium integers to Playwright sameSite strings', () => {
  assert.equal(mapSameSite(0), 'None');
  assert.equal(mapSameSite(1), 'Lax');
  assert.equal(mapSameSite(2), 'Strict');
  assert.equal(mapSameSite(99), 'Lax'); // unknown values default to Lax, same as upstream
});

test('toPlaywrightCookie builds a complete Playwright cookie object', () => {
  const row = {
    name: 'session', host_key: 'eoffice.novagroup.vn', path: '/',
    expires_utc: 0n, has_expires: 0, is_secure: 1, is_httponly: 1, samesite: 1,
  };
  assert.deepEqual(toPlaywrightCookie(row, 'abc123'), {
    name: 'session', value: 'abc123', domain: 'eoffice.novagroup.vn', path: '/',
    expires: -1, secure: true, httpOnly: true, sameSite: 'Lax',
  });
});
