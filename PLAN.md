# log-task Implementation Plan

Current status (2026-09-03): the eOffice writer, recorded semantic form map,
discovery utility, adapter documentation, dry-run fixtures, and automated
tests are implemented. The remaining operational gate is a supervised live
run after the ignored `projects.json` is configured with confirmed visible
names; no automated test submits to eOffice.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `log-task` Claude Code skill at `~/.claude/skills/log-task/` — a manually-invoked (`/log-task`) tool that gathers evidence of completed work (git commits, Claude history, checkpoint notes), dedupes it against a per-project ledger, drafts it in a platform-specific shape, and — after explicit approval — writes it to that project's declared platform (`eoffice`, `lark`, or `manual`).

**Architecture:** Mostly instruction-driven (`SKILL.md` + `references/*.md`) for the shared pipeline and for `lark`/`manual`. `eoffice` is the one platform needing real code: a ported, Node-compatible copy of gstack's MIT-licensed Chrome cookie-import logic, a thin session-capture wrapper, and a Playwright script that fills/submits eOffice's two real actions -- create-task and report-progress, each independently confirmed -- using a data-driven, semantic-locator field map (populated during a discovery task, not guessed; revised 2026-08-28 against a real reference recording of the eOffice UI).

**Tech Stack:** Node.js (`node:test`, `better-sqlite3`, `node:child_process`, `node:crypto`), `better-sqlite3` (npm), `playwright` (npm), `lark-cli` (external binary, not bundled), `git`, `jq`.

**Spec:** `/Users/trannguyendanghuy/.claude/skills/log-task/DESIGN.md` — read it before starting; this plan implements it and does not re-derive its decisions.

## Global Constraints

- Portable: no dependency on gstack, `/browse`, or any specific MCP server. Only Node.js + npm packages this skill declares itself, or the external `lark-cli` binary the user installs separately.
- Every write to a real platform (`lark`, `eoffice`) is preceded by a dry-run/preview shown to the user, followed by an explicit second confirmation before the real write. `manual` has no real write, just a saved draft.
- Ledger dedup uses an exact fingerprint (`sha1(project-key + "|" + normalized-task-name + "|" + evidence-commit-range)`) — no fuzzy matching (per DESIGN.md Non-goals).
- `.eoffice-session.json` and `node_modules/` must never be committed — both are gitignored from the start.
- `scripts/lib/cookie-import.mjs` is a port of gstack's `browse/src/cookie-import-browser.ts` (MIT License, Copyright (c) 2026 Garry Tan) — the file must carry the full original MIT license text plus a comment noting it is ported from that source path, per the license's "include the copyright notice" term. This file's purpose is exclusively to let the user's own automation reuse a session they already authenticated themselves — it must never be pointed at any domain the user hasn't explicitly configured in `projects.json`.
- v1 scope for `cookie-import.mjs` is macOS + Linux, Chrome only, "Default" profile. Windows (DPAPI key unwrap) and v20 App-Bound Encryption (Chrome 127+ on Windows) are explicitly out of scope — the code must throw a clear error naming what's unsupported, never silently return wrong/empty data.
- No automatic/proactive triggering, no formal adapter/plugin registry, no fuzzy dedup, no 2FA/SSO automation (per DESIGN.md Non-goals) — do not add any of these "for completeness."

---

## File Structure

```
~/.claude/skills/log-task/
├── SKILL.md                       # entry point for /log-task — the 7-step orchestrator
├── DESIGN.md                      # already written (this plan's spec)
├── PLAN.md                        # this file
├── package.json                   # playwright, better-sqlite3
├── .gitignore                     # node_modules/, .eoffice-session.json
├── projects.json                  # central platform config, keyed by project path
├── ledger/
│   └── .gitkeep
├── references/
│   ├── manual.md                  # draft-only template
│   ├── lark.md                    # Lark field mapping + lark-cli dry-run/write sequence
│   ├── eoffice.md                 # eOffice draft template + eoffice-write.mjs usage
│   └── eoffice-form-map.json      # discovered field name -> CSS selector map (Task 5 output)
└── scripts/
    ├── lib/
    │   ├── cookie-import.mjs      # ported local-session reader (macOS/Linux)
    │   └── cookie-import.test.mjs
    ├── eoffice-session.mjs        # imports eoffice.novagroup.vn session -> .eoffice-session.json
    ├── eoffice-session.test.mjs
    └── eoffice-write.mjs          # Playwright: dry-run + real submit against eOffice
```

---

### Task 1: Scaffold the skill directory

**Files:**
- Create: `~/.claude/skills/log-task/package.json`
- Create: `~/.claude/skills/log-task/.gitignore`
- Create: `~/.claude/skills/log-task/projects.json`
- Create: `~/.claude/skills/log-task/ledger/.gitkeep`

