# eOffice API Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/log-task` create eOffice tasks through the `work-normal-normal` API with per-project `rules` (name template, parent, owner, assignees), a read-only duplicate guard, and hard safety gates, without touching the Playwright writer.

**Architecture:** Small pure libraries do the deterministic work: `eoffice-rules.mjs` (validate rules, render the title, build the insert payload, plan which settings to ask), `eoffice-api.mjs` (HTTP client that never leaks the token, parent search, duplicate check, insert). Two thin CLIs expose them to `SKILL.md`: `eoffice-api-state.mjs` (no network: settings plan and remembered values) and `eoffice-api-write.mjs` (network: parent search, dry-run, apply). `resolve-project` is extended to carry each target's merged `rules` and a `statePath`.

**Tech Stack:** Node.js ESM (v24), `node:test`, `node:assert/strict`, `node:http` for the CLI test server. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-eoffice-api-writer-design.md`. Builds on `docs/superpowers/specs/2026-10-12-group-log-task-design.md` (already implemented on `feat/group-log-task`).

## Global Constraints

- Credentials only from the environment: `EOFFICE_BASE_URL`, `EOFFICE_ACCESS_TOKEN`. The token is never written to a file, ledger, draft, or any output; every error message is scrubbed of it.
- The agent never reads or prints `.env`; users run commands with `node --env-file=<path>`.
- Auth is the `access_token` query parameter. `POST` parameters go in a form-encoded body.
- `*_code` values are never used where an ID is expected (`project_code`, `parent_code`, `code`). Payloads never contain keys ending in `_code`.
- People fields take full names, comma-joined: `owner_ids`, `assign_ids`, `follower_ids`.
- Dates sent to the API are `dd/mm/YYYY`; evidence dates in batch files are `YYYY-MM-DD`.
- `insert` requires seven flags; defaults: `assign_other_off=0`, `is_restrict_subtask_time=no`, `follower_not_view=0`, `assign_parent_off=0`, `follower_other_not_view=0`, `status_after_report=REVIEW`, `is_view_parent_task=0`.
- Neither `insert` nor `update` has `percent`. This plan sends `status` only; whether that reaches 100% is a UAT item (spec "Unverified 2"), with the Playwright `report-progress` step as fallback.
- Duplicate guard: `filters=[{"s":"<title>","parent_id":"<id>"}]` and an exact `title` match on the returned rows. `s` is a substring search, so a substring-only hit is not a duplicate.
- `apply` needs `--confirm-host <host>` equal to the base-URL host. Any host that is not a UAT host also needs `--allow-production`.
- The fingerprint uses `{summary}`, not the rendered title (documented in Task 6; implemented by the existing ledger procedure).
- No change to `scripts/eoffice-write.mjs`, `lark`, or `manual`. Commits: concise conventional commits, no AI attribution, no push. Branch: `feat/eoffice-api-writer`.

## Review Focus

- A task `summary` that is blank must fail with a clear error, not render a title like `... - [BE] `. Pinned in Task 2.
- A response whose JSON has `error: true` (for example `accesstoken not of object`) must become a typed error, and the token must not appear in any message. Pinned in Task 3.
- A `gets` result that only contains the title as a substring must not count as a duplicate. Pinned in Task 3.
- `apply` without `--confirm-host`, with a wrong host, or on a non-UAT host without `--allow-production` must exit 2 and send no POST. Pinned in Task 5.
- One failing `insert` must not stop the other tasks, and the exit code must be 1 with the failure reported by task name. Pinned in Task 5.

---

### Task 1: Carry `rules` and `statePath` on resolved targets

**Files:**
- Modify: `scripts/lib/resolve-project.mjs` (the object returned by `buildChild`, and the standalone `targets[0]` object)
- Modify: `.gitignore`
- Test: `scripts/lib/resolve-project.test.mjs`

**Interfaces:**
- Consumes: existing `resolveProject`, `ledgerKey`.
- Produces: every `Target` gains `rules: object` (group `rules` shallow-merged with the child's `rules`, child wins per top-level key; `{}` when none) and `statePath: string` (`<logRoot>/state/<ledgerKey(name)>.json` for group children, `<skillDir>/state/<ledgerKey(key)>.json` for standalone).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/lib/resolve-project.test.mjs`:

```js
test('group child merges rules per top-level key and gets a statePath', () => {
  const c = config();
  c['/w/nova'].rules = { nameTemplate: 'T {summary}', done: { status: 'REVIEW' } };
  c['/w/nova'].children.api.rules = { done: { status: 'COMPLETED' } };
  const r = resolveProject(c, '/w/nova', { skillDir });
  const [api, web] = r.targets;
  assert.deepEqual(api.rules, { nameTemplate: 'T {summary}', done: { status: 'COMPLETED' } });
  assert.deepEqual(web.rules, { nameTemplate: 'T {summary}', done: { status: 'REVIEW' } });
  assert.equal(api.statePath, '/w/nova/.log-task/state/api.json');
  assert.equal(web.statePath, '/w/nova/.log-task/state/web.json');
});

test('group child without any rules gets an empty rules object', () => {
  const r = resolveProject(config(), '/w/nova', { skillDir });
  assert.deepEqual(r.targets[0].rules, {});
});

test('standalone target carries its rules and a skill-dir statePath', () => {
  const c = config();
  c['/w/solo'].rules = { nameTemplate: '{summary}' };
  const r = resolveProject(c, '/w/solo', { skillDir });
  assert.deepEqual(r.targets[0].rules, { nameTemplate: '{summary}' });
  assert.equal(r.targets[0].statePath, '/skill/state/w-solo.json');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/resolve-project.test.mjs`
Expected: the three new tests FAIL (`rules`/`statePath` are `undefined`); the existing tests still PASS.

- [ ] **Step 3: Implement**

In `scripts/lib/resolve-project.mjs`, in the object returned by `buildChild`, add after the `params,` line and after the `ledgerPath` line respectively:

```js
    rules: { ...group.rules, ...group.children[name].rules },
```

```js
    statePath: path.join(logRoot, 'state', `${ledgerKey(path.relative(groupKey, childPath))}.json`),
```

In the standalone branch (`targets: [{ name: key, ... }]`), add after the `ledgerPath` property:

```js
        rules: entry.rules ?? {},
        statePath: path.join(skillDir, 'state', `${ledgerKey(key)}.json`),
```

Append this line to `.gitignore`:

