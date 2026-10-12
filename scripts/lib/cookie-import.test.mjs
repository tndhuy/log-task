import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  decryptCookieValue,
  chromiumEpochToUnix,
  mapSameSite,
  toPlaywrightCookie,
  validateProfile,
  decryptRows,
  getBrowser,
  BROWSER_NAMES,
  domainsFor,
  cookieHeader,
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

test('validateProfile rejects path separators and traversal', () => {
  assert.throws(() => validateProfile('../etc/passwd'), /Invalid profile/);
  assert.throws(() => validateProfile('a/b'), /Invalid profile/);
  assert.throws(() => validateProfile('a\\b'), /Invalid profile/);
});

test('validateProfile rejects control characters', () => {
  assert.throws(() => validateProfile('Default\x00'), /Invalid profile/);
});

test('validateProfile accepts a normal profile name', () => {
  assert.doesNotThrow(() => validateProfile('Default'));
  assert.doesNotThrow(() => validateProfile('Profile 1'));
});

test('decryptRows skips a row with a per-row decrypt failure but keeps going', () => {
  const goodRow = {
    name: 'a', host_key: 'x.test', path: '/', expires_utc: 0n, has_expires: 0,
    is_secure: 1, is_httponly: 1, samesite: 1, value: 'plain', encrypted_value: Buffer.alloc(0),
  };
  const badRow = {
    name: 'b', host_key: 'x.test', path: '/', expires_utc: 0n, has_expires: 0,
    is_secure: 1, is_httponly: 1, samesite: 1, value: '',
    encrypted_value: Buffer.concat([Buffer.from('v11'), Buffer.alloc(10)]), // no v11 key below
  };
  const result = decryptRows([goodRow, badRow], new Map());
  assert.equal(result.count, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.cookies[0].name, 'a');
});

test('decryptRows propagates a v20 (unsupported encoding) error instead of swallowing it', () => {
  const v20Row = {
    name: 'a', host_key: 'x.test', path: '/', expires_utc: 0n, has_expires: 0,
    is_secure: 1, is_httponly: 1, samesite: 1, value: '',
    encrypted_value: Buffer.concat([Buffer.from('v20'), Buffer.alloc(10)]),
  };
  assert.throws(() => decryptRows([v20Row], new Map()), /not supported/);
});

test('getBrowser knows Chrome and Brave with their own Keychain services', () => {
  assert.deepEqual(BROWSER_NAMES, ['chrome', 'brave']);
  assert.equal(getBrowser('brave').keychainService, 'Brave Safe Storage');
  assert.equal(getBrowser('chrome').keychainService, 'Chrome Safe Storage');
});

test('getBrowser rejects an unknown browser', () => {
  assert.throws(() => getBrowser('firefox'), /Unsupported browser/);
});

test('domainsFor lists the host and its dotted parent domains, never the top-level suffix', () => {
  assert.deepEqual(domainsFor('eoffice-uat.novagroup.vn'), [
    'eoffice-uat.novagroup.vn', '.eoffice-uat.novagroup.vn', '.novagroup.vn',
  ]);
});

test('cookieHeader joins cookies into a Cookie header value', () => {
  assert.equal(cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2');
});
