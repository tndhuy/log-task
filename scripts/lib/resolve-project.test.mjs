import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ledgerKey, resolveProject, assertSingleOwner, ConfigError,
} from './resolve-project.mjs';

const skillDir = '/skill';
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
  const r = resolveProject(config(), '/w/solo/src', { skillDir });
  assert.equal(r.mode, 'standalone');
  assert.equal(r.groupRoot, null);
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].path, '/w/solo');
  assert.equal(r.targets[0].ledgerPath, '/skill/ledger/w-solo.json');
});

test('group root resolves to every child with merged config', () => {
  const r = resolveProject(config(), '/w/nova', { skillDir });
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
  const r = resolveProject(config(), '/w/nova/web/src', { skillDir });
  assert.equal(r.mode, 'child-run');
  assert.deepEqual(r.targets.map((t) => t.name), ['web']);
  assert.equal(r.targets[0].ledgerPath, '/w/nova/.log-task/ledger/web.json');
});

test('cwd in an unrelated subdir of the group root is a group run', () => {
  const r = resolveProject(config(), '/w/nova/docs', { skillDir });
  assert.equal(r.mode, 'group-run');
  assert.equal(r.targets.length, 2);
});

test('logDir override is resolved against the group root', () => {
  const c = config();
  c['/w/nova'].logDir = 'state/logs';
  const r = resolveProject(c, '/w/nova', { skillDir });
  assert.equal(r.logRoot, '/w/nova/state/logs');
  assert.equal(r.targets[0].ledgerPath, '/w/nova/state/logs/ledger/api.json');
});

test('nested child path becomes a dashed ledger key', () => {
  const c = config();
  c['/w/nova'].children['svc/v2'] = { params: { project: 'V2' } };
  const r = resolveProject(c, '/w/nova', { skillDir });
  const v2 = r.targets.find((t) => t.name === 'svc/v2');
  assert.equal(v2.ledgerPath, '/w/nova/.log-task/ledger/svc-v2.json');
});

test('child declared as ./api or api/ resolves to the same path', () => {
  const c = config();
  c['/w/nova'].children = { './api/': { params: { project: 'API' } } };
  const r = resolveProject(c, '/w/nova', { skillDir });
  assert.equal(r.targets[0].path, '/w/nova/api');
});

test('a string-prefix lookalike directory does not match the group', () => {
  assert.throws(
    () => resolveProject(config(), '/w/nova-extra', { skillDir }),
    ConfigError,
  );
});

test('unlisted cwd throws ConfigError', () => {
  assert.throws(() => resolveProject(config(), '/elsewhere', { skillDir }), ConfigError);
});

test('child without params.project throws and names the child', () => {
  const c = config();
  c['/w/nova'].children.api = { params: {} };
  assert.throws(
    () => resolveProject(c, '/w/nova', { skillDir }),
    (e) => e instanceof ConfigError && e.message.includes('api'),
  );
});

test('blank params.project is rejected', () => {
  const c = config();
  c['/w/nova'].children.api = { params: { project: '  ' } };
  assert.throws(() => resolveProject(c, '/w/nova', { skillDir }), ConfigError);
});

test('child-run does not fail on an unrelated child missing params.project', () => {
  const c = config();
  c['/w/nova'].children.api = { params: {} };
  const r = resolveProject(c, '/w/nova/web', { skillDir });
  assert.equal(r.mode, 'child-run');
});

test('group with no children throws and names the group', () => {
  const c = config();
  c['/w/nova'].children = {};
  assert.throws(
    () => resolveProject(c, '/w/nova', { skillDir }),
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