```
state/
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all tests PASS (the 75 existing plus 3 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/resolve-project.mjs scripts/lib/resolve-project.test.mjs .gitignore
git commit -m "feat: carry merged rules and statePath on resolved targets"
```

---

### Task 2: Rules library

**Files:**
- Create: `scripts/lib/eoffice-rules.mjs`
- Test: `scripts/lib/eoffice-rules.test.mjs`

**Interfaces:**
- Produces:
  - `class RulesError extends Error`
  - `REQUIRED_FLAG_DEFAULTS: Readonly<Record<string,string>>` (the seven flags above)
  - `validateRules(rules): rules` (throws `RulesError`)
  - `renderName(template: string, vars: {layer?: string, summary: string}): string`
  - `toApiDate(iso: 'YYYY-MM-DD'): 'DD/MM/YYYY'`
  - `buildInsertPayload(task, { rules, project, settings }): { title: string, payload: Record<string,string> }`
    where `task = { summary, layer?, startPlan?, endPlan?, start?, end? }`, `project = { ref: string, id?: string }` (`ref` is the value sent as `project_id`), `settings = { parent: number|string, owner?: string, assignees?: string[], followers?: string[] }`.
  - `settingsPlan(rules, remembered = {}): Record<string, { mode:'fixed', value } | { mode:'ask', preselected, search? }>`
  - `pickRemembered(rules, settings): object`

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/eoffice-rules.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RulesError, REQUIRED_FLAG_DEFAULTS, validateRules, renderName, toApiDate,
  buildInsertPayload, settingsPlan, pickRemembered,
} from './eoffice-rules.mjs';

const rules = () => ({
  nameTemplate: '[NVG.ITD - CDS Tập Đoàn] - One Nova - {layer} - [{layer}] {summary}',
  layer: { mode: 'fixed', value: 'BE' },
  parent: { mode: 'ask', search: 'OneNova -P', remember: true },
  owner: { mode: 'ask', default: 'Trần Nguyễn Đang Huy', remember: true },
  assignees: { mode: 'ask', default: ['Trần Nguyễn Đang Huy'], remember: true },
  followers: { mode: 'fixed', value: [] },
  done: { status: 'REVIEW' },
});
const settings = () => ({
  parent: 2089469,
  owner: 'Trần Nguyễn Đang Huy',
  assignees: ['Trần Nguyễn Đang Huy', 'Hoàng Văn Châu'],
  followers: [],
});
const project = { ref: '1456', id: '3869' };
const task = () => ({
  summary: 'Admin broadcast notification: endpoint, FCM topic',
  startPlan: '2026-10-06', endPlan: '2026-10-09', start: '2026-10-06', end: '2026-10-08',
});
const build = (t = task(), r = rules(), s = settings()) =>
  buildInsertPayload(t, { rules: r, project, settings: s });

test('validateRules accepts a complete rules object', () => {
  assert.equal(validateRules(rules()).layer.value, 'BE');
});

test('validateRules rejects a template without {summary}', () => {
  const r = rules(); r.nameTemplate = 'no summary here';
  assert.throws(() => validateRules(r), RulesError);
});

test('validateRules rejects an unknown template variable', () => {
  const r = rules(); r.nameTemplate = '{summary} {foo}';
  assert.throws(() => validateRules(r), (e) => e instanceof RulesError && e.message.includes('{foo}'));
});

test('validateRules requires rules.layer when the template uses {layer}', () => {
  const r = rules(); delete r.layer;
  assert.throws(() => validateRules(r), (e) => e instanceof RulesError && e.message.includes('layer'));
});

test('validateRules rejects a bad mode and a fixed field without a value', () => {
  const a = rules(); a.owner = { mode: 'sometimes' };
  assert.throws(() => validateRules(a), RulesError);
  const b = rules(); b.followers = { mode: 'fixed' };
  assert.throws(() => validateRules(b), RulesError);
});

test('renderName fills layer and summary', () => {
  assert.equal(renderName('[{layer}] {summary}', { layer: 'BE', summary: 'x' }), '[BE] x');
});

test('renderName throws when a used variable has no value', () => {
  assert.throws(() => renderName('[{layer}] {summary}', { summary: 'x' }), RulesError);
});

test('toApiDate converts ISO dates and rejects bad input', () => {
  assert.equal(toApiDate('2026-10-06'), '06/10/2026');
  assert.throws(() => toApiDate('2026-13-40'), RulesError);
  assert.throws(() => toApiDate('06/10/2026'), RulesError);
});

test('buildInsertPayload renders the title and maps people, parent and project', () => {
  const { title, payload } = build();
  assert.equal(title, '[NVG.ITD - CDS Tập Đoàn] - One Nova - BE - [BE] Admin broadcast notification: endpoint, FCM topic');
  assert.equal(payload.title, title);
  assert.equal(payload.project_id, '1456');
  assert.equal(payload.parent_id, '2089469');
  assert.equal(payload.owner_ids, 'Trần Nguyễn Đang Huy');
  assert.equal(payload.assign_ids, 'Trần Nguyễn Đang Huy,Hoàng Văn Châu');
  assert.equal(payload.status, 'REVIEW');
});

test('buildInsertPayload converts dates and omits empty followers', () => {
  const { payload } = build();
  assert.equal(payload.start_plan, '06/10/2026');
  assert.equal(payload.end_plan, '09/10/2026');
  assert.equal(payload.start, '06/10/2026');
  assert.equal(payload.end, '08/10/2026');
  assert.equal('follower_ids' in payload, false);
});

test('buildInsertPayload includes the seven required flags with their defaults', () => {
  const { payload } = build();
  for (const [k, v] of Object.entries(REQUIRED_FLAG_DEFAULTS)) assert.equal(payload[k], v);
  assert.equal(Object.keys(REQUIRED_FLAG_DEFAULTS).length, 7);
});

test('rules.flags override a default flag', () => {
  const r = rules(); r.flags = { assign_parent_off: '1' };
  assert.equal(build(task(), r).payload.assign_parent_off, '1');
});

test('a per-task layer overrides the fixed layer', () => {
  const t = { ...task(), layer: 'Mobile' };
  assert.match(build(t).title, / - Mobile - \[Mobile\] /);
});

test('payload never contains a key that ends in _code', () => {
  const { payload } = build();
  assert.equal(Object.keys(payload).some((k) => k.endsWith('_code') || k === 'code'), false);
});

test('a blank summary is rejected', () => {
  assert.throws(() => build({ ...task(), summary: '   ' }), (e) => e instanceof RulesError && e.message.includes('summary'));
});

