import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../../skills/log-task/scripts/eoffice-api-write.mjs');
const TOKEN = 'secret-token';

async function startServer() {
  const tasks = [];
  const posts = [];
  let nextId = 1000;
  let failNextGets = false;
  const updates = [];
  const reports = [];
  const deletes = [];
  const unresolved = new Set();
  const keepOnDelete = new Set();
  const flags = { failNextItem: false, ignoreRealtime: false, dropOwnersOnAdd: false, noRedirectOnAdd: false };
  const realtimes = [];
  const adds = [];
  const apiHits = [];
  const itemCalls = [];
  const peopleIds = (value) => String(value ?? '').split(',').map((name) => name.trim())
    .filter((name) => name && !unresolved.has(name)).map((name) => 7000 + name.length).join(',');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/integration-document') {
      res.setHeader('csrf-token-cache', 'csrf-fresh-0123456789abcdef01234567');
      res.setHeader('content-type', 'text/html');
      res.end('<html></html>');
      return;
    }
    if (url.pathname === '/work-task-task/progress') {
      const ok = req.headers.cookie === 'sess=1' && req.headers['csrf-token-cache'] === 'csrf-fresh-0123456789abcdef01234567';
      if (!ok) {
        res.end(JSON.stringify({ message: 'Bạn không có quyền thực hiện chức năng này' }));
        return;
      }
      reports.push({ body, contentType: req.headers['content-type'] });
      const row = tasks.find((t) => String(t.ID) === /name="ID"\r\n\r\n(\d+)/.exec(body)?.[1]);
      if (!row || row.status !== 'DOING') {
        res.end(JSON.stringify({ message: 'Bạn không có quyền thực hiện chức năng này' }));
        return;
      }
      row.status = 'REVIEW'; row.percent = 100;
      res.end(JSON.stringify({ close: true, notice: 'Cập nhật thành công' }));
      return;
    }
    const sessionOk = req.headers.cookie === 'sess=1';
    if (url.pathname === '/work-normal-normal' && url.searchParams.get('v') === 'list') {
      if (!sessionOk) { res.end(JSON.stringify({ message: 'Bạn không có quyền thực hiện chức năng này' })); return; }
      const needle = url.searchParams.get('s');
      const wanted = url.searchParams.get('ids')?.split(',');
      const mine = wanted
        ? tasks.filter((t) => wanted.includes(String(t.ID)))
        : tasks.filter((t) => t.created_by_id === 8990 && (!needle || t.title.includes(needle)));
      const ui = (value) => (value ? `${String(value).slice(8, 10)}/${String(value).slice(5, 7)}/${String(value).slice(0, 4)}` : '');
      const page = Number(url.searchParams.get('p') ?? 1);
      const rowsHtml = mine.slice((page - 1) * 50, page * 50).map((t) => `{"view":"list","ID":${t.ID},"vals":{"title":${JSON.stringify(t.title)},"owner_ids":"${t.owner_ids}","assign_ids":"${t.assign_ids ?? ''}","status":"${t.status}","percent":${t.percent},"start_plan":"${ui(t.start_plan)}","start":"${ui(t.start)}","end_plan":"${ui(t.end_plan)}","end":"${ui(t.end)}"},"fields":{"title":"<a class=table-sub-title href=/work-normal-normal/view?ID=${t.parent_id}>Parent</a>"}}`).join(',');
      res.end(`<elem data-props='{"rows":[${rowsHtml}],"page":{"total":${mine.length},"current":${page},"range":50}}'></elem>`);
      return;
    }
    if (url.pathname === '/work-normal-normal/view') {
      if (!sessionOk) { res.end(JSON.stringify({ message: 'no' })); return; }
      const t = tasks.find((x) => String(x.ID) === url.searchParams.get('ID'));
      res.end(t ? `<elem data-props='{"rows":[{"view":"view","ID":${t.ID},"status":"${t.status}","end":null,"percent":${t.percent},"actions":null}]}'></elem>` : JSON.stringify({ message: 'The object has been deleted or does not exist' }));
      return;
    }
    if (url.pathname === '/work-task-task/edit') {
      const t = tasks.find((x) => String(x.ID) === url.searchParams.get('ID'));
      if (!sessionOk || !t) { res.end(JSON.stringify({ message: 'You don\'t have permission to do this action' })); return; }
      res.end(t.status !== 'DOING' ? JSON.stringify({ message: 'Cannot edit the task in the current status' })
        : `<elem data-props='{"owner_ids":"${t.owner_ids}","all_owner_ids":"${t.owner_ids}","assign_ids":"${t.assign_ids ?? ''}","all_assign_ids":"${t.assign_ids ?? ''}"}'></elem>`);
      return;
    }
    if (url.pathname.startsWith('/api/')) apiHits.push(url.pathname);
    if (url.pathname === '/work-task-task/add') {
      const ok = req.headers.cookie === 'sess=1' && req.headers['csrf-token-cache'] === 'csrf-fresh-0123456789abcdef01234567';
      if (!ok) {
        res.end(JSON.stringify({ message: 'Bạn không có quyền thực hiện chức năng này' }));
        return;
      }
      const fields = {};
      for (const match of body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)) (fields[match[1]] ??= []).push(match[2]);
      adds.push(fields);
      const row = {
        ID: nextId++, title: fields.title[0], parent_id: fields.parent_id[0], project_id: Number(fields.project_id[0]),
        status: 'DOING', percent: 0, created_by_id: 8990,
        owner_ids: flags.dropOwnersOnAdd ? '' : (fields['owner_ids[]'] ?? []).join(','),
        assign_ids: (fields['assign_ids[]'] ?? []).join(',') || null,
      };
      tasks.push(row);
      res.end(JSON.stringify(flags.noRedirectOnAdd
        ? { close: true, notice: 'Created successfully' }
        : { close: true, redirect: `work-normal-normal/view?ID=${row.ID}`, notice: 'Created successfully' }));
      return;
    }
    if (url.pathname === '/work-task-task/realtime') {
      const ok = req.headers.cookie === 'sess=1' && req.headers['csrf-token-cache'] === 'csrf-fresh-0123456789abcdef01234567';
      if (!ok) {
        res.end(JSON.stringify({ message: 'Bạn không có quyền thực hiện chức năng này' }));
        return;
      }
      const fields = {};
      for (const match of body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)) fields[match[1]] = match[2];
      realtimes.push(fields);
      const row = tasks.find((t) => String(t.ID) === fields.ID);
      const iso = (value) => (value ? `${value.slice(6, 10)}-${value.slice(3, 5)}-${value.slice(0, 2)} 00:00:00` : undefined);
      if (row && !flags.ignoreRealtime) {
        for (const [field, key] of [['start_plan', 'start_plan'], ['end_plan', 'end_plan'], ['start', 'start'], ['end', 'end']]) {
          if (fields[field]) row[key] = iso(fields[field]);
        }
      }
      res.end(JSON.stringify({ close: true, notice: 'Cập nhật thành công' }));
      return;
    }
    if (url.searchParams.get('access_token') !== TOKEN) {
      res.end(JSON.stringify({ error: true, code: 'not object', message: 'accesstoken not of object' }));
      return;
    }
    if (url.pathname === '/api/work/normal/gets') {
      if (failNextGets) {
        failNextGets = false;
        res.end(JSON.stringify({ error: true, code: 'x', message: 'boom' }));
        return;
      }
      const [filter] = JSON.parse(url.searchParams.get('filters') ?? '[{}]');
      const rows = tasks.filter((t) =>
        (!filter.s || t.title.includes(filter.s))
        && (!filter.parent_id || String(t.parent_id) === filter.parent_id)
        && (!filter.project_id || String(t.project_id) === filter.project_id));
      res.end(JSON.stringify({ error: false, total_item: rows.length, data: rows }));
      return;
    }
    if (url.pathname === '/api/work/normal/item') {
      const { access_token: _token, ...query } = Object.fromEntries(url.searchParams);
      itemCalls.push(query);
      if (flags.failNextItem) {
        flags.failNextItem = false;
        res.end(JSON.stringify({ error: true, code: 'x', message: 'item boom' }));
        return;
      }
      const row = tasks.find((t) => String(t.ID) === url.searchParams.get('ID'));
      res.end(JSON.stringify(row ? { error: false, data: row } : { error: true, message: 'Post not found' }));
      return;
    }
    if (url.pathname === '/api/work/normal/delete' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      deletes.push(form);
      const index = tasks.findIndex((t) => String(t.ID) === form.delIds);
      if (index >= 0 && !keepOnDelete.has(form.delIds)) tasks.splice(index, 1);
      res.end(JSON.stringify({ error: false }));
      return;
    }
    if (url.pathname === '/api/work/normal/update' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      updates.push(form);
      const row = tasks.find((t) => String(t.ID) === form.ID);
      if (row && form.status === 'Đang đánh giá') { row.status = 'REVIEW'; row.percent = 100; }
      if (row && form.status === 'Đang thực hiện') row.status = 'DOING';
      res.end(JSON.stringify({ error: false, data: { ID: form.ID } }));
      return;
    }
    if (url.pathname === '/api/work/normal/insert' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      posts.push(form);
      if (form.title.includes('FAIL')) {
        res.end(JSON.stringify({ error: true, code: 'invalid', message: 'bad title' }));
        return;
      }
      const row = {
        ID: nextId++, title: form.title, parent_id: form.parent_id, project_id: 3869, status: 'PENDING', percent: 0,
        created_by_id: 1, owner_ids: peopleIds(form.owner_ids), assign_ids: peopleIds(form.assign_ids) || null,
      };
      tasks.push(row);
      if (form.title.includes('READBACK')) failNextGets = true;
      res.end(JSON.stringify({ error: false, data: { ID: row.ID } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, tasks, posts, updates, reports, deletes, unresolved, keepOnDelete, flags, itemCalls, realtimes, adds, apiHits, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [cli, ...args], { env: { ...process.env, LOG_TASK_HOME: '/nonexistent-log-task-home', ...env } });
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

function batchFile(summaries, { settings, rulesOverride } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eoffice-write-'));
  const file = join(dir, 'batch.json');
  writeFileSync(file, JSON.stringify({
    rules: rulesOverride ?? rules,
    project: { ref: '1456', id: '3869' },
    settings: settings === undefined
      ? { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name', 'Second Person'], followers: [] }
      : settings ?? undefined,
    tasks: summaries.map((summary) => ({
      summary, startPlan: '2026-10-06', endPlan: '2026-10-09', start: '2026-10-06', end: '2026-10-08',
    })),
  }));
  return file;
}

const env = (s) => ({
  EOFFICE_BASE_URL: s.url, EOFFICE_ACCESS_TOKEN: TOKEN, EOFFICE_SETTLE_MS: '0', EOFFICE_SESSION_COOKIE: '',
  EOFFICE_TODAY: '2026-10-19', EOFFICE_ACCEPT_RUN_DATES: '1',
});
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
    assert.equal('status' in form, false);
    assert.equal(form.assign_other_off, 'Cho phép xem chéo');
    assert.equal(result.report, 'status-update-only');
    assert.equal(result.status, 'REVIEW');
    assert.deepEqual(s.updates, [{ ID: String(result.externalId), status: 'Đang đánh giá' }]);
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

const applyArgs = (s, file) => ['create', '--apply', '--allow-production', '--confirm-host', s.host, file];

test('two tasks with the same title in one batch create only one', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchFile(['Same', 'Same'])), env(s));
    assert.equal(r.code, 0, r.err);
    const results = lastLine(r.out);
    assert.equal(s.posts.length, 1);
    assert.equal(results[0].submitted, true);
    assert.equal(results[1].submitted, false);
    assert.equal(results[1].skipped, 'duplicate title in batch');
  } finally { s.server.close(); }
});

