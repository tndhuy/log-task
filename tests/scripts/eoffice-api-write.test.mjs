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
      const row = { ID: nextId++, title: form.title, parent_id: form.parent_id, project_id: 3869, status: 'PENDING', percent: 0 };
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
  return { server, tasks, posts, updates, reports, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
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