test('a missing parent is rejected', () => {
  const s = settings(); delete s.parent;
  assert.throws(() => build(task(), rules(), s), (e) => e instanceof RulesError && e.message.includes('parent'));
});

test('settingsPlan prefers remembered values over the configured default', () => {
  const plan = settingsPlan(rules(), { owner: 'Remembered Owner', parent: 2089469 });
  assert.deepEqual(plan.owner, { mode: 'ask', preselected: 'Remembered Owner', search: undefined });
  assert.deepEqual(plan.parent, { mode: 'ask', preselected: 2089469, search: 'OneNova -P' });
  assert.deepEqual(plan.assignees.preselected, ['Trần Nguyễn Đang Huy']);
  assert.deepEqual(plan.followers, { mode: 'fixed', value: [] });
});

test('pickRemembered keeps only ask fields with remember true', () => {
  const r = rules(); r.assignees.remember = false;
  assert.deepEqual(pickRemembered(r, settings()), { parent: 2089469, owner: 'Trần Nguyễn Đang Huy' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/eoffice-rules.test.mjs`
Expected: FAIL, `Cannot find module './eoffice-rules.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/eoffice-rules.mjs`:

```js
export class RulesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RulesError';
  }
}

export const REQUIRED_FLAG_DEFAULTS = Object.freeze({
  assign_other_off: '0',
  is_restrict_subtask_time: 'no',
  follower_not_view: '0',
  assign_parent_off: '0',
  follower_other_not_view: '0',
  status_after_report: 'REVIEW',
  is_view_parent_task: '0',
});

const TEMPLATE_VARS = new Set(['layer', 'summary']);
const FIELD_KEYS = ['layer', 'parent', 'owner', 'assignees', 'followers'];
const SETTING_FIELDS = ['parent', 'owner', 'assignees', 'followers'];

export function validateRules(rules) {
  if (!rules || typeof rules !== 'object') throw new RulesError('rules is required');
  const template = rules.nameTemplate;
  if (typeof template !== 'string' || !template.includes('{summary}')) {
    throw new RulesError('rules.nameTemplate must be a string containing {summary}');
  }
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
    if (!TEMPLATE_VARS.has(name)) {
      throw new RulesError(`rules.nameTemplate uses unknown variable {${name}}`);
    }
  }
  if (template.includes('{layer}') && !rules.layer) {
    throw new RulesError('rules.layer is required when nameTemplate uses {layer}');
  }
  for (const key of FIELD_KEYS) {
    const field = rules[key];
    if (field === undefined) continue;
    if (!field || (field.mode !== 'fixed' && field.mode !== 'ask')) {
      throw new RulesError(`rules.${key}.mode must be "fixed" or "ask"`);
    }
    if (field.mode === 'fixed' && field.value === undefined) {
      throw new RulesError(`rules.${key} is fixed but has no value`);
    }
  }
  return rules;
}

export function renderName(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!TEMPLATE_VARS.has(name)) throw new RulesError(`Unknown template variable {${name}}`);
    const value = vars[name];
    if (typeof value !== 'string' || value === '') {
      throw new RulesError(`Template variable {${name}} has no value`);
    }
    return value;
  });
}

export function toApiDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!match) throw new RulesError(`Date must be YYYY-MM-DD, got "${iso}"`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    throw new RulesError(`Not a real date: "${iso}"`);
  }
  return `${day}/${month}/${year}`;
}

export function buildInsertPayload(task, { rules, project, settings }) {
  if (typeof task.summary !== 'string' || task.summary.trim() === '') {
    throw new RulesError('task.summary is required');
  }
  if (settings?.parent === undefined || settings.parent === null || settings.parent === '') {
    throw new RulesError('settings.parent is required');
  }
  if (!project?.ref) throw new RulesError('project.ref is required');

  const layer = task.layer ?? rules.layer?.value;
  const title = renderName(rules.nameTemplate, { layer, summary: task.summary.trim() });
  const payload = {
    title,
    status: rules.done?.status ?? 'REVIEW',
    project_id: String(project.ref),
    parent_id: String(settings.parent),
    ...REQUIRED_FLAG_DEFAULTS,
    ...rules.flags,
  };
  if (settings.owner) payload.owner_ids = settings.owner;
  if (settings.assignees?.length) payload.assign_ids = settings.assignees.join(',');
  if (settings.followers?.length) payload.follower_ids = settings.followers.join(',');
  for (const [from, to] of [
    ['startPlan', 'start_plan'], ['endPlan', 'end_plan'], ['start', 'start'], ['end', 'end'],
  ]) {
    if (task[from] !== undefined) payload[to] = toApiDate(task[from]);
  }
  return { title, payload };
}

export function settingsPlan(rules, remembered = {}) {
  const plan = {};
  for (const key of SETTING_FIELDS) {
    const field = rules[key];
    if (!field) continue;
    plan[key] = field.mode === 'fixed'
      ? { mode: 'fixed', value: field.value }
      : { mode: 'ask', preselected: remembered[key] ?? field.default, search: field.search };
  }
  return plan;
}

export function pickRemembered(rules, settings) {
  const picked = {};
  for (const key of SETTING_FIELDS) {
    const field = rules[key];
    if (field?.mode === 'ask' && field.remember && settings[key] !== undefined) {
      picked[key] = settings[key];
    }
  }
  return picked;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lib/eoffice-rules.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/eoffice-rules.mjs scripts/lib/eoffice-rules.test.mjs
git commit -m "feat: add eOffice rules library for name template and insert payload"
```

---

### Task 3: API client

**Files:**
- Create: `scripts/lib/eoffice-api.mjs`
- Test: `scripts/lib/eoffice-api.test.mjs`

**Interfaces:**
- Produces:
  - `class EofficeApiError extends Error` with `code: string` and `status?: number`
  - `createClient({ baseUrl, token, fetchImpl? }): { host: string, call(method: 'GET'|'POST', path: string, params?: object): Promise<object> }` (throws `EofficeApiError` with `code: 'missing_env'` when `baseUrl` or `token` is falsy)
  - `findParents(client, { projectId, search, limit? }): Promise<{ id, title, status }[]>`
  - `findDuplicate(client, { title, parentId }): Promise<{ id, title } | null>`
  - `insertTask(client, payload): Promise<object>`

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/eoffice-api.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EofficeApiError, createClient, findParents, findDuplicate, insertTask,
} from './eoffice-api.mjs';

const TOKEN = 'secret-token-123';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body } = await handler(new URL(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}
const client = (handler) => createClient({
  baseUrl: 'https://eoffice-uat.example.vn', token: TOKEN, fetchImpl: fakeFetch(handler),
});

test('createClient requires both env values', () => {
  assert.throws(() => createClient({ baseUrl: '', token: TOKEN }),
    (e) => e instanceof EofficeApiError && e.code === 'missing_env' && e.message.includes('EOFFICE_BASE_URL'));
  assert.throws(() => createClient({ baseUrl: 'https://x.vn', token: '' }),
    (e) => e instanceof EofficeApiError && e.message.includes('EOFFICE_ACCESS_TOKEN'));
});

test('client exposes the host', () => {
  assert.equal(client(() => ({ body: {} })).host, 'eoffice-uat.example.vn');
});

test('GET sends access_token and params in the query string', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { error: false, data: [] } }));
  const c = createClient({ baseUrl: 'https://eoffice-uat.example.vn', token: TOKEN, fetchImpl });
  await c.call('GET', '/api/work/normal/gets', { limit: 5 });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.pathname, '/api/work/normal/gets');
  assert.equal(url.searchParams.get('access_token'), TOKEN);
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(init.method, 'GET');
});