**Interfaces:**
- Produces: `projects.json`'s schema — `{ "<absolute-project-path>": { "platform": "eoffice"|"lark"|"manual", "gitEmails": string[], "params": object } }` — every later task reads this file with this exact shape.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "log-task",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Personal skill: log completed work into a project's declared platform (eoffice, lark, or manual).",
  "scripts": {
    "test": "node --test scripts/**/*.test.mjs"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "playwright": "^1.47.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.eoffice-session.json
```

- [ ] **Step 3: Create `projects.json` as an empty config**

```json
{}
```

- [ ] **Step 4: Create `ledger/.gitkeep`** (empty file, keeps the directory present before any project has a ledger)

- [ ] **Step 5: Install dependencies and verify**

Run: `cd ~/.claude/skills/log-task && npm install`
Expected: completes with no errors; `node_modules/better-sqlite3` and `node_modules/playwright` exist.

- [ ] **Step 6: Verify `projects.json` parses**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('projects.json','utf-8')))"`
Expected: prints `{}`

---

### Task 2: Local-session reader for eOffice (`cookie-import.mjs`)

**Files:**
- Create: `~/.claude/skills/log-task/scripts/lib/cookie-import.mjs`
- Test: `~/.claude/skills/log-task/scripts/lib/cookie-import.test.mjs`
- Reference (read-only, do not modify): `~/.claude/skills/gstack/browse/src/cookie-import-browser.ts`

**Interfaces:**
- Produces (used by Task 3): `importCookies(domains: string[], profile?: string) -> { cookies: PlaywrightCookie[], count: number, failed: number }`, `class CookieImportError extends Error { code: string }`.
- Produces (unit-tested directly): `decryptCookieValue(row, keysMap) -> string`, `chromiumEpochToUnix(epoch: bigint|number, hasExpires: number) -> number`, `mapSameSite(value: number) -> 'None'|'Lax'|'Strict'`, `toPlaywrightCookie(row, value) -> PlaywrightCookie` where `PlaywrightCookie = { name, value, domain, path, expires, secure, httpOnly, sameSite }`.

**Purpose reminder for whoever implements this:** this reads the *current user's own, already-authenticated* browser session for a domain *they* configured in `projects.json`, purely so their own `/log-task` automation can reuse a login they already have — the same idea as Playwright's documented `storageState` reuse pattern, just sourced from the real browser profile instead of a prior Playwright run. It is not for reading any other site's session, and it must never run against a domain that isn't explicitly passed in by the caller.

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/cookie-import.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/.claude/skills/log-task && node --test scripts/lib/cookie-import.test.mjs`
Expected: FAIL — `cookie-import.mjs` does not exist yet (module not found).

- [ ] **Step 3: Write `cookie-import.mjs`**

Port `~/.claude/skills/gstack/browse/src/cookie-import-browser.ts`'s macOS/Linux, Chrome-only path (that file's own top-of-file comment documents the exact decryption pipeline this follows — read it alongside this step). Keep its MIT header and add an attribution comment. Key differences from upstream: `bun:sqlite` -> `better-sqlite3` (`db.query(sql).all(...)` becomes `db.prepare(sql).all(...)`, and the DB must be opened with `.defaultSafeIntegers(true)` so 64-bit timestamps round-trip as `BigInt` instead of losing precision as `Number`); `Bun.spawn` -> `node:child_process.spawnSync` (which has a built-in `timeout` option, so no manual `Promise.race` timeout dance is needed); no `./platform.ts` import — inline the one constant it provided directly via `os.tmpdir()`.

```js
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

function getCookieDbPath(profile) {
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
    const cookies = [];
    let failed = 0;
    for (const row of rows) {
      try {
        const value = decryptCookieValue(row, keys);
        cookies.push(toPlaywrightCookie(row, value));
      } catch {
        failed++;
      }
    }
    return { cookies, count: cookies.length, failed };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/.claude/skills/log-task && node --test scripts/lib/cookie-import.test.mjs`
Expected: PASS -- all 8 tests green.

- [ ] **Step 5: Manual verification against the real Chrome profile (not part of the automated suite)**

Run:
```bash
cd ~/.claude/skills/log-task
node -e "
import('./scripts/lib/cookie-import.mjs').then(async ({ importCookies }) => {
  const result = importCookies(['eoffice.novagroup.vn']);
  console.log(JSON.stringify({ count: result.count, failed: result.failed, names: result.cookies.map(c => c.name) }, null, 2));
});
"
```
Expected: `count` >= 1 (assumes you're currently logged into `eoffice.novagroup.vn` in Chrome -- log in there first if not). If it throws with `code: 'v20_encryption'`, your Chrome version has moved to the newer encoding -- stop here and re-open a design discussion with the user before continuing to Task 3, since the whole `eoffice` platform depends on this working.

---

### Task 3: `eoffice-session.mjs` -- capture the eOffice session

**Files:**
- Create: `~/.claude/skills/log-task/scripts/eoffice-session.mjs`
- Test: `~/.claude/skills/log-task/scripts/eoffice-session.test.mjs`

**Interfaces:**
- Consumes: `importCookies(domains, profile?)` and `CookieImportError` from `./lib/cookie-import.mjs` (Task 2).
- Produces (used by Task 6/7): writes Playwright `storageState` JSON to `~/.claude/skills/log-task/.eoffice-session.json`. Exit code `0` = success, `1` = no cookie found (not logged in), `2` = import error (e.g. Keychain denied).
- Produces (unit-tested directly): `buildStorageState(cookies: PlaywrightCookie[]) -> { cookies: PlaywrightCookie[], origins: [] }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/eoffice-session.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/.claude/skills/log-task && node --test scripts/eoffice-session.test.mjs`
Expected: FAIL -- `eoffice-session.mjs` does not exist yet.

- [ ] **Step 3: Write `eoffice-session.mjs`**

```js
#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCookies, CookieImportError } from './lib/cookie-import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, '..', '.eoffice-session.json');
const DOMAIN = 'eoffice.novagroup.vn';

export function buildStorageState(cookies) {
  return { cookies, origins: [] };
}

function main() {
  let result;
  try {
    result = importCookies([DOMAIN]);
  } catch (err) {
    if (err instanceof CookieImportError) {
      console.error(`Could not import eOffice session: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  if (result.count === 0) {
    console.error(`No ${DOMAIN} session found in Chrome. Log into eOffice in Chrome, then re-run this script.`);
    process.exit(1);
  }
  fs.writeFileSync(SESSION_PATH, JSON.stringify(buildStorageState(result.cookies), null, 2));
  console.log(`Saved eOffice session (${result.count} cookie(s)) to ${SESSION_PATH}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/.claude/skills/log-task && node --test scripts/eoffice-session.test.mjs`
Expected: PASS -- both tests green, and note that importing this module for the test does NOT trigger `main()` (the `isMain` guard prevents it -- verify no Keychain prompt appeared while running the test).

- [ ] **Step 5: Manual verification -- actually run it**

Run: `cd ~/.claude/skills/log-task && node scripts/eoffice-session.mjs`
Expected: prints `Saved eOffice session (N cookie(s)) to .../.eoffice-session.json`; `.eoffice-session.json` now exists and `cat .eoffice-session.json` shows a `cookies` array with a `domain: "eoffice.novagroup.vn"` entry.

---

### Task 4: `manual` and `lark` reference docs (no code)

**Files:**
- Create: `~/.claude/skills/log-task/references/manual.md`
- Create: `~/.claude/skills/log-task/references/lark.md`

**Interfaces:**
- Consumes: nothing (pure documentation, read by `SKILL.md` in Task 8).
- Produces: the draft-format contract that `SKILL.md`'s step 5 (Format) and step 7 (Write) follow for these two platforms.

There's no compiled code here, so "testing" means: after writing each file, check it against the acceptance checklist below rather than running an assertion.

- [ ] **Step 1: Write `references/manual.md`**

```markdown
# manual platform

No write integration. Used for any project not yet wired to a real platform.

## Draft format

Group candidate tasks by module/area (infer grouping from repo/path structure
in the evidence -- e.g. group by top-level service directory). For each task:

- **Task Name:** short description, prefixed `[BE]`/`[FE]`/etc. if the
  evidence clearly indicates a layer (mirrors nova's task-log convention).
- **Estimate:** inferred date range based on the size/complexity of the
  evidence (state this is inferred, never claim it's a stored value).
- **Actual evidence:** date range actually observed in git/history/checkpoint
  evidence.
- **Suggested log window:** which working day(s) to record this under.
- **Status:** `Done` / `Partial` / `Investigation completed` etc., only when
  the evidence doesn't clearly show full completion.
- **Evidence:** commit hashes / history entries / checkpoint file references
  backing the task.

End the draft with:
- A "Nguon doi chieu" / "Sources" footer listing exactly which evidence types
  were consulted (git log with date range and filtered emails; Claude
  history.jsonl; checkpoint/.remember files) for this project + window.

## Write procedure

1. Save the draft to `<project-root>/task-log-<window-start>-to-<window-end>.md`.
2. Print: "Draft saved to <path>. No platform is wired for this project --
   log it yourself wherever it needs to go."
3. Append each logged task to the ledger with no `externalId`.
```

- [ ] **Step 2: Write `references/lark.md`**

```markdown
# lark platform

Writes via the external `lark-cli` binary (not bundled -- the user installs
it separately, same as `git`).

## Required `params` in projects.json

- `baseToken` -- the Lark Base token (e.g. `xxxxxxxxxxxxxxxxxxxxxxxxxxx`).
- `tableId` -- the target table ID (e.g. `tbl0ZxyrZF4XeDD8` for a Task table).
- `prefix` -- short project tag prepended to every record's title field, e.g.
  `[Dominode]`, to disambiguate projects sharing one base.

## Draft format

Same grouping/fields as `manual.md`'s draft, but each task additionally maps
to the target table's field names (ask the user for the table's field list
via `lark-cli base +record-list --format json` if `params` doesn't already
document them, and cache that mapping in `params.fieldMap` for next time).

## Write procedure

1. Build one `--json` field map per candidate task, title prefixed with
   `params.prefix`.
2. Preview: run
   `lark-cli base +record-upsert --base-token <baseToken> --table-id <tableId> --json '<fields>' --dry-run`
   for each task (or `+record-batch-create --dry-run` if the CLI supports
   batching multiple tasks in one call -- check
   `lark-cli base +record-batch-create --help` first).
3. Show the dry-run output to the user, get an explicit second confirmation.
4. Re-run the same command(s) without `--dry-run`.
5. Parse the returned record ID(s) from the command output and append each
   logged task to the ledger with `externalId` set to that record ID.
6. If a record fails, don't retry automatically -- report which task failed
   and why, ledger only the ones that succeeded.
```

- [ ] **Step 3: Acceptance checklist (manual verification, not an automated test)**

For each file, confirm:
- [ ] It states its write procedure as a numbered, unambiguous sequence (no "handle appropriately").
- [ ] It states exactly what goes in the ledger entry (or that nothing does).
- [ ] `lark.md` names the exact `lark-cli` subcommands and flags used, not "run the appropriate lark-cli command."

---

### Task 5: `references/eoffice-form-map.json` -- discover the two real forms

**Revised 2026-08-28** after the user supplied a separate Codex-built
recording of the real eOffice UI (`nova-work-log-deliverable.zip`). Real
eOffice task logging is **two separate screens reached by manual
navigation, not one URL**: (1) Project -> Tasks -> Add task -> Add task
(again, to open the form) -- creates the task; (2) open the task by title
-> Report -> Task progress report -- marks it done. Neither screen has a
stable, guessable URL, so this discovery pass is interactive: the human
navigates, the script waits for a keypress, then dumps the visible form.
Both forms also require **people fields** (assignor, assignee, follower,
collaborator) that Task 6/7 will need to resolve from `projects.json`.

**Files:**
- Create: `~/.claude/skills/log-task/scripts/discover-eoffice-form.mjs`
- Create: `~/.claude/skills/log-task/references/eoffice-form-map.json` (output)

**Interfaces:**
- Consumes: `.eoffice-session.json` (Task 3's output) as Playwright `storageState`.
- Produces (used by Task 6/7): `eoffice-form-map.json` --
  ```json
  {
    "createTask": {
      "navigation": "Project -> Tasks -> Add task -> Add task",
      "fields": { "<logicalName>": { "locatorType": "label"|"role"|"text", "locatorValue": string, "role": string | null, "type": "text"|"select"|"date"|"textarea"|"person" } },
      "submitLocator": { "locatorType": "role"|"label"|"text", "locatorValue": string, "role": string | null },
      "successSignal": { "locatorType": "role"|"label"|"text", "locatorValue": string, "role": string | null, "matches": string }
    },
    "reportProgress": { "navigation": string, "fields": {...same shape...}, "submitLocator": {...}, "successSignal": {...} }
  }
  ```
  `locatorType: "role"` pairs with Playwright's `getByRole(role, {name: locatorValue})`; `"label"` pairs with `getByLabel(locatorValue)`; `"text"` pairs with `getByText(locatorValue)`. Every later task builds real Playwright locators from this shape -- never a raw CSS selector string, per the real lesson from the reference recording ("target visible labels, not screen coordinates"). `type: "person"` fields (assignor/assignee/follower/collaborator) are filled by picking an option whose visible text matches a configured name, not typed as plain text.

- [ ] **Step 1: Confirm with the user which two screens to discover**

Ask: "Confirm the real navigation path for (a) creating a task, and (b) reporting its progress -- is it exactly 'Project -> Tasks -> Add task -> Add task' and 'open the task -> Report -> Task progress report' as seen in your reference recording, or does your actual eOffice instance differ?" Do not assume the reference recording's path is identical to this user's live instance -- confirm before writing the navigation string into the form map.

- [ ] **Step 2: Write `scripts/discover-eoffice-form.mjs`**

```js
#!/usr/bin/env node
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, '..', '.eoffice-session.json');
const MODE = process.argv[2]; // "create-task" | "report-progress"

if (MODE !== 'create-task' && MODE !== 'report-progress') {
  console.error('Usage: node discover-eoffice-form.mjs create-task|report-progress');
  process.exit(1);
}
if (!fs.existsSync(SESSION_PATH)) {
  console.error(`No session file at ${SESSION_PATH}. Run eoffice-session.mjs first.`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ storageState: SESSION_PATH });
const page = await context.newPage();
await page.goto('https://eoffice.novagroup.vn', { waitUntil: 'networkidle' });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`\nNavigate manually to the ${MODE} screen in the opened browser.`);
await rl.question('Press Enter here once the form is visible... ');
rl.close();

// Capture every labelled/interactive element: tag, role-relevant attributes,
// and the text of any <label> associated with it (via for=id, or by
// wrapping it) -- this is the raw material for choosing a getByRole/
// getByLabel/getByText locator by hand in Step 3, not a CSS selector.
const elements = await page.$$eval('input, select, textarea, button, [role]', (els) =>
  els.map((el) => {
    let labelText = null;
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${el.id}"]`);
      if (forLabel) labelText = forLabel.textContent?.trim();
    }
    if (!labelText) {
      const wrappingLabel = el.closest('label');
      if (wrappingLabel) labelText = wrappingLabel.textContent?.trim();
    }
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),
      labelText,
      text: el.tagName.toLowerCase() === 'button' ? el.textContent?.trim() : null,
    };
  })
);

console.log(JSON.stringify({ url: page.url(), elements }, null, 2));
console.log('\nBrowser left open for manual inspection. Close it when done, then Ctrl+C.');
await new Promise(() => {}); // keep the process alive so the user can inspect the page
```

- [ ] **Step 3: Run it for both screens and hand-write the form map**

Run: `cd ~/.claude/skills/log-task && node scripts/discover-eoffice-form.mjs create-task`, follow the prompt (navigate to Project -> Tasks -> Add task -> Add task, press Enter), inspect the printed elements. Repeat with `report-progress` for the other screen.

For each printed element, prefer in this order when choosing `locatorType`: (1) `role` + accessible name if the element has a real ARIA role and visible name (button/textbox/combobox roles are common), (2) `labelText` via `getByLabel`, (3) visible button/link `text` via `getByText`. Only fall back to matching on `id`/`name` if none of the above are present (and if so, still express it as a Playwright locator built from that value, e.g. `page.locator('#id')`, not by inventing a new locatorType outside the three above).

Write `references/eoffice-form-map.json` with both `createTask` and `reportProgress` sections. `createTask.fields` must include `taskName`, appropriate date field(s), a description/notes field, and the four person fields (`assignor`, `assignee`, `follower`, `collaborator`) each marked `"type": "person"`. `reportProgress.fields` must include a report date field, a progress field, and a description field. `reportProgress.successSignal` must describe the visible `100%` progress readout AND the `Evaluating` status text -- if these are two different elements, extend the schema's `successSignal` to an array of `{locatorType, locatorValue, role, matches}` rather than forcing both into one; document that shape here and use it consistently in Task 6/7.

- [ ] **Step 4: Verify the map is usable and complete**

Run: `node -e "const m = JSON.parse(require('fs').readFileSync('references/eoffice-form-map.json','utf-8')); console.log(Object.keys(m.createTask.fields)); console.log(Object.keys(m.reportProgress.fields));"`
Expected: `createTask.fields` includes `assignor`, `assignee`, `follower`, `collaborator` alongside the task fields; `reportProgress.fields` includes a progress and description field; no `REPLACE`-style placeholder values remain anywhere in the file.

---

### Task 6: `eoffice-write.mjs` -- dry-run mode, both actions

**Files:**
- Create: `~/.claude/skills/log-task/scripts/eoffice-write.mjs`
- Create: `~/.claude/skills/log-task/scripts/lib/eoffice-locators.mjs` (shared locator-builder, used by both this task and Task 7)

**Interfaces:**
- Consumes: `.eoffice-session.json` (Task 3), `references/eoffice-form-map.json` (Task 5).
- Produces (used by Task 7 and `SKILL.md`): CLI `node scripts/eoffice-write.mjs <create-task|report-progress> --dry-run <tasks.json>`. For `create-task`, `tasks.json` is `[{ "taskName": string, ...date/description fields matching the form map, "assignor": string, "assignee": string, "follower": string, "collaborator": string }]` -- person fields are visible names (e.g. `"Me"`, `"Sếp Châu"`), resolved by the caller (`references/eoffice.md`'s write procedure, Task 7) from `projects.json`'s `params` before this script ever runs; this script does not itself consult `projects.json`. For `report-progress`, `tasks.json` is `[{ "taskName": string, "reportDate": "YYYY-MM-DD", "progress": "100", "description": string }]`. Exit codes: `0` success, `3` no/invalid session, `4` form-map or required-field problem, `6` a person field's value doesn't match any option on the real form (ambiguous -- do not guess).

- [ ] **Step 1: Write the shared locator builder `scripts/lib/eoffice-locators.mjs`**

```js
// scripts/lib/eoffice-locators.mjs
//
// Builds a Playwright Locator from an eoffice-form-map.json entry shaped
// { locatorType: "role"|"label"|"text", locatorValue: string, role?: string }.
// Centralizing this in one place means Task 5's discovery format and
// Task 6/7's fill/submit code can never drift out of sync with each other.

export function buildLocator(page, spec) {
  if (spec.locatorType === 'role') {
    return page.getByRole(spec.role, { name: spec.locatorValue });
  }
  if (spec.locatorType === 'label') {
    return page.getByLabel(spec.locatorValue);
  }
  if (spec.locatorType === 'text') {
    return page.getByText(spec.locatorValue);
  }
  throw new Error(`Unknown locatorType "${spec.locatorType}" in eoffice-form-map.json`);
}
```

- [ ] **Step 2: Write `eoffice-write.mjs`'s shared setup + dry-run path**

```js
#!/usr/bin/env node
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocator } from './lib/eoffice-locators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, '..', '.eoffice-session.json');
const FORM_MAP_PATH = path.join(__dirname, '..', 'references', 'eoffice-form-map.json');

const [, , action, ...rest] = process.argv;
const dryRun = rest.includes('--dry-run');
const tasksPath = rest.find((a) => !a.startsWith('--'));

if (action !== 'create-task' && action !== 'report-progress') {
  console.error('Usage: node eoffice-write.mjs <create-task|report-progress> [--dry-run] <tasks.json>');
  process.exit(1);
}
if (!tasksPath) {
  console.error('Missing <tasks.json> argument.');
  process.exit(1);
}
if (!fs.existsSync(SESSION_PATH)) {
  console.error('No eOffice session found. Run eoffice-session.mjs first.');
  process.exit(3);
}
if (!fs.existsSync(FORM_MAP_PATH)) {
  console.error('No form map found. Run discover-eoffice-form.mjs first (Task 5).');
  process.exit(4);
}

const formMap = JSON.parse(fs.readFileSync(FORM_MAP_PATH, 'utf-8'));
const actionMap = action === 'create-task' ? formMap.createTask : formMap.reportProgress;
if (!actionMap) {
  console.error(`eoffice-form-map.json has no "${action === 'create-task' ? 'createTask' : 'reportProgress'}" section.`);
  process.exit(4);
}
const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));

