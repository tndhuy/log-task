import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionClient, parseTaskRows } from '../../../skills/log-task/scripts/lib/eoffice-session.mjs';

const COOKIE = 'sess=secret-cookie';
const reply = (handler) => async (url) => {
  const { status = 200, body, headers = {} } = handler(new URL(url));
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
};
const csrfThen = (final) => reply((url) => (url.pathname === '/integration-document'
  ? { headers: { 'csrf-token-cache': 'csrf-token-0123456789' }, body: '<html></html>' }
  : final(url)));

test('a report refused because the start is after the report date explains what to fix', async () => {
  const client = createSessionClient({
    baseUrl: 'https://eoffice.example.vn', cookie: COOKIE,
    fetchImpl: csrfThen(() => ({ body: { message: 'Ngày bắt đầu không được lớn hơn ngày kết thúc' } })),
  });
  await assert.rejects(
    () => client.reportProgress({ taskId: 1, date: '2026-10-09', note: 'n' }),
    (e) => e.code === 'report' && /actual start is after the report date/.test(e.message) && !e.message.includes(COOKIE),
  );
});

test('parseTaskRows reads values, dd/mm/YYYY dates and the parent id from list markup', () => {
  const text = `<elem data-props='{"rows":[{"view":"list","ID":7,"vals":{"title":"A &amp; B","owner_ids":"1,2","assign_ids":"3","status":"REVIEW","percent":100,"start_plan":"09/10/2026","start":"","end_plan":"10/10/2026","end":"10/10/2026"},"fields":{"title":"<a class=table-sub-title href=/work-normal-normal/view?ID=55>P</a>"}}]}'></elem>`;
  assert.deepEqual(parseTaskRows(text), [{
    id: 7, title: 'A & B', parentId: 55, owner_ids: '1,2', assign_ids: '3', status: 'REVIEW', percent: 100,
    start_plan: '2026-10-09', end_plan: '2026-10-10', start: null, end: '2026-10-10',
  }]);
});