test('an error:true response becomes a typed error with the API code and no token', async () => {
  const fetchImpl = fakeFetch(() => ({
    body: { error: true, code: 'not object', message: `accesstoken not of object ${TOKEN}` },
  }));
  const c = createClient({ baseUrl: 'https://eoffice-uat.example.vn', token: TOKEN, fetchImpl });
  await assert.rejects(
    () => c.call('GET', '/api/work/normal/gets'),
    (e) => e instanceof EofficeApiError && e.code === 'not object'
      && !e.message.includes(TOKEN) && e.message.includes('<token>'),
  );
  assert.equal(fetchImpl.calls[0].url.searchParams.get('access_token'), TOKEN);
});

test('a non-JSON response and an HTTP error are typed errors', async () => {
  await assert.rejects(() => client(() => ({ body: '<html>' })).call('GET', '/x'),
    (e) => e instanceof EofficeApiError && e.code === 'non_json');
  await assert.rejects(() => client(() => ({ status: 500, body: {} })).call('GET', '/x'),
    (e) => e instanceof EofficeApiError && e.code === 'http' && e.status === 500);
});

test('a network failure is a typed error without the token', async () => {
  const c = createClient({
    baseUrl: 'https://eoffice-uat.example.vn',
    token: TOKEN,
    fetchImpl: async () => { throw new Error(`connect failed for ${TOKEN}`); },
  });
  await assert.rejects(() => c.call('GET', '/x'),
    (e) => e instanceof EofficeApiError && e.code === 'network' && !e.message.includes(TOKEN));
});

test('POST sends a form-encoded body and keeps the token in the query', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { error: false, data: { ID: 7 } } }));
  const c = createClient({ baseUrl: 'https://eoffice-uat.example.vn', token: TOKEN, fetchImpl });
  await insertTask(c, { title: 'T', parent_id: '1' });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.pathname, '/api/work/normal/insert');
  assert.equal(init.method, 'POST');
  assert.equal(url.searchParams.get('access_token'), TOKEN);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { title: 'T', parent_id: '1' });
  assert.equal(init.body.includes(TOKEN), false);
});

test('findParents filters by raw project ID and search text, and maps rows', async () => {
  const fetchImpl = fakeFetch(() => ({
    body: { error: false, data: [{ ID: 11, title: 'OneNova -P5- Development', status: 'DOING', extra: 1 }] },
  }));
  const c = createClient({ baseUrl: 'https://x.vn', token: TOKEN, fetchImpl });
  const rows = await findParents(c, { projectId: '3869', search: 'OneNova -P' });
  assert.deepEqual(rows, [{ id: 11, title: 'OneNova -P5- Development', status: 'DOING' }]);
  const q = fetchImpl.calls[0].url.searchParams;
  assert.deepEqual(JSON.parse(q.get('filters')), [{ project_id: '3869', s: 'OneNova -P' }]);
  assert.equal(q.get('limit'), '5');
  assert.equal(q.get('field_raws'), 'allfield');
});

test('findDuplicate returns the exact title match', async () => {
  const fetchImpl = fakeFetch(() => ({
    body: { error: false, data: [{ ID: 1, title: 'A - longer title' }, { ID: 2, title: 'A' }] },
  }));
  const c = createClient({ baseUrl: 'https://x.vn', token: TOKEN, fetchImpl });
  assert.deepEqual(await findDuplicate(c, { title: 'A', parentId: 2089469 }), { id: 2, title: 'A' });
  const f = JSON.parse(fetchImpl.calls[0].url.searchParams.get('filters'));
  assert.deepEqual(f, [{ s: 'A', parent_id: '2089469' }]);
});

