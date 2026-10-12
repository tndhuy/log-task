import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'resolve-project.mjs');

function workspace({ gitChildren = ['api', 'web'], mkChildren = ['api', 'web'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'log-task-group-'));
  for (const name of mkChildren) mkdirSync(join(root, name));
  for (const name of gitChildren) mkdirSync(join(root, name, '.git'));
  const configPath = join(root, 'projects.test.json');
  writeFileSync(configPath, JSON.stringify({
    [root]: {
      type: 'group',
      platform: 'eoffice',
      gitEmails: ['g@x.com'],
      params: {},
      children: { api: { params: { project: 'API' } }, web: { params: { project: 'WEB' } } },
    },
  }));
  return { root, configPath };
}

function run(args) {
  return spawnSync('node', [cli, ...args], { encoding: 'utf8' });
}

test('resolve prints the group targets as JSON', () => {
  const { root, configPath } = workspace();
  const r = run(['resolve', '--cwd', root, '--config', configPath]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'group-run');
  assert.deepEqual(out.targets.map((t) => t.name), ['api', 'web']);
});

test('resolve exits 2 and names a child directory that is missing', () => {
  const { root, configPath } = workspace({ gitChildren: ['api'], mkChildren: ['api'] });
  const r = run(['resolve', '--cwd', root, '--config', configPath]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /web/);
});

test('resolve exits 2 and names a child that is not a git repo', () => {
  const { root, configPath } = workspace({ gitChildren: ['api'] });
  const r = run(['resolve', '--cwd', root, '--config', configPath]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /web/);
  assert.match(r.stderr, /git/);
});

test('resolve exits 2 for an unlisted cwd', () => {
  const { configPath } = workspace();
  const r = run(['resolve', '--cwd', '/definitely/not/configured', '--config', configPath]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No project configured/);
});

test('migration-plan prints moves and legacyRoot', () => {
  const { root, configPath } = workspace();
  const r = run(['migration-plan', '--cwd', root, '--config', configPath]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.moves));
  assert.ok('legacyRoot' in out);
});

test('an unknown subcommand exits 2 with usage', () => {
  const r = run(['nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage/);
});