test('a failed read-back after a successful insert is reported as created but not confirmed', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchFile(['READBACK one', 'Other'])), env(s));
    assert.equal(r.code, 1);
    const results = lastLine(r.out);
    assert.equal(results[0].created, true);
    assert.equal(results[0].submitted, false);
    assert.match(results[0].error, /created but not finished: .*boom/);
    assert.equal(results[1].submitted, true);
    noToken(r);
  } finally { s.server.close(); }
});

test('a batch without settings exits 2 and sends no POST', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchFile(['Task one'], { settings: null })), env(s));
    assert.equal(r.code, 2);
    assert.match(r.err, /batch\.settings\.parent is required/);
    const d = await run(['create', '--dry-run', batchFile(['Task one'], { settings: null })], env(s));
    assert.equal(d.code, 2);
    assert.equal(s.posts.length, 0);
  } finally { s.server.close(); }
});

test('fixed followers from rules reach the payload when settings omit them', async () => {
  const s = await startServer();
  try {
    const fixed = { ...rules, followers: { mode: 'fixed', value: ['Fixed Follower'] } };
    const settings = { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name'] };
    const r = await run(applyArgs(s, batchFile(['Task one'], { settings, rulesOverride: fixed })), env(s));
    assert.equal(r.code, 0, r.err);
    assert.equal(s.posts[0].follower_ids, 'Fixed Follower');
  } finally { s.server.close(); }
});

test('explicit settings win over fixed rule values', async () => {
  const s = await startServer();
  try {
    const fixed = { ...rules, followers: { mode: 'fixed', value: ['Fixed Follower'] } };
    const settings = { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name'], followers: ['Explicit'] };
    const r = await run(applyArgs(s, batchFile(['Task one'], { settings, rulesOverride: fixed })), env(s));
    assert.equal(r.code, 0, r.err);
    assert.equal(s.posts[0].follower_ids, 'Explicit');
  } finally { s.server.close(); }
});

test('with a session cookie the report is posted instead of a status update', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchFile(['Task one'])), { ...env(s), EOFFICE_SESSION_COOKIE: 'sess=1' });
    assert.equal(r.code, 0, r.err);
    const [result] = lastLine(r.out);
    assert.equal(result.submitted, true);
    assert.equal(result.report, 'progress-report');
    assert.equal(result.status, 'REVIEW');
    assert.deepEqual(s.updates.map((u) => u.status), ['Đang thực hiện']);
    assert.equal(s.reports.length, 1);
    assert.match(s.reports[0].body, /items\[1\]\[date_report\]"\r\n\r\n08\/10\/2026/);
    assert.match(s.reports[0].body, /items\[1\]\[percent\]"\r\n\r\n100/);
    assert.equal((r.out + r.err).includes('sess=1'), false);
  } finally { s.server.close(); }
});

