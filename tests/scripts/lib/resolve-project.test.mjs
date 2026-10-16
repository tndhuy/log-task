import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ledgerKey, resolveProject, assertSingleOwner, ConfigError,
} from '../../../skills/log-task/scripts/lib/resolve-project.mjs';

const dataDir = '/skill';
const config = () => ({
  '/w/nova': {
    type: 'group',
    platform: 'eoffice',
    gitEmails: ['g@x.com'],
    params: { defaultAssignee: 'A' },
    children: {
      api: { params: { project: 'API' } },
      web: { params: { project: 'WEB' }, gitEmails: ['w@x.com'] },
    },
  },
  '/w/solo': { platform: 'manual', gitEmails: ['s@x.com'], params: {} },
});

test('ledgerKey strips the leading slash and joins with dashes', () => {
  assert.equal(ledgerKey('/Users/x/work/nova'), 'Users-x-work-nova');
});

test('standalone entry keeps the skill-dir ledger', () => {
  const r = resolveProject(config(), '/w/solo/src', { dataDir });
  assert.equal(r.mode, 'standalone');
  assert.equal(r.groupRoot, null);
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].path, '/w/solo');
  assert.equal(r.targets[0].ledgerPath, '/skill/ledger/w-solo.json');
});

test('group root resolves to every child with merged config', () => {
  const r = resolveProject(config(), '/w/nova', { dataDir });
  assert.equal(r.mode, 'group-run');
  assert.equal(r.groupRoot, '/w/nova');
  assert.equal(r.logRoot, '/w/nova/.log-task');
  assert.deepEqual(r.targets.map((t) => t.name), ['api', 'web']);
  const [api, web] = r.targets;
  assert.equal(api.path, '/w/nova/api');
  assert.equal(api.platform, 'eoffice');
  assert.deepEqual(api.gitEmails, ['g@x.com']);
  assert.deepEqual(api.params, { defaultAssignee: 'A', project: 'API' });
  assert.deepEqual(web.gitEmails, ['w@x.com']);
  assert.equal(api.ledgerPath, '/w/nova/.log-task/ledger/api.json');
});

test('cwd inside a child resolves to that child only', () => {
  const r = resolveProject(config(), '/w/nova/web/src', { dataDir });
  assert.equal(r.mode, 'child-run');
  assert.deepEqual(r.targets.map((t) => t.name), ['web']);
  assert.equal(r.targets[0].ledgerPath, '/w/nova/.log-task/ledger/web.json');
});

test('cwd in an unrelated subdir of the group root is a group run', () => {
  const r = resolveProject(config(), '/w/nova/docs', { dataDir });
  assert.equal(r.mode, 'group-run');
  assert.equal(r.targets.length, 2);
});

test('logDir override is resolved against the group root', () => {
  const c = config();
  c['/w/nova'].logDir = 'state/logs';
  const r = resolveProject(c, '/w/nova', { dataDir });
  assert.equal(r.logRoot, '/w/nova/state/logs');
  assert.equal(r.targets[0].ledgerPath, '/w/nova/state/logs/ledger/api.json');
});

test('nested child path becomes a dashed ledger key', () => {
  const c = config();
  c['/w/nova'].children['svc/v2'] = { params: { project: 'V2' } };
  const r = resolveProject(c, '/w/nova', { dataDir });
  const v2 = r.targets.find((t) => t.name === 'svc/v2');
  assert.equal(v2.ledgerPath, '/w/nova/.log-task/ledger/svc-v2.json');
});

test('child declared as ./api or api/ resolves to the same path', () => {
  const c = config();
  c['/w/nova'].children = { './api/': { params: { project: 'API' } } };
  const r = resolveProject(c, '/w/nova', { dataDir });
  assert.equal(r.targets[0].path, '/w/nova/api');
});

test('a string-prefix lookalike directory does not match the group', () => {
  assert.throws(
    () => resolveProject(config(), '/w/nova-extra', { dataDir }),
    ConfigError,
  );
});

test('unlisted cwd throws ConfigError', () => {
  assert.throws(() => resolveProject(config(), '/elsewhere', { dataDir }), ConfigError);
});

test('child without params.project throws and names the child', () => {
  const c = config();
  c['/w/nova'].children.api = { params: {} };
  assert.throws(
    () => resolveProject(c, '/w/nova', { dataDir }),
    (e) => e instanceof ConfigError && e.message.includes('api'),
  );
});

test('blank params.project is rejected', () => {
  const c = config();
  c['/w/nova'].children.api = { params: { project: '  ' } };
  assert.throws(() => resolveProject(c, '/w/nova', { dataDir }), ConfigError);
});

test('child-run does not fail on an unrelated child missing params.project', () => {
  const c = config();
  c['/w/nova'].children.api = { params: {} };
  const r = resolveProject(c, '/w/nova/web', { dataDir });
  assert.equal(r.mode, 'child-run');
});

test('group with no children throws and names the group', () => {
  const c = config();
  c['/w/nova'].children = {};
  assert.throws(
    () => resolveProject(c, '/w/nova', { dataDir }),
    (e) => e instanceof ConfigError && e.message.includes('/w/nova'),
  );
});

test('a repo owned by both a group and a standalone entry is rejected', () => {
  const c = config();
  c['/w/nova/api'] = { platform: 'manual', gitEmails: [], params: {} };
  assert.throws(
    () => assertSingleOwner(c),
    (e) => e instanceof ConfigError
      && e.message.includes('/w/nova/api') && e.message.includes('/w/nova'),
  );
});

test('group child merges rules per top-level key and gets a statePath', () => {
  const c = config();
  c['/w/nova'].rules = { nameTemplate: 'T {summary}', done: { status: 'REVIEW' } };
  c['/w/nova'].children.api.rules = { done: { status: 'COMPLETED' } };
  const r = resolveProject(c, '/w/nova', { dataDir });
  const [api, web] = r.targets;
  assert.deepEqual(api.rules, { nameTemplate: 'T {summary}', done: { status: 'COMPLETED' } });
  assert.deepEqual(web.rules, { nameTemplate: 'T {summary}', done: { status: 'REVIEW' } });
  assert.equal(api.statePath, '/w/nova/.log-task/state/api.json');
  assert.equal(web.statePath, '/w/nova/.log-task/state/web.json');
});

test('group child without any rules gets an empty rules object', () => {
  const r = resolveProject(config(), '/w/nova', { dataDir });
  assert.deepEqual(r.targets[0].rules, {});
});

test('standalone target carries its rules and a skill-dir statePath', () => {
  const c = config();
  c['/w/solo'].rules = { nameTemplate: '{summary}' };
  const r = resolveProject(c, '/w/solo', { dataDir });
  assert.deepEqual(r.targets[0].rules, { nameTemplate: '{summary}' });
  assert.equal(r.targets[0].statePath, '/skill/state/w-solo.json');
});