test('a substring-only hit is not a duplicate', async () => {
  const c = client(() => ({ body: { error: false, data: [{ ID: 1, title: 'A - longer title' }] } }));
  assert.equal(await findDuplicate(c, { title: 'A', parentId: 1 }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/eoffice-api.test.mjs`
Expected: FAIL, `Cannot find module './eoffice-api.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/eoffice-api.mjs`:

```js
export class EofficeApiError extends Error {
  constructor(message, { code = 'api_error', status } = {}) {
    super(message);
    this.name = 'EofficeApiError';
    this.code = code;
    this.status = status;
  }
}

const GETS = '/api/work/normal/gets';
const INSERT = '/api/work/normal/insert';

export function createClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  if (!baseUrl) throw new EofficeApiError('EOFFICE_BASE_URL is not set', { code: 'missing_env' });
  if (!token) throw new EofficeApiError('EOFFICE_ACCESS_TOKEN is not set', { code: 'missing_env' });
  const host = new URL(baseUrl).host;
  const scrub = (value) => String(value).split(token).join('<token>');

  async function call(method, path, params = {}) {
    const url = new URL(path, baseUrl);
    url.searchParams.set('access_token', token);
    const init = { method };
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    } else {
      init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
      init.body = new URLSearchParams(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      ).toString();
    }

    let res;
    let text;
    try {
      res = await fetchImpl(url, init);
      text = await res.text();
    } catch (err) {
      throw new EofficeApiError(scrub(`Request to ${host} failed: ${err.message}`), { code: 'network' });
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new EofficeApiError(`Non-JSON response (HTTP ${res.status}) from ${host}`, {
        code: 'non_json', status: res.status,
      });
    }
    if (!res.ok) {
      throw new EofficeApiError(`HTTP ${res.status} from ${host}`, { code: 'http', status: res.status });
    }
    if (body.error === true) {
      throw new EofficeApiError(scrub(body.message || body.code || 'API error'), {
        code: String(body.code ?? 'api_error'), status: res.status,
      });
    }
    return body;
  }

  return { host, call };
}

async function gets(client, filter, limit) {
  const body = await client.call('GET', GETS, {
    limit,
    sort_by: 'ID',
    sort_type: 'desc',
    field_raws: 'allfield',
    filters: JSON.stringify([filter]),
  });
  return body.data ?? [];
}

export async function findParents(client, { projectId, search, limit = 5 }) {
  const rows = await gets(client, { project_id: String(projectId), s: search }, limit);
  return rows.map((row) => ({ id: row.ID, title: row.title, status: row.status }));
}

export async function findDuplicate(client, { title, parentId }) {
  const rows = await gets(client, { s: title, parent_id: String(parentId) }, 100);
  const hit = rows.find((row) => row.title === title);
  return hit ? { id: hit.ID, title: hit.title } : null;
}

export function insertTask(client, payload) {
  return client.call('POST', INSERT, payload);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lib/eoffice-api.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/eoffice-api.mjs scripts/lib/eoffice-api.test.mjs
git commit -m "feat: add eOffice API client with duplicate and parent lookup"
```

---

### Task 4: Shared CLI args and the state CLI

**Files:**
- Create: `scripts/lib/cli-args.mjs`
- Create: `scripts/eoffice-api-state.mjs`
- Test: `scripts/eoffice-api-state.test.mjs`

**Interfaces:**
- Produces:
  - `class UsageError extends Error`
  - `flag(args: string[], name: string, { required?: boolean }): string | undefined` (throws `UsageError` when a required flag is missing or a flag has no value)
  - CLI `node scripts/eoffice-api-state.mjs settings-plan --rules <rules.json> [--state <state.json>]` → prints `settingsPlan` JSON; exit 0.
  - CLI `node scripts/eoffice-api-state.mjs remember --rules <rules.json> --state <state.json> --settings <settings.json>` → merges `pickRemembered` into the state file (temp file + rename) and prints the picked object; exit 0.
  - Both exit 2 with a one-line stderr message on `UsageError` or `RulesError`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/eoffice-api-state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'eoffice-api-state.mjs');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/eoffice-api-state.test.mjs`
Expected: FAIL (the CLI does not exist; every assertion on status/stdout fails).

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/cli-args.mjs`:

```js
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function flag(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) throw new UsageError(`${name} is required`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}
```

Create `scripts/eoffice-api-state.mjs`:

```js
#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UsageError, flag } from './lib/cli-args.mjs';
import { RulesError, validateRules, settingsPlan, pickRemembered } from './lib/eoffice-rules.mjs';

const USAGE = `Usage:
  eoffice-api-state.mjs settings-plan --rules <rules.json> [--state <state.json>]
  eoffice-api-state.mjs remember --rules <rules.json> --state <state.json> --settings <settings.json>`;

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read ${label} ${file}: ${err.message}`);
  }
}