const PERSON_FIELDS = ['assignor', 'assignee', 'follower', 'collaborator'];
for (const fieldName of Object.keys(actionMap.fields)) {
  for (const task of tasks) {
    if (!(fieldName in task)) {
      if (PERSON_FIELDS.includes(fieldName)) {
        console.error(`Task "${task.taskName || '(unnamed)'}" has no "${fieldName}" resolved. This must come from projects.json's params before eoffice-write.mjs runs -- never guessed here.`);
        process.exit(6);
      }
      console.error(`Task "${task.taskName || '(unnamed)'}" is missing field "${fieldName}" required by the form map.`);
      process.exit(4);
    }
  }
}

if (dryRun) {
  console.log(`Dry run (${action}) -- planned actions per task, no browser will be opened:`);
  for (const task of tasks) {
    console.log(`\n- Navigate: ${actionMap.navigation}`);
    for (const [fieldName, field] of Object.entries(actionMap.fields)) {
      console.log(`  Fill [${field.locatorType}:${field.locatorValue}] (${field.type}) with: ${task[fieldName]}`);
    }
    console.log(`  Click [${actionMap.submitLocator.locatorType}:${actionMap.submitLocator.locatorValue}]`);
    const signals = Array.isArray(actionMap.successSignal) ? actionMap.successSignal : [actionMap.successSignal];
    for (const signal of signals) {
      console.log(`  Confirm [${signal.locatorType}:${signal.locatorValue}] matches "${signal.matches}"`);
    }
  }
  process.exit(0);
}

