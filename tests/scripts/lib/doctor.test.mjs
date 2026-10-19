import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToken, runChecks } from '../../../skills/log-task/scripts/lib/doctor.mjs';

const gitOk = () => ({ status: 0, stdout: 'git version 2.50\n' });
const config = {
  '/w/nova': {
    type: 'group', platform: 'eoffice-api', gitEmails: ['a@b.c'],
    children: { 'one-nova-be': { params: { project: 'One Nova' } } },
  },
  '/w/solo': { platform: 'manual', gitEmails: ['a@b.c'] },
};
const base = {
  cwd: '/w/nova', dataDir: '/data', nodeVersion: '24.1.0', run: gitOk,
  readFile: () => JSON.stringify(config), env: {},
};
const byName = (checks, name) => checks.find((c) => c.name === name);

test('fails when node is older than 22.13', () => {
  assert.equal(byName(runChecks({ ...base, nodeVersion: '22.12.0' }), 'node').status, 'fail');
  assert.equal(byName(runChecks({ ...base, nodeVersion: '22.13.0' }), 'node').status, 'ok');
});

test('fails when git is missing', () => {
  const checks = runChecks({ ...base, run: () => ({ status: 1, stdout: '' }) });
  assert.equal(byName(checks, 'git').status, 'fail');
});

test('missing config points at init and stops early', () => {
  const checks = runChecks({ ...base, readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(byName(checks, 'config').status, 'fail');
  assert.match(byName(checks, 'config').detail, /init\.mjs/);
  assert.equal(byName(checks, 'project'), undefined);
});

test('invalid JSON is a config failure', () => {
  const checks = runChecks({ ...base, readFile: () => '{nope' });
  assert.match(byName(checks, 'config').detail, /invalid JSON/);
});

test('an unconfigured directory is a warning, not a failure', () => {
  const checks = runChecks({ ...base, cwd: '/elsewhere' });
  assert.equal(byName(checks, 'project').status, 'warn');
});

test('eoffice-api targets require the base URL; the token is only a warning', () => {
  const checks = runChecks(base);
  assert.equal(byName(checks, 'EOFFICE_BASE_URL').status, 'fail');
  assert.equal(byName(checks, 'EOFFICE_ACCESS_TOKEN').status, 'warn');
});

test('reports the host and never prints the token value', () => {
  const env = { EOFFICE_BASE_URL: 'https://eoffice-uat.novagroup.vn', EOFFICE_ACCESS_TOKEN: 'sekret-token' };
  const checks = runChecks({ ...base, env });
  assert.match(byName(checks, 'host').detail, /eoffice-uat\.novagroup\.vn \(UAT\)/);
  assert.equal(JSON.stringify(checks).includes('sekret-token'), false);
});

test('flags a host outside the UAT list', () => {
  const env = { EOFFICE_BASE_URL: 'https://eoffice.novagroup.vn', EOFFICE_ACCESS_TOKEN: 'x' };
  assert.match(byName(runChecks({ ...base, env }), 'host').detail, /NOT in the UAT list/);
});

test('manual projects need no environment variables', () => {
  const checks = runChecks({ ...base, cwd: '/w/solo' });
  assert.equal(byName(checks, 'EOFFICE_BASE_URL'), undefined);
});

const onlineEnv = { EOFFICE_BASE_URL: 'https://eoffice-uat.novagroup.vn', EOFFICE_ACCESS_TOKEN: 'sekret-token' };
const reply = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('checkToken passes when one read succeeds, with limit=1', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = new URL(url); return reply({ error: false, data: [] })(url, init); };
  const check = await checkToken({ env: onlineEnv, fetchImpl });
  assert.equal(check.status, 'ok');
  assert.equal(seen.searchParams.get('limit'), '1');
});

test('checkToken surfaces the hint for "not object" without the token', async () => {
  const fetchImpl = reply({ error: true, code: 'not object', message: 'accesstoken not of object' });
  const check = await checkToken({ env: onlineEnv, fetchImpl });
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /Last access time/);
  assert.equal(JSON.stringify(check).includes('sekret-token'), false);
});

test('checkToken reports a network failure as a failed check', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const check = await checkToken({ env: onlineEnv, fetchImpl });
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /failed/);
});