test('a rejected report leaves the task reported as created but not finished', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchFile(['Task one'])), { ...env(s), EOFFICE_SESSION_COOKIE: 'bad' });
    assert.equal(r.code, 1);
    const [result] = lastLine(r.out);
    assert.equal(result.created, true);
    assert.equal(result.submitted, false);
    assert.match(result.error, /created but not finished: Progress report refused/);
    assert.equal(typeof result.externalId, 'number');
  } finally { s.server.close(); }
});

test('a batch with empty assignees exits 2 before any POST', async () => {
  const s = await startServer();
  try {
    const settings = { parent: 2089469, owner: 'Owner Name', assignees: [] };
    const r = await run(applyArgs(s, batchFile(['Task one'], { settings })), env(s));
    assert.equal(r.code, 2);
    assert.match(r.err, /assignees/);
    assert.equal(s.posts.length, 0);
  } finally { s.server.close(); }
});

function batchWithChildren(parentSummary, childSummaries) {
  const file = batchFile([parentSummary]);
  const batch = JSON.parse(readFileSync(file, 'utf8'));
  batch.tasks[0].children = childSummaries.map((summary) => ({ summary, startPlan: '2026-10-06', endPlan: '2026-10-07' }));
  writeFileSync(file, JSON.stringify(batch));
  return file;
}

test('children are created under the new parent and finished before it', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchWithChildren('Parent', ['Child A', 'Child B'])), env(s));
    assert.equal(r.code, 0, r.err);
    const [parent] = lastLine(r.out);
    assert.equal(parent.submitted, true);
    assert.deepEqual(parent.children.map((c) => c.submitted), [true, true]);
    assert.equal(s.posts.length, 3);
    assert.equal(s.posts[0].parent_id, '2089469');
    assert.equal(s.posts[1].parent_id, String(parent.externalId));
    assert.equal(s.posts[2].parent_id, String(parent.externalId));
    assert.equal(s.posts[1].title, '[One Nova] - BE - [BE] Child A');
    assert.equal(s.updates.at(-1).ID, String(parent.externalId));
  } finally { s.server.close(); }
});

test('a rerun skips the parent and its children as already existing', async () => {
  const s = await startServer();
  try {
    const args = applyArgs(s, batchWithChildren('Parent', ['Child A']));
    await run(args, env(s));
    const r = await run(args, env(s));
    assert.equal(r.code, 0, r.err);
    const [parent] = lastLine(r.out);
    assert.equal(parent.skipped, 'already exists');
    assert.equal(parent.children[0].skipped, 'already exists');
    assert.equal(s.posts.length, 2);
  } finally { s.server.close(); }
});

test('children are not created when the parent insert fails', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchWithChildren('FAIL parent', ['Child A'])), env(s));
    assert.equal(r.code, 1);
    const [parent] = lastLine(r.out);
    assert.equal(parent.children[0].error, 'parent task was not created');
    assert.equal(s.posts.length, 1);
  } finally { s.server.close(); }
});

test('dry-run shows children with a placeholder parent and sends no POST', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--dry-run', batchWithChildren('Parent', ['Child A'])], env(s));
    assert.equal(r.code, 0, r.err);
    const [item] = JSON.parse(r.out).plan;
    assert.equal(item.children[0].payload.parent_id, '<id of the new parent task>');
    assert.equal(s.posts.length, 0);
  } finally { s.server.close(); }
});

test('with a session cookie, tasks in a hierarchy get a status update, not a report', async () => {
  const s = await startServer();
  try {
    const r = await run(applyArgs(s, batchWithChildren('Parent', ['Child A'])), { ...env(s), EOFFICE_SESSION_COOKIE: 'sess=1' });
    assert.equal(r.code, 0, r.err);
    const [parent] = lastLine(r.out);
    assert.equal(parent.report, 'status-update-only');
    assert.equal(parent.children[0].report, 'status-update-only');
    assert.equal(s.reports.length, 0);
    assert.equal(s.updates.length, 2);
  } finally { s.server.close(); }
});

test('nested children (grandchildren) are rejected with exit 2 and no POST', async () => {
  const s = await startServer();
  try {
    const file = batchWithChildren('Parent', ['Child A']);
    const batch = JSON.parse(readFileSync(file, 'utf8'));
    batch.tasks[0].children[0].children = [{ summary: 'Grandchild' }];
    writeFileSync(file, JSON.stringify(batch));
    for (const args of [['create', '--dry-run', file], applyArgs(s, file)]) {
      const r = await run(args, env(s));
      assert.equal(r.code, 2);
      assert.match(r.err, /Only one level of children/);
    }
    assert.equal(s.posts.length, 0);
  } finally { s.server.close(); }
});

test('--session-from rejects an unknown browser and dry-run use, sending no POST', async () => {
  const s = await startServer();
  try {
    const bad = await run([...applyArgs(s, batchFile(['Task one'])).slice(0, -1), '--session-from', 'firefox', batchFile(['Task one'])], env(s));
    assert.equal(bad.code, 2);
    assert.match(bad.err, /chrome or brave/);
    const dry = await run(['create', '--dry-run', '--session-from', 'brave', batchFile(['Task one'])], env(s));
    assert.equal(dry.code, 2);
    assert.match(dry.err, /only applies to --apply/);
    assert.equal(s.posts.length, 0);
  } finally { s.server.close(); }
});

