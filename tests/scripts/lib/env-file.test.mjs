import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ENV_FILE, loadDefaultEnv } from '../../../skills/log-task/scripts/lib/env-file.mjs';

const lib = fileURLToPath(new URL('../../../skills/log-task/scripts/lib/env-file.mjs', import.meta.url));

test('returns null and loads nothing when the file is missing', () => {
  const loaded = [];
  const result = loadDefaultEnv({ dataDir: '/d', exists: () => false, load: (f) => loaded.push(f) });
  assert.equal(result, null);
  assert.deepEqual(loaded, []);
});

test('loads <dataDir>/eoffice.env when it exists', () => {
  const loaded = [];
  const result = loadDefaultEnv({ dataDir: '/d', exists: () => true, load: (f) => loaded.push(f) });
  assert.equal(result, `/d/${DEFAULT_ENV_FILE}`);
  assert.deepEqual(loaded, [`/d/${DEFAULT_ENV_FILE}`]);
});

test('shell variables win over the file, file fills the gaps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-env-'));
  fs.writeFileSync(path.join(dir, DEFAULT_ENV_FILE), 'EOFFICE_BASE_URL=from-file\nEOFFICE_ACCESS_TOKEN=from-file\n');
  const code = `import(${JSON.stringify(lib)}).then((m) => { m.loadDefaultEnv({ dataDir: ${JSON.stringify(dir)} });
    console.log(process.env.EOFFICE_BASE_URL + '|' + process.env.EOFFICE_ACCESS_TOKEN); })`;
  const result = spawnSync('node', ['-e', code], {
    encoding: 'utf8', env: { PATH: process.env.PATH, EOFFICE_BASE_URL: 'from-shell' },
  });
  fs.rmSync(dir, { recursive: true });
  assert.equal(result.stdout.trim(), 'from-shell|from-file');
});