function readState(file) {
  return file && fs.existsSync(file) ? readJson(file, 'state') : {};
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command !== 'settings-plan' && command !== 'remember') throw new UsageError(USAGE);
  const rules = validateRules(readJson(flag(args, '--rules', { required: true }), 'rules'));
  const stateFile = flag(args, '--state', { required: command === 'remember' });
  const state = readState(stateFile);

  if (command === 'settings-plan') {
    console.log(JSON.stringify(settingsPlan(rules, state), null, 2));
    return 0;
  }
  const settings = readJson(flag(args, '--settings', { required: true }), 'settings');
  const picked = pickRemembered(rules, settings);
  writeAtomic(stateFile, { ...state, ...picked });
  console.log(JSON.stringify(picked));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError || err instanceof RulesError) {
    console.error(err.message.split('\n')[0]);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/eoffice-api-state.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/cli-args.mjs scripts/eoffice-api-state.mjs scripts/eoffice-api-state.test.mjs
git commit -m "feat: add eOffice API state CLI for settings plan and remembered values"
```

---

### Task 5: The write CLI

**Files:**
- Create: `scripts/eoffice-api-write.mjs`
- Test: `scripts/eoffice-api-write.test.mjs`

**Interfaces:**
- Consumes: `createClient`, `findParents`, `findDuplicate`, `insertTask`, `EofficeApiError` (Task 3); `validateRules`, `buildInsertPayload`, `RulesError` (Task 2); `UsageError`, `flag` (Task 4).
- Produces CLI (all read `EOFFICE_BASE_URL`, `EOFFICE_ACCESS_TOKEN` from the environment):
  - `search-parent --project-id <rawId> --search <text>` → prints a JSON array of `{id,title,status}`.
  - `create --dry-run <batch.json>` → read-only; prints `{ host, plan: [{summary,title,duplicate,payload}] }`.
  - `create --apply --confirm-host <host> [--allow-production] <batch.json>` → prints one JSON line `[{summary,title,submitted,skipped?,externalId?,error?}]`; exit 0 if every task is submitted or skipped as existing, else 1.
  - Exit 2 for usage, rules, missing env, refused apply. Exit 1 for API errors.
- `batch.json` shape: `{ "rules": {...}, "project": { "ref": "1456", "id": "3869" }, "settings": { "parent": 2089469, "owner": "...", "assignees": ["..."], "followers": [] }, "tasks": [ { "summary": "...", "layer": "BE", "startPlan": "2026-10-06", "endPlan": "2026-10-09", "start": "2026-10-06", "end": "2026-10-08" } ] }`.
- UAT host test: a host matches `/(^|[.-])uat([.-]|$)/i`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/eoffice-api-write.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'eoffice-api-write.mjs');
const TOKEN = 'secret-token';

async function startServer() {
  const tasks = [];
  const posts = [];
  let nextId = 1000;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (url.searchParams.get('access_token') !== TOKEN) {
      res.end(JSON.stringify({ error: true, code: 'not object', message: 'accesstoken not of object' }));
      return;
    }
    if (url.pathname === '/api/work/normal/gets') {
      const [filter] = JSON.parse(url.searchParams.get('filters') ?? '[{}]');
      const rows = tasks.filter((t) =>
        (!filter.s || t.title.includes(filter.s))
        && (!filter.parent_id || String(t.parent_id) === filter.parent_id)
        && (!filter.project_id || String(t.project_id) === filter.project_id));
      res.end(JSON.stringify({ error: false, total_item: rows.length, data: rows }));
      return;
    }
    if (url.pathname === '/api/work/normal/insert' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      posts.push(form);
      if (form.title.includes('FAIL')) {
        res.end(JSON.stringify({ error: true, code: 'invalid', message: 'bad title' }));
        return;
      }
      const row = { ID: nextId++, title: form.title, parent_id: form.parent_id, project_id: 3869, status: 'REVIEW' };
      tasks.push(row);
      res.end(JSON.stringify({ error: false, data: { ID: row.ID } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, tasks, posts, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [cli, ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const rules = {
  nameTemplate: '[One Nova] - {layer} - [{layer}] {summary}',
  layer: { mode: 'fixed', value: 'BE' },
  parent: { mode: 'ask', search: 'OneNova -P', remember: true },
  owner: { mode: 'ask', default: 'Owner Name', remember: true },
  assignees: { mode: 'ask', default: ['Owner Name'], remember: true },
  followers: { mode: 'fixed', value: [] },
  done: { status: 'REVIEW' },
};

function batchFile(summaries) {
  const dir = mkdtempSync(join(tmpdir(), 'eoffice-write-'));
  const file = join(dir, 'batch.json');
  writeFileSync(file, JSON.stringify({
    rules,
    project: { ref: '1456', id: '3869' },
    settings: { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name', 'Second Person'], followers: [] },
    tasks: summaries.map((summary) => ({
      summary, startPlan: '2026-10-06', endPlan: '2026-10-09', start: '2026-10-06', end: '2026-10-08',
    })),
  }));
  return file;
}

const env = (s) => ({ EOFFICE_BASE_URL: s.url, EOFFICE_ACCESS_TOKEN: TOKEN });
const lastLine = (text) => JSON.parse(text.trim().split('\n').at(-1));
const noToken = (r) => { assert.equal((r.out + r.err).includes(TOKEN), false); };

test('dry-run reads only: prints the plan, sends no POST, never prints the token', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--dry-run', batchFile(['Task one'])], env(s));
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.host, s.host);
    assert.equal(out.plan[0].title, '[One Nova] - BE - [BE] Task one');
    assert.equal(out.plan[0].duplicate, null);
    assert.equal(out.plan[0].payload.parent_id, '2089469');
    assert.equal(s.posts.length, 0);
    noToken(r);
  } finally { s.server.close(); }
});

test('apply without --confirm-host or with a wrong host exits 2 and sends no POST', async () => {
  const s = await startServer();
  try {
    const file = batchFile(['Task one']);
    const a = await run(['create', '--apply', '--allow-production', file], env(s));
    assert.equal(a.code, 2);
    const b = await run(['create', '--apply', '--allow-production', '--confirm-host', 'other.host', file], env(s));
    assert.equal(b.code, 2);
    assert.equal(s.posts.length, 0);
    noToken(a); noToken(b);
  } finally { s.server.close(); }
});

test('apply on a non-UAT host needs --allow-production', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--apply', '--confirm-host', s.host, batchFile(['Task one'])], env(s));
    assert.equal(r.code, 2);
    assert.match(r.err, /allow-production/);
    assert.equal(s.posts.length, 0);
  } finally { s.server.close(); }
});

test('apply creates the task, reads it back, and sends the required fields', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--apply', '--allow-production', '--confirm-host', s.host, batchFile(['Task one'])], env(s));
    assert.equal(r.code, 0, r.err);
    const [result] = lastLine(r.out);
    assert.equal(result.submitted, true);
    assert.equal(typeof result.externalId, 'number');
    assert.equal(s.posts.length, 1);
    const form = s.posts[0];
    assert.equal(form.title, '[One Nova] - BE - [BE] Task one');
    assert.equal(form.project_id, '1456');
    assert.equal(form.parent_id, '2089469');
    assert.equal(form.assign_ids, 'Owner Name,Second Person');
    assert.equal(form.status_after_report, 'REVIEW');
    assert.equal(Object.keys(form).some((k) => k.endsWith('_code')), false);
    noToken(r);
  } finally { s.server.close(); }
});

test('a second apply skips the task that already exists', async () => {
  const s = await startServer();
  try {
    const args = ['create', '--apply', '--allow-production', '--confirm-host', s.host, batchFile(['Task one'])];
    await run(args, env(s));
    const r = await run(args, env(s));
    assert.equal(r.code, 0, r.err);
    const [result] = lastLine(r.out);
    assert.equal(result.submitted, false);
    assert.equal(result.skipped, 'already exists');
    assert.equal(s.posts.length, 1);
  } finally { s.server.close(); }
});

test('one failing insert does not stop the others, exit code is 1, and the failure is named', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--apply', '--allow-production', '--confirm-host', s.host, batchFile(['Good one', 'FAIL two', 'Good three'])], env(s));
    assert.equal(r.code, 1);
    const results = lastLine(r.out);
    assert.deepEqual(results.map((x) => x.submitted), [true, false, true]);
    assert.equal(results[1].summary, 'FAIL two');
    assert.match(results[1].error, /bad title/);
    assert.equal(s.posts.length, 3);
    noToken(r);
  } finally { s.server.close(); }
});

test('a token without permission fails with the API message and no token in output', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--dry-run', batchFile(['Task one'])], { EOFFICE_BASE_URL: s.url, EOFFICE_ACCESS_TOKEN: 'wrong' });
    assert.equal(r.code, 1);
    assert.match(r.err, /accesstoken not of object/);
    assert.equal(r.out, '');
  } finally { s.server.close(); }
});

test('missing environment exits 2 naming the variable', async () => {
  const r = await run(['create', '--dry-run', 'whatever.json'], { EOFFICE_BASE_URL: '', EOFFICE_ACCESS_TOKEN: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /EOFFICE_BASE_URL/);
});

test('search-parent prints candidate parents', async () => {
  const s = await startServer();
  try {
    s.tasks.push({ ID: 55, title: 'OneNova -P5- Development', parent_id: 1, project_id: 3869, status: 'DOING' });
    const r = await run(['search-parent', '--project-id', '3869', '--search', 'OneNova -P'], env(s));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), [{ id: 55, title: 'OneNova -P5- Development', status: 'DOING' }]);
  } finally { s.server.close(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/eoffice-api-write.test.mjs`
Expected: FAIL (the CLI does not exist).

- [ ] **Step 3: Write the implementation**

Create `scripts/eoffice-api-write.mjs`:

```js
#!/usr/bin/env node
import * as fs from 'node:fs';
import { UsageError, flag } from './lib/cli-args.mjs';
import {
  EofficeApiError, createClient, findDuplicate, findParents, insertTask,
} from './lib/eoffice-api.mjs';
import { RulesError, buildInsertPayload, validateRules } from './lib/eoffice-rules.mjs';

const USAGE = `Usage:
  eoffice-api-write.mjs search-parent --project-id <rawId> --search <text>
  eoffice-api-write.mjs create --dry-run <batch.json>
  eoffice-api-write.mjs create --apply --confirm-host <host> [--allow-production] <batch.json>`;

const isUatHost = (host) => /(^|[.-])uat([.-]|$)/i.test(host);

function readBatch(file) {
  if (!file || file.startsWith('--')) throw new UsageError(USAGE);
  let batch;
  try {
    batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read batch ${file}: ${err.message}`);
  }
  validateRules(batch.rules);
  if (!Array.isArray(batch.tasks) || batch.tasks.length === 0) {
    throw new UsageError('batch.tasks must be a non-empty array');
  }
  return batch;
}