console.error('Real-submit mode is not implemented yet (Task 7 of PLAN.md).');
process.exit(1);
```

- [ ] **Step 3: Verify the dry-run output for both actions**

Run:
```bash
cd ~/.claude/skills/log-task
echo '[{"taskName":"Test task","assignor":"Me","assignee":"Me","follower":"Sếp Châu","collaborator":"Sếp Châu","description":"Dry run check"}]' > /tmp/log-task-test-create.json
node scripts/eoffice-write.mjs create-task --dry-run /tmp/log-task-test-create.json

echo '[{"taskName":"Test task","reportDate":"2026-08-28","progress":"100","description":"Dry run check"}]' > /tmp/log-task-test-report.json
node scripts/eoffice-write.mjs report-progress --dry-run /tmp/log-task-test-report.json
```
Expected: each prints its own planned navigate/fill/click/confirm sequence using the real locator specs from `eoffice-form-map.json`, and exits `0`. No browser window opens for either (dry-run never launches Playwright's browser). Also run `create-task --dry-run` with a task object missing `"follower"` and confirm it exits `6` with the exact "must come from projects.json" message, not a generic missing-field error.

---

### Task 7: `eoffice-write.mjs` -- real submit mode (both actions) + `references/eoffice.md`

**Files:**
- Modify: `~/.claude/skills/log-task/scripts/eoffice-write.mjs`
- Create: `~/.claude/skills/log-task/references/eoffice.md`

**Interfaces:**
- Consumes: same as Task 6.
- Produces (used by `SKILL.md`, Task 9): real submission with a per-task success/failure result: `{ taskName: string, submitted: boolean, error?: string }[]`, printed as JSON on the last line of output so the caller can parse it. Same shape for both `create-task` and `report-progress` -- the caller distinguishes by which action it invoked.

- [ ] **Step 1: Replace the "not implemented" branch with real submission**

Replace the final `console.error('Real-submit mode...')` block in `eoffice-write.mjs` with:

```js
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: SESSION_PATH });
const page = await context.newPage();
const results = [];

