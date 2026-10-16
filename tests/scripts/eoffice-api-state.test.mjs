import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../../skills/log-task/scripts/eoffice-api-state.mjs');
const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

const rules = {
  nameTemplate: '[{layer}] {summary}',
  layer: { mode: 'fixed', value: 'BE' },
  parent: { mode: 'ask', search: 'OneNova -P', remember: true },
  owner: { mode: 'ask', default: 'Default Owner', remember: true },
  assignees: { mode: 'ask', default: ['A'], remember: false },
  followers: { mode: 'fixed', value: [] },
};

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'eoffice-state-'));
  const rulesFile = join(dir, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify(rules));
  return { dir, rulesFile, stateFile: join(dir, 'state', 'x.json'), settingsFile: join(dir, 'settings.json') };
}

test('settings-plan uses the configured default when there is no state file', () => {
  const { rulesFile, stateFile } = workspace();
  const r = run(['settings-plan', '--rules', rulesFile, '--state', stateFile]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.owner.preselected, 'Default Owner');
  assert.deepEqual(plan.followers, { mode: 'fixed', value: [] });
});

test('remember stores only fields with remember:true and creates the state directory', () => {
  const { rulesFile, stateFile, settingsFile } = workspace();
  writeFileSync(settingsFile, JSON.stringify({
    parent: 2089469, owner: 'Remembered', assignees: ['B'], followers: [],
  }));
  const r = run(['remember', '--rules', rulesFile, '--state', stateFile, '--settings', settingsFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { parent: 2089469, owner: 'Remembered' });
  assert.equal(existsSync(`${stateFile}.tmp`), false);
});

test('settings-plan then prefers the remembered value', () => {
  const { rulesFile, stateFile, settingsFile } = workspace();
  writeFileSync(settingsFile, JSON.stringify({ owner: 'Remembered' }));
  run(['remember', '--rules', rulesFile, '--state', stateFile, '--settings', settingsFile]);
  const plan = JSON.parse(run(['settings-plan', '--rules', rulesFile, '--state', stateFile]).stdout);
  assert.equal(plan.owner.preselected, 'Remembered');
});

test('remember keeps unrelated keys already in the state file', () => {
  const { rulesFile, stateFile, settingsFile } = workspace();
  writeFileSync(settingsFile, JSON.stringify({ owner: 'First' }));
  run(['remember', '--rules', rulesFile, '--state', stateFile, '--settings', settingsFile]);
  writeFileSync(settingsFile, JSON.stringify({ parent: 5 }));
  run(['remember', '--rules', rulesFile, '--state', stateFile, '--settings', settingsFile]);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { owner: 'First', parent: 5 });
});

test('invalid rules exit 2 with one line on stderr', () => {
  const { dir } = workspace();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ nameTemplate: 'no summary' }));
  const r = run(['settings-plan', '--rules', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nameTemplate/);
  assert.equal(r.stdout, '');
});

test('missing flags and unknown subcommands exit 2', () => {
  assert.equal(run(['settings-plan']).status, 2);
  assert.equal(run(['remember', '--rules', 'x']).status, 2);
  assert.equal(run(['nope']).status, 2);
});

test('settings-plan exposes parent candidates and preselects the first id', () => {
  const { dir, stateFile } = workspace();
  const file = join(dir, 'cand.json');
  const candidates = [{ id: 2089469, label: 'P5 Development' }, { id: 2087612, label: 'Phase 5' }];
  writeFileSync(file, JSON.stringify({ ...rules, parent: { mode: 'ask', remember: true, candidates } }));
  const r = run(['settings-plan', '--rules', file, '--state', stateFile]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.parent.candidates, candidates);
  assert.equal(plan.parent.preselected, 2089469);
});