test('a host listed in EOFFICE_UAT_HOSTS applies without --allow-production', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--apply', '--confirm-host', s.host, batchFile(['Task one'])], { ...env(s), EOFFICE_UAT_HOSTS: s.host });
    assert.equal(r.code, 0, r.err);
    assert.equal(s.posts.length, 1);
  } finally { s.server.close(); }
});

const applyAll = (s, file) => run(['create', '--apply', '--allow-production', '--confirm-host', s.host, file], env(s));

test('owner not resolved after insert: stop, no status update, later tasks not inserted', async () => {
  const s = await startServer();
  try {
    s.unresolved.add('Ghost');
    const file = batchFile(['One', 'Two'], { settings: { parent: 2089469, owner: 'Ghost', assignees: ['Second Person'], followers: [] } });
    const r = await applyAll(s, file);
    assert.equal(r.code, 1);
    const [first, second] = lastLine(r.out);
    assert.equal(first.created, true);
    assert.equal(first.submitted, false);
    assert.equal(typeof first.externalId, 'number');
    assert.match(first.error, /^people not resolved: owner$/);
    assert.equal(second.submitted, false);
    assert.match(second.skipped, /batch stopped/);
    assert.equal(s.updates.length, 0);
    assert.equal(s.posts.length, 1);
    noToken(r);
  } finally { s.server.close(); }
});

test('partially resolved assignees count as not resolved', async () => {
  const s = await startServer();
  try {
    s.unresolved.add('Ghost');
    const file = batchFile(['One'], { settings: { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name', 'Ghost'], followers: [] } });
    const r = await applyAll(s, file);
    assert.equal(r.code, 1);
    assert.match(lastLine(r.out)[0].error, /^people not resolved: assignees$/);
    assert.equal(s.updates.length, 0);
  } finally { s.server.close(); }
});

test('a child whose people do not resolve stops the batch and skips later siblings', async () => {
  const s = await startServer();
  try {
    s.unresolved.add('Ghost');
    const dir = mkdtempSync(join(tmpdir(), 'eoffice-write-'));
    const file = join(dir, 'batch.json');
    writeFileSync(file, JSON.stringify({
      rules, project: { ref: '1456', id: '3869' },
      settings: { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name'], followers: [] },
      tasks: [{
        summary: 'Parent', startPlan: '2026-10-06', endPlan: '2026-10-09',
        children: [
          { summary: 'Child A', startPlan: '2026-10-06', endPlan: '2026-10-09' },
          { summary: 'Child B', startPlan: '2026-10-06', endPlan: '2026-10-09' },
        ],
      }],
    }));
    const original = s.posts;
    const origPush = original.push.bind(original);
    original.push = (form) => { if (form.title.includes('Child A')) s.unresolved.add('Owner Name'); return origPush(form); };
    const r = await applyAll(s, file);
    assert.equal(r.code, 1);
    const [parent] = lastLine(r.out);
    assert.equal(parent.children[0].submitted, false);
    assert.match(parent.children[0].error, /people not resolved/);
    assert.match(parent.children[1].skipped, /batch stopped/);
    assert.equal(s.posts.length, 2);
  } finally { s.server.close(); }
});

test('a failing people check is reported as created but not finished and stops the batch', async () => {
  const s = await startServer();
  try {
    s.flags.failNextItem = true;
    const r = await applyAll(s, batchFile(['One', 'Two']));
    assert.equal(r.code, 1);
    const [first, second] = lastLine(r.out);
    assert.equal(first.created, true);
    assert.match(first.error, /created but not finished: item boom/);
    assert.match(second.skipped, /batch stopped/);
    assert.equal(s.updates.length, 0);
  } finally { s.server.close(); }
});

const seed = (s, overrides = {}) => {
  const row = {
    ID: 5000, title: 'Seeded task', parent_id: '1', project_id: 3869, status: 'PENDING', percent: 0,
    created_by_id: 1, owner_ids: '7001', assign_ids: '7001,7002', start_plan: '2026-10-06', end_plan: '2026-10-09',
    ...overrides,
  };
  s.tasks.push(row);
  return row;
};
const TEMPLATE = '{origin}/work-normal-normal/view?ID={id}';

test('get prints one entry per id with a link, exit 0 when all are found', async () => {
  const s = await startServer();
  try {
    seed(s);
    seed(s, { ID: 5001, title: 'Second' });
    const r = await run(['get', '--ids', '5000,5001'], { ...env(s), EOFFICE_TASK_URL_TEMPLATE: TEMPLATE });
    assert.equal(r.code, 0, r.err);
    const rows = JSON.parse(r.out);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].found, true);
    assert.equal(rows[0].title, 'Seeded task');
    assert.equal(rows[0].startPlan, '2026-10-06');
    assert.equal(rows[0].parentId, '1');
    assert.equal(rows[0].link, `${s.url}/work-normal-normal/view?ID=5000`);
    assert.equal(s.posts.length, 0);
    noToken(r);
  } finally { s.server.close(); }
});

test('get reports found:false for a missing id and exits 1', async () => {
  const s = await startServer();
  try {
    seed(s);
    const r = await run(['get', '--ids', '5000,424242'], env(s));
    assert.equal(r.code, 1);
    const rows = JSON.parse(r.out);
    assert.deepEqual(rows.map((row) => row.found), [true, false]);
    assert.equal(rows[1].id, 424242);
  } finally { s.server.close(); }
});

test('get --raw asks for raw values, plain get does not', async () => {
  const s = await startServer();
  try {
    seed(s);
    await run(['get', '--ids', '5000'], env(s));
    await run(['get', '--ids', '5000', '--raw'], env(s));
    assert.deepEqual(s.itemCalls, [{ ID: '5000' }, { ID: '5000', field_raws: 'allfield' }]);
  } finally { s.server.close(); }
});

test('get rejects empty, non-numeric and missing --ids with exit 2', async () => {
  const s = await startServer();
  try {
    for (const args of [['get', '--ids', ''], ['get', '--ids', 'abc'], ['get', '--ids', '1,x'], ['get']]) {
      const r = await run(args, env(s));
      assert.equal(r.code, 2, args.join(' '));
    }
    assert.equal(s.itemCalls.length, 0);
  } finally { s.server.close(); }
});

const del = (s, args, extra = {}) => run(['delete', ...args], { ...env(s), ...extra });
const applyDel = (s, ids, more = []) => del(s, ['--apply', '--confirm-host', s.host, '--allow-production', '--project-id', '3869', ...more, '--ids', ids]);

test('delete --dry-run classifies each id and calls no delete', async () => {
  const s = await startServer();
  try {
    seed(s);
    seed(s, { ID: 5001, project_id: 9999 });
    seed(s, { ID: 5002, created_by_id: 8990 });
    const r = await del(s, ['--dry-run', '--project-id', '3869', '--ids', '5000,5001,5002,424242']);
    assert.equal(r.code, 1);
    const rows = JSON.parse(r.out);
    assert.deepEqual(rows.map((row) => row.result), ['deletable', 'refused', 'refused', 'absent']);
    assert.match(rows[1].reason, /project_id 9999/);
    assert.match(rows[2].reason, /created_by_id 8990/);
    assert.equal(s.deletes.length, 0);
  } finally { s.server.close(); }
});

test('delete --apply removes a task one id per call and confirms it is gone', async () => {
  const s = await startServer();
  try {
    seed(s);
    seed(s, { ID: 5001 });
    const r = await applyDel(s, '5000,5001');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).map((row) => row.result), ['deleted', 'deleted']);
    assert.deepEqual(s.deletes, [{ delIds: '5000' }, { delIds: '5001' }]);
    assert.equal(s.tasks.length, 0);
    noToken(r);
  } finally { s.server.close(); }
});