for (const task of tasks) {
  try {
    await page.goto('https://eoffice.novagroup.vn', { waitUntil: 'networkidle' });
    // A login redirect means the session is stale -- fail fast with exit 3
    // rather than silently trying to fill a login form. eOffice's real
    // navigation is manual multi-click (Task 5), not a fixed deep-link URL,
    // so staleness is detected by absence of the expected first-step
    // element rather than a URL mismatch.
    if (page.url().includes('/login')) {
      console.error(`Redirected to login -- session appears expired. Re-run eoffice-session.mjs.`);
      await browser.close();
      process.exit(3);
    }

    for (const [fieldName, field] of Object.entries(actionMap.fields)) {
      const locator = buildLocator(page, field);
      if (field.type === 'select' || field.type === 'person') {
        await locator.selectOption({ label: task[fieldName] }).catch(async () => {
          // Some person/select fields are combobox-style rather than a
          // native <select> -- fall back to click + option-by-text.
          await locator.click();
          const option = page.getByRole('option', { name: task[fieldName] });
          if (!(await option.count())) {
            throw new Error(`No option matching "${task[fieldName]}" for field "${fieldName}" -- not guessing, stopping here.`);
          }
          await option.click();
        });
      } else {
        await locator.fill(String(task[fieldName]));
      }
    }

    const submitLocator = buildLocator(page, actionMap.submitLocator);
    await submitLocator.click();

    const signals = Array.isArray(actionMap.successSignal) ? actionMap.successSignal : [actionMap.successSignal];
    for (const signal of signals) {
      const signalLocator = buildLocator(page, signal);
      await signalLocator.waitFor({ timeout: 10_000 });
      const text = await signalLocator.innerText();
      if (!text.includes(signal.matches)) {
        throw new Error(`Success signal [${signal.locatorType}:${signal.locatorValue}] found but read "${text}", expected to include "${signal.matches}"`);
      }
    }
    results.push({ taskName: task.taskName, submitted: true });
  } catch (err) {
    results.push({ taskName: task.taskName, submitted: false, error: err.message });
  }
}

