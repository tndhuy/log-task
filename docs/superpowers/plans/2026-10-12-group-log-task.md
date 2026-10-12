# Group log-task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/log-task` run once from a group root (e.g. `nova`) and log every child repo, each into its own eOffice Project, with all group state under one `.log-task/` folder.

**Architecture:** A small, pure Node helper (`scripts/lib/resolve-project.mjs`) does the deterministic work: longest-prefix resolution, group/child merge, single-owner check, ledger paths, and migration planning. A thin CLI (`scripts/resolve-project.mjs`) prints that as JSON so `SKILL.md` stops re-deriving paths by hand. `SKILL.md` and `references/eoffice.md` get a group procedure. `eoffice-write.mjs` is untouched; it already takes `project` per task.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict` (same as the existing `scripts/*.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-12-group-log-task-design.md`

## Global Constraints

- Entries without `"type": "group"` behave exactly as today (spec: Non-goals).
- `children` keys are paths relative to the group root; child `params` and `gitEmails` override the group's field by field.
- `params.project` is required per child.
- `logDir` is relative to the group root, default `.log-task`.
- Ledger fingerprint `<project-key>` for a child is its absolute path (group root + relative path).
- Ledger key rule: strip the leading `/`, replace every remaining `/` with `-`.
- Ledger writes keep the temp-file + rename rule.
- No per-child platform override; no automatic repo discovery; no change to `eoffice-write.mjs` modes or its two approval gates.
- Never overwrite an existing ledger during migration; never move files without approval.
- Commits: concise conventional commits, no AI attribution lines, no push.

## Review Focus

- cwd `/w/nova-extra` must not resolve to a group keyed `/w/nova` (string-prefix lookalike). Pinned in Task 1.
- Child declared as `./api` or `api/` must resolve to the same path as `api`. Pinned in Task 1.
- Group with zero `children`, or a child whose `params.project` is empty/blank, must fail naming the group or child, not log nothing. Pinned in Task 1.
- Child directory missing or without `.git` must exit 2 naming the child, not be skipped. Pinned in Task 3.
- Migration destination already exists must be reported as `conflict: true`, never overwritten. Pinned in Task 2.

---

### Task 1: Project resolution helper

**Files:**
- Create: `scripts/lib/resolve-project.mjs`
- Test: `scripts/lib/resolve-project.test.mjs`

**Interfaces:**
- Produces:
  - `ledgerKey(absPath: string): string`
  - `class ConfigError extends Error`
  - `assertSingleOwner(config): void` (throws `ConfigError`)
  - `resolveProject(config, cwd: string, { skillDir: string }): Resolved`
  - `Resolved = { mode: 'standalone' | 'group-run' | 'child-run', key: string, groupRoot: string | null, logRoot: string | null, targets: Target[] }`
  - `Target = { name: string, path: string, platform: string, gitEmails: string[], params: object, ledgerPath: string }`

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/resolve-project.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/resolve-project.test.mjs`
Expected: FAIL, `Cannot find module './resolve-project.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/resolve-project.mjs`:

```js
import * as path from 'node:path';

const DEFAULT_LOG_DIR = '.log-task';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function ledgerKey(absPath) {
  return absPath.replace(/^\/+/, '').replaceAll('/', '-');
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function longest(paths) {
  return paths.reduce((a, b) => (b.length > a.length ? b : a));
}

export function assertSingleOwner(config) {
  const owners = new Map();
  for (const [key, entry] of Object.entries(config)) {
    const paths = entry.type === 'group'
      ? Object.keys(entry.children ?? {}).map((name) => path.resolve(key, name))
      : [key];
    for (const p of paths) {
      const previous = owners.get(p);
      if (previous) {
        throw new ConfigError(`${p} is declared by both ${previous} and ${key}`);
      }
      owners.set(p, key);
    }
  }
}

function buildChild(groupKey, group, name, logRoot) {
  const params = { ...group.params, ...group.children[name].params };
  if (typeof params.project !== 'string' || params.project.trim() === '') {
    throw new ConfigError(`Child "${name}" of ${groupKey} has no params.project`);
  }
  const childPath = path.resolve(groupKey, name);
  return {
    name: path.relative(groupKey, childPath),
    path: childPath,
    platform: group.platform,
    gitEmails: group.children[name].gitEmails ?? group.gitEmails ?? [],
    params,
    ledgerPath: path.join(logRoot, 'ledger', `${ledgerKey(path.relative(groupKey, childPath))}.json`),
  };
}

export function resolveProject(config, cwd, { skillDir }) {
  assertSingleOwner(config);
  const matching = Object.keys(config).filter((key) => isInside(key, cwd));
  if (matching.length === 0) {
    throw new ConfigError(`No project configured for ${cwd}`);
  }
  const key = longest(matching);
  const entry = config[key];

  if (entry.type !== 'group') {
    return {
      mode: 'standalone',
      key,
      groupRoot: null,
      logRoot: null,
      targets: [{
        name: key,
        path: key,
        platform: entry.platform,
        gitEmails: entry.gitEmails ?? [],
        params: entry.params ?? {},
        ledgerPath: path.join(skillDir, 'ledger', `${ledgerKey(key)}.json`),
      }],
    };
  }

  const names = Object.keys(entry.children ?? {});
  if (names.length === 0) {
    throw new ConfigError(`Group ${key} has no children`);
  }
  const logRoot = path.resolve(key, entry.logDir ?? DEFAULT_LOG_DIR);
  const hit = names.filter((name) => isInside(path.resolve(key, name), cwd));

  if (hit.length > 0) {
    const name = longest(hit);
    return {
      mode: 'child-run', key, groupRoot: key, logRoot,
      targets: [buildChild(key, entry, name, logRoot)],
    };
  }
  return {
    mode: 'group-run', key, groupRoot: key, logRoot,
    targets: names.map((name) => buildChild(key, entry, name, logRoot)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lib/resolve-project.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/resolve-project.mjs scripts/lib/resolve-project.test.mjs
git commit -m "feat: add group-aware project resolution helper"
```

---

### Task 2: Ledger migration planner

**Files:**
- Create: `scripts/lib/ledger-migration.mjs`
- Test: `scripts/lib/ledger-migration.test.mjs`

**Interfaces:**
- Consumes: `ledgerKey(absPath)` and the `Resolved` shape from Task 1.
- Produces: `planLedgerMigration(resolved: Resolved, { skillDir: string, exists?: (p: string) => boolean }): { moves: { from: string, to: string, conflict: boolean }[], legacyRoot: string | null }`. Returns `{ moves: [], legacyRoot: null }` when `resolved.mode === 'standalone'`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/ledger-migration.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLedgerMigration } from './ledger-migration.mjs';
import { resolveProject } from './resolve-project.mjs';

const skillDir = '/skill';
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
  const resolved = resolveProject(config, '/w/nova', { skillDir });
  const plan = planLedgerMigration(resolved, {
    skillDir,
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
  const resolved = resolveProject(config, '/w/nova', { skillDir });
  const plan = planLedgerMigration(resolved, {
    skillDir,
    exists: existsIn([
      '/skill/ledger/w-nova-web.json',
      '/w/nova/.log-task/ledger/web.json',
    ]),
  });
  assert.equal(plan.moves[0].conflict, true);
});

test('reports a legacy ledger keyed by the group root', () => {
  const resolved = resolveProject(config, '/w/nova', { skillDir });
  const plan = planLedgerMigration(resolved, {
    skillDir,
    exists: existsIn(['/skill/ledger/w-nova.json']),
  });
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.legacyRoot, '/skill/ledger/w-nova.json');
});

test('a child run only plans for its own child', () => {
  const resolved = resolveProject(config, '/w/nova/web', { skillDir });
  const plan = planLedgerMigration(resolved, {
    skillDir,
    exists: existsIn(['/skill/ledger/w-nova-api.json', '/skill/ledger/w-nova-web.json']),
  });
  assert.deepEqual(plan.moves.map((m) => m.to), ['/w/nova/.log-task/ledger/web.json']);
});

test('standalone projects have nothing to migrate', () => {
  const resolved = resolveProject(
    { '/w/solo': { platform: 'manual', gitEmails: [], params: {} } },
    '/w/solo',
    { skillDir },
  );
  assert.deepEqual(planLedgerMigration(resolved, { skillDir, exists: () => true }), {
    moves: [],
    legacyRoot: null,
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/ledger-migration.test.mjs`
Expected: FAIL, `Cannot find module './ledger-migration.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/ledger-migration.mjs`:

```js
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ledgerKey } from './resolve-project.mjs';

export function planLedgerMigration(resolved, { skillDir, exists = fs.existsSync }) {
  if (resolved.mode === 'standalone') {
    return { moves: [], legacyRoot: null };
  }
  const oldLedger = (absPath) => path.join(skillDir, 'ledger', `${ledgerKey(absPath)}.json`);

  const moves = [];
  for (const target of resolved.targets) {
    const from = oldLedger(target.path);
    if (exists(from)) {
      moves.push({ from, to: target.ledgerPath, conflict: exists(target.ledgerPath) });
    }
  }
  const legacyRoot = oldLedger(resolved.groupRoot);
  return { moves, legacyRoot: exists(legacyRoot) ? legacyRoot : null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lib/ledger-migration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ledger-migration.mjs scripts/lib/ledger-migration.test.mjs
git commit -m "feat: add ledger migration planner for group projects"
```

---

### Task 3: `resolve-project` CLI

**Files:**
- Create: `scripts/resolve-project.mjs`
- Test: `scripts/resolve-project.test.mjs`

**Interfaces:**
- Consumes: `resolveProject`, `ConfigError` (Task 1); `planLedgerMigration` (Task 2).
- Produces: CLI `node scripts/resolve-project.mjs <resolve|migration-plan> [--cwd <dir>] [--config <file>]`.
  - stdout: one JSON document (`Resolved` for `resolve`; `{ moves, legacyRoot }` for `migration-plan`).
  - exit `0` ok; exit `2` with a one-line message on stderr for `ConfigError`, a missing child directory, or a child directory without `.git`.
  - Defaults: `--cwd` = `process.cwd()`, `--config` = `<skill-root>/projects.json`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/resolve-project.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/resolve-project.test.mjs`
Expected: FAIL (the CLI file does not exist; `spawnSync` reports a non-zero status and every assertion on stdout/stderr fails).

- [ ] **Step 3: Write the implementation**

Create `scripts/resolve-project.mjs`:

```js
#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject, ConfigError } from './lib/resolve-project.mjs';
import { planLedgerMigration } from './lib/ledger-migration.mjs';

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: resolve-project.mjs <resolve|migration-plan> [--cwd <dir>] [--config <file>]';

function option(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}

function assertChildrenOnDisk(resolved) {
  if (resolved.mode === 'standalone') return;
  for (const target of resolved.targets) {
    if (!fs.existsSync(target.path)) {
      throw new ConfigError(`Child "${target.name}" directory does not exist: ${target.path}`);
    }
    if (!fs.existsSync(path.join(target.path, '.git'))) {
      throw new ConfigError(`Child "${target.name}" is not a git repo: ${target.path}`);
    }
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'resolve' && command !== 'migration-plan') {
    console.error(USAGE);
    return 2;
  }
  const cwd = option(rest, '--cwd', process.cwd());
  const configPath = option(rest, '--config', path.join(skillDir, 'projects.json'));
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const resolved = resolveProject(config, cwd, { skillDir });
    assertChildrenOnDisk(resolved);
    const output = command === 'resolve' ? resolved : planLedgerMigration(resolved, { skillDir });
    console.log(JSON.stringify(output, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
}

process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/resolve-project.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all existing tests plus the three new files PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/resolve-project.mjs scripts/resolve-project.test.mjs
git commit -m "feat: add resolve-project CLI for group and standalone runs"
```

---

### Task 4: Procedure docs and config example

**Files:**
- Modify: `SKILL.md` (Steps 1–2, plus a new section after Step 7)
- Modify: `references/eoffice.md` (Draft format, Write procedure)
- Modify: `projects.json.example`
- Modify: `DESIGN.md` (non-goal pointer)
- Modify: `docs/superpowers/specs/2026-10-12-group-log-task-design.md` (migration timing)

**Interfaces:**
- Consumes: the CLI contract from Task 3.

- [ ] **Step 1: Replace Steps 1 and 2 in `SKILL.md`**

Replace everything from the line `## Step 1: Resolve the project` through the line `Reuse this exact path in Step 7 -- don't recompute it differently there.` with:

````markdown
## Step 1: Resolve the project

Run, from the skill directory:

    node scripts/resolve-project.mjs resolve --cwd "$(pwd)"

On exit code 2, show the stderr message and stop. If it says no project is
configured, show the user this template to add to `projects.json`:

    "<absolute-path-to-project-root>": {
      "platform": "eoffice" | "lark" | "manual",
      "gitEmails": ["you@example.com"],
      "params": {}
    }

or, for a workspace holding several repos (eOffice only):

    "<absolute-path-to-group-root>": {
      "type": "group",
      "platform": "eoffice",
      "gitEmails": ["you@example.com"],
      "logDir": ".log-task",
      "params": { "defaultAssignor": "...", "defaultAssignee": "...",
                  "defaultFollower": "...", "defaultCollaborator": "..." },
      "children": { "<repo-relative-path>": { "params": { "project": "<eOffice project name>" } } }
    }

Never guess a platform for an unlisted project.

The JSON on stdout has `mode` (`standalone`, `group-run`, or `child-run`) and
`targets`. Each target has `name`, `path`, `platform`, `gitEmails`, `params`,
and `ledgerPath`. Steps 2-4 run once per target; in `group-run`, Steps 5-7 run
once for the whole group (see "Group runs" below).

## Step 2: Load the ledger

If `mode` is `group-run` or `child-run`, first run:

    node scripts/resolve-project.mjs migration-plan --cwd "$(pwd)"

If `moves` is non-empty or `legacyRoot` is set, show the list and wait for
approval. Then, for each approved move whose `conflict` is `false`, run
`mv -n <from> <to>` after `mkdir -p` of the destination's directory. A move
with `conflict: true` is never executed; stop and ask. A `legacyRoot` ledger
matches no child: ask whether to leave it or move it to
`<logRoot>/ledger/_legacy-root.json`; its fingerprints are never applied to a
child automatically.

Then read each target's `ledgerPath`. A missing file is `[]`. Reuse exactly
this path in Step 7 -- don't recompute it.
````

- [ ] **Step 2: Adjust Steps 3 and 4 wording in `SKILL.md`**

In Step 3, change `**Git commits**, run inside the project root, once per configured email.` to `**Git commits**, run inside the target's \`path\`, once per email in the target's \`gitEmails\`.` and change `--arg proj "<project-root>"` to `--arg proj "<target path>"`.

In Step 4, change the fingerprint line to use `<target-path>` in place of `<project-key>`:

    echo -n "<target-path>|<normalized-task-name>|<sorted-comma-joined-commit-hashes>" | shasum -a 1 | cut -d' ' -f1

and add one sentence after it: `For a standalone project the target path equals the config key, so existing fingerprints are unchanged.`

- [ ] **Step 3: Append the "Group runs" section to `SKILL.md`**

Add at the end of the file:

````markdown
## Group runs

Applies when Step 1 returns `mode: "group-run"`. `child-run` follows the normal
7 steps with one target.

- Ask the date window once; use it for every target.
- Steps 2-4 per target, reporting dropped candidates per target. If no target
  has new candidates, report "nothing new to log" and stop.
- Step 5-6: one draft grouped target -> module -> task, following
  `references/eoffice.md`, showing each target's `params.project`. List
  targets with nothing new as "nothing new". After approval, save the draft to
  `<logRoot>/drafts/<window-start>_<window-end>_<HHmmss>.md` (never overwrite).
- Step 7: follow `references/eoffice.md` "Write procedure" with each task's
  `project` taken from its target. Keep the two gates separate. If
  `create-task --dry-run` fails for any target, stop the whole batch before any
  real create and name the failing target. Append a task to its **own target's**
  ledger only after every required step for that task succeeded; a failure in
  one target does not block ledgering the others.
- Ledger writes use a temp file + rename, as always.
- If `groupRoot` is itself a git repo and does not ignore `.log-task/`, ask
  before adding it to that repo's `.gitignore`.
````

- [ ] **Step 4: Update `references/eoffice.md`**

In "Draft format", append:

```markdown
For a group run, group the draft target -> module -> task and print each
target's resolved eOffice project (`params.project`) in its heading. Targets
with no new work appear as "nothing new".
```

In "Write procedure" step 1, change `Resolve people from the project's \`params\`.` to `Resolve people from the target's merged \`params\` (group defaults overridden by the child), and set \`project\` from the target's \`params.project\`.` and add after step 7: `8. In a group run, ledger each task into its own target's ledger; creation and reporting batches may span targets but approvals stay separate.`

- [ ] **Step 5: Update `projects.json.example`**

Add a third top-level entry after the Lark one (keep the existing two untouched):

```json
  "/absolute/path/to/nova-group-root": {
    "type": "group",
    "platform": "eoffice",
    "gitEmails": ["you@example.com"],
    "logDir": ".log-task",
    "params": {
      "defaultAssignor": "<visible current-user name>",
      "defaultAssignee": "<visible current-user name>",
      "defaultFollower": "<visible eOffice name>",
      "defaultCollaborator": "<same visible name as defaultFollower>"
    },
    "children": {
      "repo-a": { "params": { "project": "<eOffice project name>" } },
      "repo-b": { "params": { "project": "<eOffice project name>" }, "gitEmails": ["other@example.com"] }
    }
  }
```

Remember the previous last entry now needs a trailing comma.

- [ ] **Step 6: Update `DESIGN.md` and the spec**

In `DESIGN.md`, replace the bullet beginning `- No multi-repo/workspace scanning.` with:

```markdown
- No automatic repo discovery. Multi-repo logging is supported only for an
  explicitly declared `type: "group"` entry; see
  `docs/superpowers/specs/2026-10-12-group-log-task-design.md`. A single
  invocation still resolves exactly one config entry from `cwd`.
```

In the spec's "Ledger migration" section, replace `One-off, on first group run when old ledgers exist:` with `One-off, before loading the ledger of any run (group or child) that touches a child with an old skill-dir ledger; a child run must not start from an empty ledger and re-log old work:`. Also add to the spec's "Files changed" list: `scripts/resolve-project.mjs`, `scripts/lib/resolve-project.mjs`, `scripts/lib/ledger-migration.mjs` (deterministic resolution, ownership check, migration planning, with tests), and change `No script changes expected;` to `No change to \`eoffice-write.mjs\`;`.

- [ ] **Step 7: Verify the example and docs**

Run: `node -e "JSON.parse(require('fs').readFileSync('projects.json.example','utf8')); console.log('example ok')"`
Expected: `example ok`

Run: `node scripts/resolve-project.mjs resolve --cwd /definitely/not/configured --config projects.json.example; echo "exit=$?"`
Expected: stderr `No project configured for /definitely/not/configured`, then `exit=2`.

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add SKILL.md references/eoffice.md projects.json.example DESIGN.md docs/superpowers/specs/2026-10-12-group-log-task-design.md
git commit -m "docs: add group run procedure, config example, and migration timing"
```

---

### Task 5: End-to-end dry check

**Files:** none modified.

- [ ] **Step 1: Build a throwaway group workspace and resolve it**

Run:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/api/.git" "$tmp/web/.git"
cat > "$tmp/projects.json" <<EOF
{"$tmp":{"type":"group","platform":"eoffice","gitEmails":["a@x.com"],"params":{},"children":{"api":{"params":{"project":"API"}},"web":{"params":{"project":"WEB"}}}}}
EOF
node scripts/resolve-project.mjs resolve --cwd "$tmp" --config "$tmp/projects.json"
node scripts/resolve-project.mjs resolve --cwd "$tmp/web" --config "$tmp/projects.json"
node scripts/resolve-project.mjs migration-plan --cwd "$tmp" --config "$tmp/projects.json"
```

Expected: first call prints `"mode": "group-run"` with two targets whose `ledgerPath` is under `<tmp>/.log-task/ledger/`; second prints `"mode": "child-run"` with only `web`; third prints `"moves": []` and `"legacyRoot": null`.

- [ ] **Step 2: Run the full suite one last time**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 3: Report**

State plainly what was verified (the commands above) and what was not: no live eOffice write was performed, and the supervised headed run from `DESIGN.md` is still pending.