test('delete of an already deleted id is absent and makes no delete call', async () => {
  const s = await startServer();
  try {
    const r = await applyDel(s, '424242');
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out)[0].result, 'absent');
    assert.equal(s.deletes.length, 0);
  } finally { s.server.close(); }
});

test('delete apply stops before any call when one id is in another project', async () => {
  const s = await startServer();
  try {
    seed(s);
    seed(s, { ID: 5001, project_id: 9999 });
    const r = await applyDel(s, '5000,5001');
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out)[1].result, 'refused');
    assert.equal(s.deletes.length, 0);
    assert.equal(s.tasks.length, 2);
  } finally { s.server.close(); }
});

test('a hand-made task is refused unless --allow-foreign is given', async () => {
  const s = await startServer();
  try {
    seed(s, { created_by_id: 8990 });
    const refused = await applyDel(s, '5000');
    assert.equal(refused.code, 2);
    assert.equal(s.deletes.length, 0);
    const allowed = await applyDel(s, '5000', ['--allow-foreign']);
    assert.equal(allowed.code, 0, allowed.err);
    assert.equal(JSON.parse(allowed.out)[0].result, 'deleted');
  } finally { s.server.close(); }
});

test('error:false but the task is still there is reported and stops the run', async () => {
  const s = await startServer();
  try {
    seed(s);
    seed(s, { ID: 5001 });
    s.keepOnDelete.add('5000');
    const r = await applyDel(s, '5000,5001');
    assert.equal(r.code, 1);
    const rows = JSON.parse(r.out);
    assert.equal(rows[0].result, 'still present');
    assert.equal(rows[1].result, 'deletable');
    assert.match(rows[1].reason, /not attempted/);
    assert.deepEqual(s.deletes, [{ delIds: '5000' }]);
  } finally { s.server.close(); }
});

test('delete apply needs --confirm-host, and production needs --allow-production', async () => {
  const s = await startServer();
  try {
    seed(s);
    const noHost = await del(s, ['--apply', '--allow-production', '--project-id', '3869', '--ids', '5000']);
    assert.equal(noHost.code, 2);
    const noProd = await del(s, ['--apply', '--confirm-host', s.host, '--project-id', '3869', '--ids', '5000']);
    assert.equal(noProd.code, 2);
    assert.match(noProd.err, /allow-production/);
    assert.equal(s.deletes.length, 0);
  } finally { s.server.close(); }
});

test('delete needs a project id and exactly one of --dry-run or --apply', async () => {
  const s = await startServer();
  try {
    seed(s);
    assert.equal((await del(s, ['--dry-run', '--ids', '5000'])).code, 2);
    assert.equal((await del(s, ['--project-id', '3869', '--ids', '5000'])).code, 2);
    const viaEnv = await del(s, ['--dry-run', '--ids', '5000'], { EOFFICE_PROJECT_ID: '3869' });
    assert.equal(viaEnv.code, 0, viaEnv.err);
  } finally { s.server.close(); }
});

test('apply results carry a link when the template is set and omit it with one hint when not', async () => {
  const s = await startServer();
  try {
    const withTemplate = await run(
      ['create', '--apply', '--allow-production', '--confirm-host', s.host, batchFile(['Linked one'])],
      { ...env(s), EOFFICE_TASK_URL_TEMPLATE: TEMPLATE },
    );
    const [linked] = lastLine(withTemplate.out);
    assert.equal(linked.link, `${s.url}/work-normal-normal/view?ID=${linked.externalId}`);
    assert.doesNotMatch(withTemplate.err, /EOFFICE_TASK_URL_TEMPLATE/);

    const without = await applyAll(s, batchFile(['Linked two', 'Linked three']));
    const results = lastLine(without.out);
    assert.equal(results.every((row) => !('link' in row)), true);
    assert.equal(without.err.split('EOFFICE_TASK_URL_TEMPLATE').length - 1, 1);
  } finally { s.server.close(); }
});

test('an existing task keeps its link in the dry-run plan and in the skipped result', async () => {
  const s = await startServer();
  try {
    const file = batchFile(['Again']);
    await applyAll(s, file);
    const extra = { ...env(s), EOFFICE_TASK_URL_TEMPLATE: TEMPLATE };
    const plan = JSON.parse((await run(['create', '--dry-run', file], extra)).out).plan[0];
    assert.equal(plan.duplicate.link, `${s.url}/work-normal-normal/view?ID=${plan.duplicate.id}`);
    const rerun = await run(['create', '--apply', '--allow-production', '--confirm-host', s.host, file], extra);
    const [skipped] = lastLine(rerun.out);
    assert.equal(skipped.skipped, 'already exists');
    assert.equal(skipped.link, `${s.url}/work-normal-normal/view?ID=${skipped.externalId}`);
  } finally { s.server.close(); }
});

const dates = (s, args, extra = {}) => run(['set-dates', ...args], { ...env(s), ...extra });
const sess = { EOFFICE_SESSION_COOKIE: 'sess=1' };
const applyDates = (s, more, extra = sess) => dates(s, ['--apply', '--confirm-host', s.host, '--allow-production', '--project-id', '3869', ...more], extra);

