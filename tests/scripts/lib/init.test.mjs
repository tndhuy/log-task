import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSetup } from '../../../skills/log-task/scripts/lib/init.mjs';

const assetsDir = fileURLToPath(new URL('../../../skills/log-task/assets', import.meta.url));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lt-init-')), 'data');

test('creates the config and env files with the email filled in', () => {
  const dataDir = tmp();
  const actions = initSetup({ dataDir, assetsDir, email: 'dev@corp.vn' });
  assert.deepEqual(actions.map((a) => a.status), ['created', 'created']);
  const config = fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8');
  assert.ok(config.includes('dev@corp.vn'));
  assert.ok(!config.includes('you@example.com'));
  assert.equal(fs.statSync(path.join(dataDir, 'eoffice.env')).mode & 0o777, 0o600);
  assert.ok(JSON.parse(config));
});

test('never overwrites existing files', () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'projects.json'), '{"mine":true}');
  fs.writeFileSync(path.join(dataDir, 'eoffice.env'), 'EOFFICE_ACCESS_TOKEN=keep\n');
  const actions = initSetup({ dataDir, assetsDir, email: 'dev@corp.vn' });
  assert.deepEqual(actions.map((a) => a.status), ['kept', 'kept']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'), '{"mine":true}');
  assert.equal(fs.readFileSync(path.join(dataDir, 'eoffice.env'), 'utf8'), 'EOFFICE_ACCESS_TOKEN=keep\n');
});

test('keeps the placeholder when no email is given', () => {
  const dataDir = tmp();
  initSetup({ dataDir, assetsDir });
  assert.ok(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8').includes('you@example.com'));
});

test('the generated env file offers the task link template as a commented example', () => {
  const dataDir = tmp();
  initSetup({ dataDir, assetsDir });
  assert.match(fs.readFileSync(path.join(dataDir, 'eoffice.env'), 'utf8'), /^# EOFFICE_TASK_URL_TEMPLATE=\{origin\}\/work-normal-normal\/view\?ID=\{id\}$/m);
});