function assertApplyAllowed(args, client) {
  if (flag(args, '--confirm-host') !== client.host) {
    throw new UsageError(`--apply needs --confirm-host ${client.host}`);
  }
  if (!isUatHost(client.host) && !args.includes('--allow-production')) {
    throw new UsageError(`${client.host} is not a UAT host: --apply also needs --allow-production`);
  }
}

async function main(argv, env) {
  const [command, ...args] = argv;
  if (command !== 'search-parent' && command !== 'create') throw new UsageError(USAGE);
  const client = createClient({ baseUrl: env.EOFFICE_BASE_URL, token: env.EOFFICE_ACCESS_TOKEN });

  if (command === 'search-parent') {
    const rows = await findParents(client, {
      projectId: flag(args, '--project-id', { required: true }),
      search: flag(args, '--search', { required: true }),
    });
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  const apply = args.includes('--apply');
  if (apply === args.includes('--dry-run')) {
    throw new UsageError('create needs exactly one of --dry-run or --apply');
  }
  if (apply) assertApplyAllowed(args, client);

  const batch = readBatch(args.at(-1));
  const plan = [];
  for (const task of batch.tasks) {
    const { title, payload } = buildInsertPayload(task, batch);
    const duplicate = await findDuplicate(client, { title, parentId: batch.settings.parent });
    plan.push({ summary: task.summary, title, duplicate, payload });
  }

  if (!apply) {
    console.log(JSON.stringify({ host: client.host, plan }, null, 2));
    return 0;
  }

  const results = [];
  for (const item of plan) {
    const base = { summary: item.summary, title: item.title };
    if (item.duplicate) {
      results.push({ ...base, submitted: false, skipped: 'already exists', externalId: item.duplicate.id });
      continue;
    }
    try {
      await insertTask(client, item.payload);
      const confirmed = await findDuplicate(client, { title: item.title, parentId: batch.settings.parent });
      results.push(confirmed
        ? { ...base, submitted: true, externalId: confirmed.id }
        : { ...base, submitted: false, error: 'insert returned but the task was not found on read-back' });
    } catch (err) {
      if (!(err instanceof EofficeApiError)) throw err;
      results.push({ ...base, submitted: false, error: err.message });
    }
  }
  console.log(JSON.stringify(results));
  return results.every((r) => r.submitted || r.skipped) ? 0 : 1;
}

main(process.argv.slice(2), process.env).then(
  (code) => { process.exitCode = code; },
  (err) => {
    const usage = err instanceof UsageError || err instanceof RulesError
      || (err instanceof EofficeApiError && err.code === 'missing_env');
    if (usage || err instanceof EofficeApiError) {
      console.error(err.message.split('\n')[0]);
      process.exitCode = usage ? 2 : 1;
    } else {
      throw err;
    }
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/eoffice-api-write.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/eoffice-api-write.mjs scripts/eoffice-api-write.test.mjs
git commit -m "feat: add eOffice API write CLI with dry-run, apply gates and duplicate guard"
```

---

### Task 6: Procedure docs, env example and UAT checklist

**Files:**
- Create: `.env.example`
- Create: `references/eoffice-api.md`
- Create: `docs/eoffice-api-uat-checklist.md`
- Modify: `SKILL.md` (append a section)
- Modify: `projects.json.example`
- Modify: `DESIGN.md` (one pointer bullet)

- [ ] **Step 1: Create `.env.example`**

```
EOFFICE_BASE_URL=https://eoffice-uat.example.vn
EOFFICE_ACCESS_TOKEN=
```

- [ ] **Step 2: Create `references/eoffice-api.md`**

````markdown
# eoffice-api platform

Creates tasks through the `work-normal-normal` API. Credentials come only from
`EOFFICE_BASE_URL` and `EOFFICE_ACCESS_TOKEN`; the agent never reads `.env`.
The user runs, or approves running, every command with
`node --env-file=<path-to-env-file> <script> ...`.

## Config

Platform value `eoffice-api`. Group entries carry `rules`; a child's `rules`
replace the group's per top-level key (a child `done` replaces the whole group `done`).

```json
"rules": {
  "nameTemplate": "[NVG.ITD - CDS Tập Đoàn] - One Nova - {layer} - [{layer}] {summary}",
  "layer":     { "mode": "fixed", "value": "BE" },
  "parent":    { "mode": "ask", "search": "OneNova -P", "remember": true },
  "owner":     { "mode": "ask", "default": "<full name>", "remember": true },
  "assignees": { "mode": "ask", "default": ["<full name>"], "remember": true },
  "followers": { "mode": "fixed", "value": [] },
  "done":      { "status": "REVIEW" },
  "flags":     {}
}
```

- `fixed`: used as is. `ask`: prompted once per run; the pre-selected value is
  the remembered one, else `default`.
- Variables in `nameTemplate`: only `{layer}` and `{summary}`.
- `params.projectRef` is the value sent as `project_id` on insert (the project
  code or the raw ID, decided by the UAT checklist). `params.projectId` is the raw
  project ID used for the parent search. Read both once from an existing task
  of the project with `field_raws=allfield`. Never use a `*_code` value as an ID.

## Draft format

Same grouping as `manual.md`, plus for each task the rendered title, parent,
owner, assignees, plan dates (Estimate), actual dates (Actual evidence), and the
target host. Only `Done` tasks may be created.

## Procedure

1. Settings plan, from the target's `rules` saved to a temp file:
   `node <skill-dir>/scripts/eoffice-api-state.mjs settings-plan --rules <rules.json> --state <statePath>`.
2. Parent candidates (read-only):
   `node --env-file=<env> <skill-dir>/scripts/eoffice-api-write.mjs search-parent --project-id <projectId> --search "<rules.parent.search>"`.
   Show at most 5, pre-select the remembered one, and let the user pick.
3. Ask owner and assignees once for the run (pre-selected values from step 1).
4. Build `batch.json` (`rules`, `project: { ref, id }`, `settings`, `tasks`) and
   show the draft. Wait for explicit approval.
5. Dry-run (read-only, includes the duplicate guard):
   `node --env-file=<env> <skill-dir>/scripts/eoffice-api-write.mjs create --dry-run batch.json`.
   Show the plan, the host, and any task marked as already existing. Stop on any error.
6. Explicit approval that names the host. Then:
   `node --env-file=<env> <skill-dir>/scripts/eoffice-api-write.mjs create --apply --confirm-host <host> batch.json`.
   Add `--allow-production` only for a non-UAT host and only after the UAT
   checklist (`docs/eoffice-api-uat-checklist.md`) is recorded as done.
7. Parse the last output line. For each result with `submitted: true` or
   `skipped: "already exists"`, ledger the task with `externalId`. The ledger
   fingerprint uses the normalized `{summary}`, not the rendered title. Report
   each failure by task name; never retry with altered data.
8. Save the run's choices:
   `node <skill-dir>/scripts/eoffice-api-state.mjs remember --rules <rules.json> --state <statePath> --settings <settings.json>`.
9. If UAT shows a status-only route does not reach `percent=100`, run the
   existing `eoffice` `report-progress` flow (separate approval) for the created tasks.

## Errors

- `accesstoken not of object`: the token lacks permission for `work-normal-normal`; stop.
- Missing `EOFFICE_BASE_URL` or `EOFFICE_ACCESS_TOKEN`: exit 2 naming the variable.
- Apply refused (exit 2): wrong or missing `--confirm-host`, or non-UAT host without `--allow-production`.
- Partial failure: exit 1; ledger only the confirmed tasks.
````

- [ ] **Step 3: Create `docs/eoffice-api-uat-checklist.md`**

```markdown
# eOffice API UAT checklist

Record the date and result of each item before any production write. Use a UAT
host and a UAT token with write permission on `work-normal-normal`.

- [ ] `search-parent` returns the expected parent for the project.
- [ ] `create --dry-run` shows the right title, host, and no duplicate.
- [ ] `create --apply` inserts one task; it appears in the UAT UI with the
      right title, parent, owner, assignees, and dates.
- [ ] Date format `dd/mm/YYYY` accepted by `insert`.
- [ ] `project_id` accepts the project code or the raw ID (record which; set
      `params.projectRef` accordingly).
- [ ] Full names in `owner_ids` and `assign_ids` resolve to the right people.
- [ ] The seven required flags at their defaults are accepted.
- [ ] Status route: with `status=REVIEW`, does the task reach `percent=100`?
      If not, try `status=COMPLETED`, then `progress_type=TIMEFINISH`. If none
      works, use the Playwright `report-progress` step.
- [ ] `update` takes `id` (the docs table lists no `id` row).
- [ ] A second `create --apply` of the same batch skips the task as already existing.
- [ ] The `insert` response shape (record it; the CLI confirms by read-back).

Production: one supervised task, only after every item above is checked.
```

- [ ] **Step 4: Append to `SKILL.md`**

Append this section at the end of the file:

````markdown
## eoffice-api platform

When a target's `platform` is `eoffice-api`, replace the platform-specific
parts of Steps 5-7 with `references/eoffice-api.md` ("Draft format" and
"Procedure"). Everything else (evidence, per-target ledger, group runs, approval
gates) is unchanged. Never read `.env`; ask the user to run commands with
`node --env-file=<path>`. A token is never printed or stored.
````

- [ ] **Step 5: Update `projects.json.example`**

Add a fourth top-level entry (keep the others; add a comma after the previous last entry):

```json
  "/absolute/path/to/nova-api-group-root": {
    "type": "group",
    "platform": "eoffice-api",
    "gitEmails": ["you@example.com"],
    "logDir": ".log-task",
    "children": {
      "one-nova-be": {
        "params": {
          "project": "<eOffice project name>",
          "projectRef": "<project code or raw ID, per UAT checklist>",
          "projectId": "<raw project ID>"
        },
        "rules": {
          "nameTemplate": "[Unit] - One Nova - {layer} - [{layer}] {summary}",
          "layer": { "mode": "fixed", "value": "BE" },
          "parent": { "mode": "ask", "search": "<text in the parent task title>", "remember": true },
          "owner": { "mode": "ask", "default": "<full name>", "remember": true },
          "assignees": { "mode": "ask", "default": ["<full name>"], "remember": true },
          "followers": { "mode": "fixed", "value": [] },
          "done": { "status": "REVIEW" }
        }
      }
    }
  }
```

`params.project` stays because `resolve-project` requires it for every child.

- [ ] **Step 6: Update `DESIGN.md`**

Add this bullet under the existing `eoffice` platform text in "Platforms":

```markdown
- **`eoffice-api`** — creates tasks through the `work-normal-normal` API with
  per-project `rules`; see
  `docs/superpowers/specs/2026-10-12-eoffice-api-writer-design.md`. The
  Playwright `eoffice` platform remains as the fallback and for progress reports.
```

- [ ] **Step 7: Verify**

Run: `node -e "JSON.parse(require('fs').readFileSync('projects.json.example','utf8')); console.log('example ok')"`
Expected: `example ok`. (If the repo is ESM and `require` fails, use `node --input-type=module -e "import fs from 'node:fs'; JSON.parse(fs.readFileSync('projects.json.example','utf8')); console.log('example ok')"`.)

Run: `npm test`
Expected: all tests PASS.

Run: `git status --short`
Expected: only the files listed in this task are modified or new.

- [ ] **Step 8: Commit**

```bash
git add .env.example references/eoffice-api.md docs/eoffice-api-uat-checklist.md SKILL.md projects.json.example DESIGN.md
git commit -m "docs: add eoffice-api procedure, env example, and UAT checklist"
```