test('set-dates --dry-run shows before and after and sends nothing', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    const r = await dates(s, ['--dry-run', '--project-id', '3869', '--ids', '5000', '--actual-from-plan']);
    assert.equal(r.code, 0, r.err);
    const [row] = JSON.parse(r.out);
    assert.equal(row.result, 'would update');
    assert.deepEqual(row.before, { startPlan: '2026-10-06', endPlan: '2026-10-09', start: '2026-10-19', end: '2026-10-19' });
    assert.deepEqual(row.after, { startPlan: '2026-10-06', endPlan: '2026-10-09', start: '2026-10-06', end: '2026-10-09' });
    assert.equal(s.realtimes.length, 0);
  } finally { s.server.close(); }
});

test('set-dates --apply sends every date together, then confirms by read-back', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    const r = await applyDates(s, ['--ids', '5000', '--actual-from-plan']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out)[0].result, 'updated');
    assert.deepEqual(s.realtimes, [{
      ID: '5000', start_plan: '06/10/2026', end_plan: '09/10/2026', start: '06/10/2026', end: '09/10/2026', inlineLogin: '1',
    }]);
    assert.equal(s.tasks[0].start.slice(0, 10), '2026-10-06');
    assert.equal((r.out + r.err).includes('sess=1'), false);
  } finally { s.server.close(); }
});

test('explicit --start and --end change only those, keeping the plan dates', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    const r = await applyDates(s, ['--ids', '5000', '--start', '2026-10-07', '--end', '2026-10-08']);
    assert.equal(r.code, 0, r.err);
    assert.equal(s.realtimes[0].start_plan, '06/10/2026');
    assert.equal(s.realtimes[0].start, '07/10/2026');
    assert.equal(s.realtimes[0].end, '08/10/2026');
  } finally { s.server.close(); }
});

test('set-dates makes no call for a task whose dates already match', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-06 00:00:00', end: '2026-10-09 00:00:00' });
    const r = await applyDates(s, ['--ids', '5000', '--actual-from-plan']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out)[0].result, 'unchanged');
    assert.equal(s.realtimes.length, 0);
  } finally { s.server.close(); }
});

test('a server that ignores the update is reported as mismatch with exit 1', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    s.flags.ignoreRealtime = true;
    const r = await applyDates(s, ['--ids', '5000', '--actual-from-plan']);
    assert.equal(r.code, 1);
    const [row] = JSON.parse(r.out);
    assert.equal(row.result, 'mismatch');
    assert.equal(row.actual.start, '2026-10-19');
  } finally { s.server.close(); }
});

test('set-dates --apply needs a session and the usual host gate', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    const noSession = await applyDates(s, ['--ids', '5000', '--actual-from-plan'], { EOFFICE_SESSION_COOKIE: '' });
    assert.equal(noSession.code, 2);
    assert.match(noSession.err, /session/);
    const noHost = await dates(s, ['--apply', '--allow-production', '--project-id', '3869', '--ids', '5000', '--actual-from-plan'], sess);
    assert.equal(noHost.code, 2);
    const noProd = await dates(s, ['--apply', '--confirm-host', s.host, '--project-id', '3869', '--ids', '5000', '--actual-from-plan'], sess);
    assert.equal(noProd.code, 2);
    assert.equal(s.realtimes.length, 0);
  } finally { s.server.close(); }
});

test('a rejected session is reported per task and stops the run', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    seed(s, { ID: 5001, start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    const r = await applyDates(s, ['--ids', '5000,5001', '--actual-from-plan'], { EOFFICE_SESSION_COOKIE: 'sess=wrong' });
    assert.equal(r.code, 1);
    const rows = JSON.parse(r.out);
    assert.equal(rows[0].result, 'error');
    assert.match(rows[0].error, /only an owner of the task may edit its dates/);
    assert.equal(rows[1].result, 'not attempted');
    assert.equal(s.tasks[0].start.slice(0, 10), '2026-10-19');
  } finally { s.server.close(); }
});

test('set-dates refuses another project or a missing task before any call', async () => {
  const s = await startServer();
  try {
    seed(s, { project_id: 9999 });
    const other = await applyDates(s, ['--ids', '5000', '--actual-from-plan']);
    assert.equal(other.code, 2);
    const missing = await applyDates(s, ['--ids', '424242', '--actual-from-plan']);
    assert.equal(missing.code, 2);
    assert.equal(s.realtimes.length, 0);
  } finally { s.server.close(); }
});

test('set-dates rejects bad options with exit 2', async () => {
  const s = await startServer();
  try {
    seed(s);
    const base = ['--dry-run', '--project-id', '3869', '--ids', '5000'];
    for (const extra of [[], ['--actual-from-plan', '--start', '2026-10-01'], ['--start', '01/10/2026'], ['--end', '2026-13-40']]) {
      const r = await dates(s, [...base, ...extra]);
      assert.equal(r.code, 2, extra.join(' '));
    }
  } finally { s.server.close(); }
});

const people = { 'Owner Name': 1, 'Second Person': 2 };
const sessionRules = { ...rules, people };
const viaSession = (s, file, extra = sess) => run(
  ['create', '--apply', '--allow-production', '--confirm-host', s.host, '--via', 'session', file], { ...env(s), ...extra },
);

test('--via session dry-run shows the UI fields with numeric user ids and sends nothing', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--dry-run', '--via', 'session', batchFile(['Task one'], { rulesOverride: sessionRules })], env(s));
    assert.equal(r.code, 0, r.err);
    const [item] = JSON.parse(r.out).plan;
    assert.deepEqual(item.session, {
      title: item.title, projectId: '3869', startPlan: '06/10/2026', endPlan: '09/10/2026',
      ownerIds: [1], assigneeIds: [1, 2], followerIds: [],
    });
    assert.equal(s.posts.length + s.adds.length, 0);
  } finally { s.server.close(); }
});

test('--via session refuses a name that rules.people does not map, before any call', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--dry-run', '--via', 'session', batchFile(['Task one'])], env(s));
    assert.equal(r.code, 2);
    assert.match(r.err, /rules\.people has no user ID for: Owner Name/);
  } finally { s.server.close(); }
});

test('--via session apply needs a browser session and rejects unknown values', async () => {
  const s = await startServer();
  try {
    const file = batchFile(['Task one'], { rulesOverride: sessionRules });
    const noSession = await viaSession(s, file, { EOFFICE_SESSION_COOKIE: '' });
    assert.equal(noSession.code, 2);
    assert.match(noSession.err, /browser session/);
    const bad = await run(['create', '--dry-run', '--via', 'soap', file], env(s));
    assert.equal(bad.code, 2);
    assert.equal(s.adds.length + s.posts.length, 0);
  } finally { s.server.close(); }
});

