import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = new URL('./discover-eoffice-form.mjs', import.meta.url);

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('discovery rejects unknown actions before opening a browser', () => {
  const result = run(['delete-task']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /create-task\|report-progress/);
});

test('discovery reports a missing captured session with exit code 3', () => {
  const result = run(['create-task'], { EOFFICE_SESSION_PATH: '/does/not/exist.json' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /eoffice-session\.mjs/);
});

test('discovery reports a missing Chromium binary as a setup error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-task-discovery-test-'));
  const sessionPath = join(dir, 'session.json');
  writeFileSync(sessionPath, JSON.stringify({ cookies: [], origins: [] }));

  const result = run(['create-task'], {
    EOFFICE_SESSION_PATH: sessionPath,
    PLAYWRIGHT_BROWSERS_PATH: join(dir, 'missing-browsers'),
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /playwright install chromium/);
});