await browser.close();
console.log(JSON.stringify(results));
process.exit(results.every((r) => r.submitted) ? 0 : 5);
```

(Exit `5` = partial or total submission failure -- distinct from `3`/`4`/`6` so the caller can tell "some tasks failed to submit" apart from "session/config/ambiguous-person problem before we even tried.")

- [ ] **Step 2: Write `references/eoffice.md`**

```markdown
# eoffice platform

Writes via a bundled Playwright script -- no gstack, no MCP browser tool.
Real eOffice task logging is TWO separate actions, each with its own
confirmation gate -- never chain them without a check in between.

## One-time setup (per machine)

1. `cd ~/.claude/skills/log-task && npm install`
2. `npx playwright install chromium`
3. Log into `https://eoffice.novagroup.vn` in your normal Chrome.
4. `node scripts/eoffice-session.mjs` -- imports that session.
5. Configure default people fields for this project in `projects.json`'s
   `params`: `defaultAssignor`, `defaultAssignee`, `defaultFollower`,
   `defaultCollaborator` (visible names as they appear in eOffice, e.g.
   `"Me"`, `"Sếp Châu"`). If a task's evidence doesn't make one of these
   obvious and no default is configured, stop and ask -- never guess a
   person.

Re-run step 3-4 whenever `eoffice-write.mjs` reports session expired (exit
code 3).