test('--via session creates a flat task as the signed-in user and finishes it with a progress report', async () => {
  const s = await startServer();
  try {
    const r = await viaSession(s, batchFile(['Task one'], { rulesOverride: sessionRules }));
    assert.equal(r.code, 0, r.err);
    const [result] = lastLine(r.out);
    assert.equal(result.submitted, true);
    assert.equal(result.report, 'progress-report');
    assert.equal(result.status, 'REVIEW');
    assert.equal(s.posts.length, 0);
    assert.deepEqual(s.updates, []);
    assert.equal(s.reports.length, 1);
    const [fields] = s.adds;
    assert.deepEqual(fields['owner_ids[]'], ['1']);
    assert.deepEqual(fields['assign_ids[]'], ['1', '2']);
    assert.equal(fields.project_id[0], '3869');
    assert.equal(fields.parent_id[0], '2089469');
    assert.equal(s.tasks[0].created_by_id, 8990);
    assert.equal((r.out + r.err).includes('sess=1'), false);
  } finally { s.server.close(); }
});

test('--via session creates children under the new parent and finishes them with a status update', async () => {
  const s = await startServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'eoffice-write-'));
    const file = join(dir, 'batch.json');
    writeFileSync(file, JSON.stringify({
      rules: sessionRules, project: { ref: '1456', id: '3869' },
      settings: { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name'], followers: [] },
      tasks: [{ summary: 'Parent', startPlan: '2026-10-06', endPlan: '2026-10-09', children: [{ summary: 'Child', startPlan: '2026-10-06', endPlan: '2026-10-07' }] }],
    }));
    const r = await viaSession(s, file);
    assert.equal(r.code, 0, r.err);
    const [parent] = lastLine(r.out);
    assert.equal(parent.children[0].submitted, true);
    assert.equal(s.adds[1].parent_id[0], String(parent.externalId));
    assert.equal(s.updates.every((u) => u.status === 'Đang đánh giá'), true);
    assert.equal(s.reports.length, 0);
    assert.deepEqual(s.tasks.map((t) => t.status), ['REVIEW', 'REVIEW']);
  } finally { s.server.close(); }
});

test('--via session stops the batch when the server drops the owners', async () => {
  const s = await startServer();
  try {
    s.flags.dropOwnersOnAdd = true;
    const r = await viaSession(s, batchFile(['One', 'Two'], { rulesOverride: sessionRules }));
    assert.equal(r.code, 1);
    const [first, second] = lastLine(r.out);
    assert.match(first.error, /^people not resolved: owner$/);
    assert.match(second.skipped, /batch stopped/);
    assert.equal(s.adds.length, 1);
    assert.equal(s.reports.length + s.updates.length, 0);
  } finally { s.server.close(); }
});

test('--via session falls back to a title lookup when the response carries no id', async () => {
  const s = await startServer();
  try {
    s.flags.noRedirectOnAdd = true;
    const r = await viaSession(s, batchFile(['Task one'], { rulesOverride: sessionRules }));
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLine(r.out)[0].submitted, true);
    assert.equal(s.adds.length, 1);
  } finally { s.server.close(); }
});

test('a rejected session on --via session creates nothing and says so', async () => {
  const s = await startServer();
  try {
    const r = await viaSession(s, batchFile(['Task one'], { rulesOverride: sessionRules }), { EOFFICE_SESSION_COOKIE: 'sess=wrong' });
    assert.equal(r.code, 1);
    const [result] = lastLine(r.out);
    assert.equal(result.submitted, false);
    assert.equal(result.created, undefined);
    assert.match(result.error, /Task creation refused/);
    assert.equal(s.tasks.length, 0);
  } finally { s.server.close(); }
});

test('--via session --no-report finishes a flat task with a status update and no report', async () => {
  const s = await startServer();
  try {
    const r = await run(
      ['create', '--apply', '--allow-production', '--confirm-host', s.host, '--via', 'session', '--no-report',
        batchFile(['Task one'], { rulesOverride: sessionRules })],
      { ...env(s), ...sess },
    );
    assert.equal(r.code, 0, r.err);
    const [result] = lastLine(r.out);
    assert.equal(result.report, 'status-update-only');
    assert.equal(result.status, 'REVIEW');
    assert.equal(s.reports.length, 0);
    assert.deepEqual(s.updates.map((u) => u.status), ['Đang đánh giá']);
  } finally { s.server.close(); }
});

test('production apply refuses tasks that would get the run date unless accepted', async () => {
  const s = await startServer();
  try {
    const strict = { ...env(s), EOFFICE_ACCEPT_RUN_DATES: '' };
    const refused = await run(['create', '--apply', '--allow-production', '--confirm-host', s.host, batchFile(['Past task'])], strict);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /actual dates = run date/);
    assert.equal(s.posts.length, 0);
    const flagged = await run(['create', '--apply', '--allow-production', '--confirm-host', s.host, '--accept-run-dates', batchFile(['Past task'])], strict);
    assert.equal(flagged.code, 0, flagged.err);
    assert.equal(lastLine(flagged.out)[0].datesFromRun, true);
  } finally { s.server.close(); }
});

test('a session-created flat task with a report keeps plan dates and is not flagged', async () => {
  const s = await startServer();
  try {
    const strict = { ...env(s), EOFFICE_ACCEPT_RUN_DATES: '', ...sess };
    const r = await run(['create', '--apply', '--allow-production', '--confirm-host', s.host, '--via', 'session',
      batchFile(['Past task'], { rulesOverride: sessionRules })], strict);
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLine(r.out)[0].datesFromRun, undefined);
    const dry = await run(['create', '--dry-run', '--via', 'session', batchFile(['Past task'], { rulesOverride: sessionRules })], strict);
    assert.equal(JSON.parse(dry.out).plan[0].datesFromRun, false);
    const noReport = await run(['create', '--dry-run', '--via', 'session', '--no-report', batchFile(['Past task'], { rulesOverride: sessionRules })], strict);
    assert.equal(JSON.parse(noReport.out).plan[0].datesFromRun, true);
  } finally { s.server.close(); }
});

const tokenless = (s) => ({ ...env(s), EOFFICE_ACCESS_TOKEN: '', ...sess });
const viaSessionNoToken = (s, file, extra = {}) => run(
  ['create', '--apply', '--allow-production', '--confirm-host', s.host, '--via', 'session', file], { ...tokenless(s), ...extra },
);

test('without a token, --via session creates and reports using only the browser session', async () => {
  const s = await startServer();
  try {
    const r = await viaSessionNoToken(s, batchFile(['Task one'], { rulesOverride: sessionRules }));
    assert.equal(r.code, 0, r.err);
    const [result] = lastLine(r.out);
    assert.equal(result.submitted, true);
    assert.equal(result.status, 'REVIEW');
    assert.equal(result.report, 'progress-report');
    assert.equal(s.apiHits.length, 0);
    assert.equal(s.reports.length, 1);
  } finally { s.server.close(); }
});

