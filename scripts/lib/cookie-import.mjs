// scripts/lib/cookie-import.mjs
//
// Ported from gstack's browse/src/cookie-import-browser.ts.
// Source: ~/.claude/skills/gstack/browse/src/cookie-import-browser.ts
//
// Scope of this port: macOS + Linux, Chrome only, "Default" profile.
// Windows (DPAPI key unwrap) and v20 App-Bound Encryption (Chrome 127+ on
// Windows) are NOT ported -- decryptCookieValue throws for v20 instead of
// silently failing; getHostPlatform() throws for any platform other than
// darwin/linux.
//
// MIT License
//
// Copyright (c) 2026 Garry Tan
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

export class CookieImportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CookieImportError';
    this.code = code;
  }
}

const CHROME = {
  darwinDataDir: 'Google/Chrome',
  linuxDataDir: 'google-chrome',
  keychainService: 'Chrome Safe Storage',
};

const CHROMIUM_EPOCH_OFFSET = 11644473600000000n;
const keyCache = new Map();

function getHostPlatform() {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux') return p;
  throw new CookieImportError(
    `Unsupported platform: ${p} (this port only supports macOS and Linux)`,
    'unsupported_platform',
  );
}

function getBaseDir(platform) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return path.join(os.homedir(), '.config');
}

export function validateProfile(profile) {
  if (/[/\\]|\.\./.test(profile) || /[\x00-\x1f]/.test(profile)) {
    throw new CookieImportError(`Invalid profile name: '${profile}'`, 'bad_request');
  }
}

function getCookieDbPath(profile) {
  validateProfile(profile);
  const platform = getHostPlatform();
  const dataDir = platform === 'darwin' ? CHROME.darwinDataDir : CHROME.linuxDataDir;
  const dbPath = path.join(getBaseDir(platform), dataDir, profile, 'Cookies');
  if (!fs.existsSync(dbPath)) {
    throw new CookieImportError(
      `Chrome is not installed or has no cookies (looked for ${dbPath})`,
      'not_installed',
    );
  }
  return { dbPath, platform };
}

function openDb(dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.defaultSafeIntegers(true);
    return db;
  } catch (err) {
    if (String(err.message).includes('SQLITE_BUSY') || String(err.message).includes('locked')) {
      return openDbFromCopy(dbPath);
    }
    throw err;
  }
}

function openDbFromCopy(dbPath) {
  const tmpPath = path.join(os.tmpdir(), `log-task-session-${crypto.randomUUID()}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, tmpPath + suffix);
    }
    const db = new Database(tmpPath, { readonly: true, fileMustExist: true });
    db.defaultSafeIntegers(true);
    const origClose = db.close.bind(db);
    db.close = () => {
      origClose();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpPath + suffix); } catch {}
      }
    };
    return db;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new CookieImportError(
      'Session database is locked (Chrome may be running). Close Chrome and retry.',
      'db_locked',
    );
  }
}

function getMacKeychainPassword(service) {
  const result = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) {
    throw new CookieImportError(`Could not read Keychain: ${result.error.message}`, 'keychain_error');
  }
  if (result.status !== 0) {
    const err = (result.stderr || '').toLowerCase();
    if (err.includes('could not be found')) {
      throw new CookieImportError(`No Keychain entry for "${service}". Is Chrome installed?`, 'keychain_not_found');
    }
    throw new CookieImportError(`Keychain access denied for "${service}". Click "Allow" in the macOS dialog.`, 'keychain_denied');
  }
  return result.stdout.trim();
}

function getLinuxSecretPassword(service) {
  const result = spawnSync('secret-tool', ['lookup', 'Title', service], { encoding: 'utf-8', timeout: 3_000 });
  if (result.status !== 0 || !result.stdout) return null;
  const password = result.stdout.trim();
  return password.length > 0 ? password : null;
}

function deriveKey(password, iterations) {
  return crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

function getDerivedKeys(platform) {
  if (platform === 'darwin') {
    const cacheKey = 'darwin:v10';
    if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
    const password = getMacKeychainPassword(CHROME.keychainService);
    const keys = new Map([['v10', deriveKey(password, 1003)]]);
    keyCache.set(cacheKey, keys);
    return keys;
  }
  const cacheKey = 'linux';
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
  const keys = new Map([['v10', deriveKey('peanuts', 1)]]);
  const linuxPassword = getLinuxSecretPassword(CHROME.keychainService);
  if (linuxPassword) keys.set('v11', deriveKey(linuxPassword, 1));
  keyCache.set(cacheKey, keys);
  return keys;
}

export function decryptCookieValue(row, keys) {
  if (row.value && row.value.length > 0) return row.value;
  const ev = Buffer.from(row.encrypted_value);
  if (ev.length === 0) return '';
  const prefix = ev.subarray(0, 3).toString('utf-8');
  if (prefix === 'v20') {
    throw new CookieImportError(
      'This cookie uses an encoding (v20) that is not supported by this port.',
      'v20_encryption',
    );
  }
  const key = keys.get(prefix);
  if (!key) throw new CookieImportError(`No decryption key available for ${prefix} cookies`, 'no_key');
  const ciphertext = ev.subarray(3);
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.length <= 32) return '';
  return plaintext.subarray(32).toString('utf-8');
}

export function chromiumEpochToUnix(epoch, hasExpires) {
  const epochBig = BigInt(epoch);
  if (hasExpires === 0 || epochBig === 0n) return -1;
  return Number((epochBig - CHROMIUM_EPOCH_OFFSET) / 1000000n);
}

export function mapSameSite(value) {
  const v = Number(value);
  switch (v) {
    case 0: return 'None';
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';
  }
}

export function toPlaywrightCookie(row, value) {
  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || '/',
    expires: chromiumEpochToUnix(row.expires_utc, Number(row.has_expires)),
    secure: Number(row.is_secure) === 1,
    httpOnly: Number(row.is_httponly) === 1,
    sameSite: mapSameSite(row.samesite),
  };
}

function chromiumNow() {
  return BigInt(Date.now()) * 1000n + CHROMIUM_EPOCH_OFFSET;
}

export function decryptRows(rows, keys) {
  const cookies = [];
  let failed = 0;
  for (const row of rows) {
    try {
      const value = decryptCookieValue(row, keys);
      cookies.push(toPlaywrightCookie(row, value));
    } catch (err) {
      // A per-row decrypt failure (corrupt value, mismatched key) is
      // recoverable -- skip that row and keep going. An unsupported
      // encoding is a browser-wide condition, not a per-row one: let it
      // propagate so the caller can react (see references/eoffice.md /
      // DESIGN.md -- never silently return wrong/empty data for this case).
      if (err instanceof CookieImportError && err.code === 'v20_encryption') {
        throw err;
      }
      failed++;
    }
  }
  return { cookies, count: cookies.length, failed };
}

export function importCookies(domains, profile = 'Default') {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0 };
  const { dbPath, platform } = getCookieDbPath(profile);
  const keys = getDerivedKeys(platform);
  const db = openDb(dbPath);
  try {
    const now = chromiumNow();
    const placeholders = domains.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
              is_secure, is_httponly, has_expires, samesite
       FROM cookies
       WHERE host_key IN (${placeholders})
         AND (has_expires = 0 OR expires_utc > ?)
       ORDER BY host_key, name`
    ).all(...domains, now);
    return decryptRows(rows, keys);
  } finally {
    db.close();
  }
}