## Draft format

Same grouping/fields as `manual.md`'s draft. Only tasks whose `Status` is
clearly `Done` are eligible for the `report-progress` step below --
`Partial`/`Investigation completed` tasks get created (if not already) but
never get a 100%-progress report, since that would misrepresent unfinished
work as complete.

## Write procedure

1. Convert the approved draft's tasks into the JSON shapes
   `eoffice-write.mjs` expects for each action (see
   `references/eoffice-form-map.json`'s `createTask.fields` /
   `reportProgress.fields` keys for exactly which keys each task object
   needs). Resolve `assignor`/`assignee`/`follower`/`collaborator` from
   `projects.json`'s `params.default*` fields; if a task's evidence
   suggests a different person than the default and it's genuinely
   ambiguous, stop and ask rather than picking one.
2. If `.eoffice-session.json` doesn't exist, run `node scripts/eoffice-session.mjs` first.
3. **Create step**: run `node scripts/eoffice-write.mjs create-task --dry-run <tasks.json>` for every task not already known to exist in eOffice, show the output, get an explicit confirmation, then run without `--dry-run`.
4. **Report step** (separate confirmation -- do not fold into step 3): for every task whose Status is `Done` (created just now, or already existing), run `node scripts/eoffice-write.mjs report-progress --dry-run <tasks.json>`, show the output, get a **second, separate** explicit confirmation, then run without `--dry-run`.
5. Parse the last line of each run's output as JSON (`{ taskName, submitted, error? }[]`). Ledger an entry only after **both** its create and report steps report `submitted: true` (no `externalId` -- eOffice's confirmation screens don't expose a stable row ID in this version). Report every `submitted: false` entry by name and its `error`, and stop -- don't retry automatically.
6. If a script exits with code `3`, tell the user to log into eOffice in Chrome and re-run `eoffice-session.mjs`, then retry from step 3. If it exits with code `6`, report exactly which person field was ambiguous and for which task, and ask the user to resolve it (fix `projects.json`'s default or clarify the task) before retrying.
```

- [ ] **Step 3: Verify -- single low-stakes task, headed, both actions separately**

Change `chromium.launch({ headless: true })` to `chromium.launch({ headless: false })` temporarily. Run `create-task` against one real, low-stakes task and watch it submit; confirm the task appears in eOffice. Then, as a **separate** run, run `report-progress` against that same task and watch it submit; confirm the task now reads `100%` / `Evaluating`. Do not skip straight to `report-progress` without having watched `create-task` succeed first — verifying each action independently is the point of having two gates. Change back to `headless: true` afterward.

---

### Task 8: `SKILL.md` -- the shared 7-step orchestrator

**Files:**
- Create: `~/.claude/skills/log-task/SKILL.md`

**Interfaces:**
- Consumes: `projects.json` (Task 1), `ledger/*.json`, `references/{manual,lark,eoffice}.md` (Tasks 4/7), `scripts/eoffice-session.mjs` + `scripts/eoffice-write.mjs` (Tasks 3/7), the external `lark-cli` binary.
- Produces: the `/log-task` entry point itself -- nothing downstream consumes this file's exports since it's the top of the call chain.

`SKILL.md` is instructions for Claude to follow, not compiled code -- there's no `assert` to write. Its "test" is a full dogfood run, specified concretely in Step 5 below.

- [ ] **Step 1: Write the frontmatter and trigger**

```markdown
---
name: log-task
description: Log completed work into a project's declared platform (eoffice, lark, or manual). Trigger: /log-task
---

# log-task

Invoked via `/log-task`. Runs the 7-step procedure below every time -- do not
skip steps or shortcut the approval gate in step 6, even if the user seems
to be in a hurry.
```

- [ ] **Step 2: Write steps 1-2 (resolve project, load ledger)**

```markdown
## Step 1: Resolve the project

Run `pwd` to get the current working directory. Read `projects.json`. Find
the config key that is a prefix of the current directory (if more than one
matches, use the longest). If none matches, stop and show the user this
template to add:

    "<absolute-path-to-project-root>": {
      "platform": "eoffice" | "lark" | "manual",
      "gitEmails": ["you@example.com"],
      "params": {}
    }

Never guess a platform for an unlisted project.

## Step 2: Load the ledger

Read `ledger/<project-key-with-slashes-replaced-by-dashes>.json`. If the file
doesn't exist, treat it as `[]`.
```

- [ ] **Step 3: Write step 3 (gather evidence) with real commands**

```markdown
## Step 3: Gather evidence

Ask the user for the date window if not already given (e.g. "log everything
since my last run" or an explicit range).

**Git commits**, run inside the project root, once per configured email,
unioning results by commit hash (checking BOTH author and committer date
catches rebased/cherry-picked commits the other check would miss):

    git log --all --since="<window-start>" --until="<window-end>" \
      --author="<email>" --date=iso-strict \
      --pretty=format:'%H|%ad|%an|%s'

    git log --all --since="<window-start>" --until="<window-end>" \
      --committer="<email>" --date=iso-strict \
      --pretty=format:'%H|%cd|%cn|%s'

**Claude prompt history**, filtered to this project and window:

    jq -c --arg proj "<project-root>" \
      'select(.project == $proj)' ~/.claude/history.jsonl

  Then filter the results to the window by comparing each entry's
  `.timestamp` (epoch milliseconds) against the window's start/end.

**Checkpoint / daily notes**, if present:

    ls <project-root>/.remember/today-*.done.md <project-root>/.checkpoint/*.md 2>/dev/null

  Read whichever of these fall inside the window.
```

- [ ] **Step 4: Write steps 4-7 (normalize, dedupe, format, approve, write)**

```markdown
## Step 4: Normalize and dedupe

From the raw evidence, synthesize candidate tasks: a short name, an inferred
estimate range, the actual evidence date range, a status if not clearly
"Done", and which evidence backs it. This is judgment, not a script -- match
the shape and rigor of
`/Users/trannguyendanghuy/Workspace/work/nova/task-log-2026-07-30-to-2026-08-26.md`
(grouped by module, Estimate / Actual evidence / Suggested log window /
Status / Evidence per task, sources footer at the end).

For each candidate, compute a fingerprint:

    echo -n "<project-key>|<normalized-task-name>|<evidence-commit-range>" | shasum -a 1 | cut -d' ' -f1

Drop any candidate whose fingerprint already appears in the loaded ledger.
If nothing is left, report "nothing new to log" and stop -- never produce an
empty draft.

## Step 5: Format the draft

Read `references/<platform>.md` for the resolved platform and follow its
"Draft format" section exactly.

## Step 6: Get approval

Show the full draft to the user. Wait for explicit approval or edits. Never
proceed to Step 7 without it, regardless of how the request was phrased.

## Step 7: Write

Follow `references/<platform>.md`'s "Write procedure" section exactly. After
it completes (fully, partially, or not at all -- manual's "write" is just
saving a file), append every successfully-logged task to
`ledger/<project-key>.json` with the fingerprint computed in Step 4, then
write the file back.
```

- [ ] **Step 5: Full dogfood run against `manual` -- the actual test for this task**

1. Pick or create a scratch git repo with a handful of commits under one of your configured git emails, in the last week.
2. Add it to `projects.json` with `"platform": "manual"`.
3. `cd` into it and run `/log-task`.
4. Confirm: it finds the real commits (cross-check against `git log` yourself), produces a draft in `manual.md`'s shape, asks for approval before writing anything, saves the draft file on approval, and creates `ledger/<key>.json` with one entry per logged task.
5. Run `/log-task` again immediately. Confirm: it reports "nothing new to log" (everything's already in the ledger) instead of re-drafting the same tasks.

---

### Task 9: Wire real projects and verify `lark`/`eoffice` end-to-end

**Files:**
- Modify: `~/.claude/skills/log-task/projects.json`

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: nothing further downstream -- this is the final integration task.

- [ ] **Step 1: Add nova's real entry**

Ask the user to confirm the real visible names for the default people fields before writing this (do not guess `defaultFollower`/`defaultCollaborator` from anything seen in the reference recording -- that recording was a different person's eOffice account):

```json
{
  "/Users/trannguyendanghuy/Workspace/work/nova": {
    "platform": "eoffice",
    "gitEmails": ["itc.cv.1@novagroup.vn", "trannguyendanhuy2904@gmail.com"],
    "params": {
      "defaultAssignor": "<confirmed visible name>",
      "defaultAssignee": "<confirmed visible name>",
      "defaultFollower": "<confirmed visible name>",
      "defaultCollaborator": "<confirmed visible name>"
    }
  }
}
```

**Note (2026-08-28):** Steps 2-3 below (the `lark`/dominode half of this task) are already complete -- see the SDD ledger (`.superpowers/sdd/PLAN/progress.md`) for the real, verified values and dry-run evidence. They're left here unchanged as the historical record of what was done; only Step 1 and Step 4 (the `eoffice`/nova half) were still open as of the eOffice design revision.

- [ ] **Step 2: Add happyland-of-draken/dominode's real entry**

Ask the user for the real `baseToken`/`tableId`/`prefix` if not already captured earlier in this session (base token and Task table ID were seen during this session's research -- confirm they're still current before hardcoding them), then add:

```json
{
  "/Users/trannguyendanghuy/Workspace/work/happyland-of-draken/dominode": {
    "platform": "lark",
    "gitEmails": ["<user's dominode git email>"],
    "params": {
      "baseToken": "<confirmed base token>",
      "tableId": "<confirmed Task table ID>",
      "prefix": "[Dominode]"
    }
  }
}
```

- [ ] **Step 3: Verify `lark` end-to-end, dry-run only**

`cd` into the dominode project, run `/log-task`, approve the draft, and confirm the flow reaches `lark-cli base +record-upsert --dry-run` and shows a sane preview -- then stop before the real write for this verification pass (per DESIGN.md's testing guidance, don't enable real Lark writes until the payload's been eyeballed against the Task table's field schema at least once).

- [ ] **Step 4: Verify `eoffice` end-to-end, single low-stakes task, headed, both actions**

`cd` into nova, run `/log-task`, approve a draft containing exactly one low-stakes real `Done` task. Let it run through `create-task` (headed browser, per Task 7 Step 3's temporary toggle) and confirm the task appears in eOffice -- as its own, separately-confirmed step. Only then run `report-progress` for that same task, as a second separately-confirmed step, and confirm it now reads `100%` / `Evaluating`. Then switch `eoffice-write.mjs` back to `headless: true` for normal use.

- [ ] **Step 5: Final check -- re-run both**

Run `/log-task` again in both projects. Confirm both report "nothing new to log" for the tasks just logged, proving the ledger dedup works end-to-end on the real platforms, not just in the Task 8 `manual` dogfood run.