test('without a token, a rerun finds the existing task in the session list and skips it', async () => {
  const s = await startServer();
  try {
    const file = batchFile(['Task one'], { rulesOverride: sessionRules });
    await viaSessionNoToken(s, file);
    const dry = await run(['create', '--dry-run', '--via', 'session', file], tokenless(s));
    assert.equal(dry.code, 0, dry.err);
    assert.equal(JSON.parse(dry.out).plan[0].duplicate.title, '[One Nova] - BE - [BE] Task one');
    const again = await viaSessionNoToken(s, file);
    assert.equal(lastLine(again.out)[0].skipped, 'already exists');
    assert.equal(s.adds.length, 1);
    assert.equal(s.apiHits.length, 0);
  } finally { s.server.close(); }
});

test('without a token, owners the server dropped are caught through the edit form', async () => {
  const s = await startServer();
  try {
    s.flags.dropOwnersOnAdd = true;
    const r = await viaSessionNoToken(s, batchFile(['One', 'Two'], { rulesOverride: sessionRules }));
    assert.equal(r.code, 1);
    const [first, second] = lastLine(r.out);
    assert.match(first.error, /^people not resolved: owner$/);
    assert.match(second.skipped, /batch stopped/);
    assert.equal(s.reports.length, 0);
    assert.equal(s.apiHits.length, 0);
  } finally { s.server.close(); }
});

test('without a token or a session, create exits 2 and says what is needed', async () => {
  const s = await startServer();
  try {
    const r = await run(['create', '--dry-run', batchFile(['Task one'], { rulesOverride: sessionRules })], { ...env(s), EOFFICE_ACCESS_TOKEN: '' });
    assert.equal(r.code, 2);
    assert.match(r.err, /EOFFICE_ACCESS_TOKEN or a browser session/);
  } finally { s.server.close(); }
});

test('without a token, tasks that finish with a status update are refused before anything is created', async () => {
  const s = await startServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'eoffice-write-'));
    const file = join(dir, 'batch.json');
    writeFileSync(file, JSON.stringify({
      rules: sessionRules, project: { ref: '1456', id: '3869' },
      settings: { parent: 2089469, owner: 'Owner Name', assignees: ['Owner Name'], followers: [] },
      tasks: [{ summary: 'Parent', startPlan: '2026-10-06', endPlan: '2026-10-09', children: [{ summary: 'Child', startPlan: '2026-10-06', endPlan: '2026-10-07' }] }],
    }));
    const withChildren = await viaSessionNoToken(s, file);
    assert.equal(withChildren.code, 2);
    assert.match(withChildren.err, /needs EOFFICE_ACCESS_TOKEN/);
    const noReport = await viaSessionNoToken(s, batchFile(['Task one'], { rulesOverride: sessionRules }), {});
    assert.equal(noReport.code, 0, noReport.err);
    const flagged = await run(['create', '--apply', '--allow-production', '--confirm-host', s.host, '--via', 'session', '--no-report',
      batchFile(['Task two'], { rulesOverride: sessionRules })], tokenless(s));
    assert.equal(flagged.code, 2);
    assert.equal(s.adds.length, 1);
  } finally { s.server.close(); }
});

test('commands that only the token can serve fail with exit 2 when it is missing', async () => {
  const s = await startServer();
  try {
    seed(s);
    for (const args of [['get', '--ids', '5000'], ['delete', '--dry-run', '--project-id', '3869', '--ids', '5000']]) {
      const r = await run(args, { ...env(s), EOFFICE_ACCESS_TOKEN: '' });
      assert.equal(r.code, 2, args[0]);
      assert.match(r.err, /EOFFICE_ACCESS_TOKEN/);
    }
  } finally { s.server.close(); }
});

const readOnlySession = (s) => ({ ...env(s), EOFFICE_ACCESS_TOKEN: '', ...sess });

test('get without a token reads the task list through the session', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    const r = await run(['get', '--ids', '5000,424242'], readOnlySession(s));
    assert.equal(r.code, 1);
    const [found, missing] = JSON.parse(r.out);
    assert.equal(found.found, true);
    assert.equal(found.title, 'Seeded task');
    assert.equal(found.startPlan, '2026-10-06');
    assert.equal(found.start, '2026-10-19');
    assert.equal(found.owner, '7001');
    assert.equal(missing.found, false);
    assert.equal(s.apiHits.length, 0);
  } finally { s.server.close(); }
});

test('get without a token or a session exits 2 and says what is needed', async () => {
  const s = await startServer();
  try {
    const r = await run(['get', '--ids', '5000'], { ...env(s), EOFFICE_ACCESS_TOKEN: '' });
    assert.equal(r.code, 2);
    assert.match(r.err, /EOFFICE_ACCESS_TOKEN or a browser session/);
  } finally { s.server.close(); }
});

test('with a token, get keeps using the API even when a session is present', async () => {
  const s = await startServer();
  try {
    seed(s);
    const r = await run(['get', '--ids', '5000'], { ...env(s), ...sess });
    assert.equal(r.code, 0, r.err);
    assert.ok(s.apiHits.length > 0);
  } finally { s.server.close(); }
});

test('set-dates without a token reads, writes and confirms through the session only', async () => {
  const s = await startServer();
  try {
    seed(s, { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:00' });
    const dry = await run(['set-dates', '--dry-run', '--project-id', '3869', '--ids', '5000', '--actual-from-plan'], readOnlySession(s));
    assert.equal(dry.code, 0, dry.err);
    assert.equal(JSON.parse(dry.out)[0].result, 'would update');
    const applied = await run(['set-dates', '--apply', '--confirm-host', s.host, '--allow-production', '--project-id', '3869', '--ids', '5000', '--actual-from-plan'], readOnlySession(s));
    assert.equal(applied.code, 0, applied.err);
    assert.equal(JSON.parse(applied.out)[0].result, 'updated');
    assert.equal(s.apiHits.length, 0);
  } finally { s.server.close(); }
});

test('search-parent without a token searches the session task list', async () => {
  const s = await startServer();
  try {
    seed(s, { created_by_id: 8990, title: 'OneNova Parent Alpha' });
    const r = await run(['search-parent', '--project-id', '3869', '--search', 'Alpha'], readOnlySession(s));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).map((row) => row.id), [5000]);
    assert.equal(s.apiHits.length, 0);
  } finally { s.server.close(); }
});
