import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../../skills/log-task/scripts/resolve-project.mjs');

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

function assertCleanExit2(r, phrase) {
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, phrase);
}

test('a missing config file exits 2 with a one-line message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-cfg-'));
  const r = run(['resolve', '--cwd', dir, '--config', join(dir, 'nope.json')]);
  assertCleanExit2(r, /projects\.json not found/);
});

test('an invalid JSON config exits 2 with a one-line message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-cfg-'));
  const bad = join(dir, 'projects.json');
  writeFileSync(bad, '{ not json');
  const r = run(['resolve', '--cwd', dir, '--config', bad]);
  assertCleanExit2(r, /invalid JSON/);
});

test('a trailing --cwd exits 2 with usage', () => {
  const r = run(['resolve', '--cwd']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Usage/);
});

test('--cwd followed by another flag exits 2 with usage', () => {
  const r = run(['resolve', '--cwd', '--config', 'x']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Usage/);
});
