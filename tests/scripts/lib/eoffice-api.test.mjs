import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EofficeApiError, createClient, findParents, findDuplicate, getItem, insertTask, isUatHost, taskLink,
} from '../../../skills/log-task/scripts/lib/eoffice-api.mjs';

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

test('every call refuses redirects', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { error: false, data: [] } }));
  const c = createClient({ baseUrl: 'https://eoffice-uat.example.vn', token: TOKEN, fetchImpl });
  await c.call('GET', '/x');
  await c.call('POST', '/y', { a: 1 });
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
  assert.equal(fetchImpl.calls[1].init.redirect, 'error');
});

test('a 4xx carrying error:true keeps the API code', async () => {
  const c = client(() => ({ status: 403, body: { error: true, code: 'not object', message: 'accesstoken not of object' } }));
  await assert.rejects(() => c.call('GET', '/x'),
    (e) => e.code === 'not object' && e.status === 403);
});

test('a non-ok response without error:true stays http', async () => {
  await assert.rejects(() => client(() => ({ status: 500, body: {} })).call('GET', '/x'),
    (e) => e.code === 'http');
});

test('a null or non-object body is bad_body', async () => {
  for (const body of ['null', '[]', '5']) {
    await assert.rejects(() => client(() => ({ body })).call('GET', '/x'),
      (e) => e instanceof EofficeApiError && e.code === 'bad_body' && e.message.includes('eoffice-uat.example.vn'));
  }
});

test('a non-array data field is bad_body', async () => {
  const c = client(() => ({ body: { error: false, data: {} } }));
  await assert.rejects(() => findParents(c, { projectId: '1', search: 's' }),
    (e) => e instanceof EofficeApiError && e.code === 'bad_body');
});

test('isUatHost matches the allowlist exactly, not lookalike hosts', () => {
  assert.equal(isUatHost('eoffice-uat.novagroup.vn', ''), true);
  for (const host of ['eoffice.novagroup.vn', 'prod-uat.corp.com', 'eoffice.uat.attacker.com', 'uat-eoffice-prod.company.com', 'eoffice-uat.novagroup.vn.evil.com']) {
    assert.equal(isUatHost(host, ''), false, host);
  }
});

test('isUatHost honors a comma-separated override and ignores the default then', () => {
  assert.equal(isUatHost('a.test', 'a.test, b.test'), true);
  assert.equal(isUatHost('eoffice-uat.novagroup.vn', 'a.test'), false);
});

test('getItem returns the task data and asks for raw values only on request', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { error: false, data: { ID: 7, title: 'T' } } }));
  const c = createClient({ baseUrl: 'https://eoffice-uat.example.vn', token: TOKEN, fetchImpl });
  assert.deepEqual(await getItem(c, { id: 7 }), { ID: 7, title: 'T' });
  assert.equal(fetchImpl.calls[0].url.pathname, '/api/work/normal/item');
  assert.equal(fetchImpl.calls[0].url.searchParams.get('ID'), '7');
  assert.equal(fetchImpl.calls[0].url.searchParams.has('field_raws'), false);
  await getItem(c, { id: 7, raw: true });
  assert.equal(fetchImpl.calls[1].url.searchParams.get('field_raws'), 'allfield');
});

test('getItem returns null for "Post not found"', async () => {
  const c = client(() => ({ body: { error: true, message: 'Post not found' } }));
  assert.equal(await getItem(c, { id: 1 }), null);
});

test('getItem lets every other API error through without the token', async () => {
  const c = client(() => ({ body: { error: true, code: 'not object', message: `no ${TOKEN}` } }));
  await assert.rejects(
    () => getItem(c, { id: 1 }),
    (e) => e instanceof EofficeApiError && e.code === 'not object' && !e.message.includes(TOKEN),
  );
});

test('getItem rejects a body without a data object', async () => {
  const c = client(() => ({ body: { error: false } }));
  await assert.rejects(() => getItem(c, { id: 1 }), (e) => e.code === 'bad_body');
});

test('taskLink fills {origin} and {id}, and is undefined without a template', () => {
  const baseUrl = 'https://eoffice.novagroup.vn/some/path';
  const template = '{origin}/work-normal-normal/view?ID={id}';
  assert.equal(taskLink(2133680, { baseUrl, template }), 'https://eoffice.novagroup.vn/work-normal-normal/view?ID=2133680');
  assert.equal(taskLink(1, { baseUrl, template: '' }), undefined);
  assert.equal(taskLink(1, { baseUrl, template: undefined }), undefined);
});
