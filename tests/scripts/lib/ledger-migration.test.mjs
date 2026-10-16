import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLedgerMigration } from '../../../skills/log-task/scripts/lib/ledger-migration.mjs';
import { resolveProject } from '../../../skills/log-task/scripts/lib/resolve-project.mjs';

const dataDir = '/skill';
const config = {
  '/w/nova': {
    type: 'group',
    platform: 'eoffice',
    gitEmails: [],
    params: {},
    children: { api: { params: { project: 'API' } }, web: { params: { project: 'WEB' } } },
  },
};
const existsIn = (files) => (p) => files.includes(p);

test('plans a move for each child with an old skill-dir ledger', () => {
  const resolved = resolveProject(config, '/w/nova', { dataDir });
  const plan = planLedgerMigration(resolved, {
    dataDir,
    exists: existsIn(['/skill/ledger/w-nova-api.json']),
  });
  assert.deepEqual(plan.moves, [{
    from: '/skill/ledger/w-nova-api.json',
    to: '/w/nova/.log-task/ledger/api.json',
    conflict: false,
  }]);
  assert.equal(plan.legacyRoot, null);
});

test('flags a conflict when the destination already exists', () => {
  const resolved = resolveProject(config, '/w/nova', { dataDir });
  const plan = planLedgerMigration(resolved, {
    dataDir,
    exists: existsIn([
      '/skill/ledger/w-nova-web.json',
      '/w/nova/.log-task/ledger/web.json',
    ]),
  });
  assert.equal(plan.moves[0].conflict, true);
});

test('reports a legacy ledger keyed by the group root', () => {
  const resolved = resolveProject(config, '/w/nova', { dataDir });
  const plan = planLedgerMigration(resolved, {
    dataDir,
    exists: existsIn(['/skill/ledger/w-nova.json']),
  });
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.legacyRoot, '/skill/ledger/w-nova.json');
});

test('a child run only plans for its own child', () => {
  const resolved = resolveProject(config, '/w/nova/web', { dataDir });
  const plan = planLedgerMigration(resolved, {
    dataDir,
    exists: existsIn(['/skill/ledger/w-nova-api.json', '/skill/ledger/w-nova-web.json']),
  });
  assert.deepEqual(plan.moves.map((m) => m.to), ['/w/nova/.log-task/ledger/web.json']);
});

test('standalone projects have nothing to migrate', () => {
  const resolved = resolveProject(
    { '/w/solo': { platform: 'manual', gitEmails: [], params: {} } },
    '/w/solo',
    { dataDir },
  );
  assert.deepEqual(planLedgerMigration(resolved, { dataDir, exists: () => true }), {
    moves: [],
    legacyRoot: null,
  });
});
