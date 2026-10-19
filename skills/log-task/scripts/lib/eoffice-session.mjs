import { EofficeApiError } from './eoffice-api.mjs';
import { toApiDate } from './eoffice-rules.mjs';

const RELOAD = '/integration-document?_json=1&reloadCsrfToken=1&inlineLogin=1';
const PROGRESS = '/work-task-task/progress?_json=1';
const REALTIME = '/work-task-task/realtime?_json=1';
const ADD = '/work-task-task/add?_json=1';
const LIST = '/work-normal-normal';
const LIST_PAGES = 6;

// Raw defaults of the UI "create task" form; the flag values are the form's own, not the API's display strings.
const ADD_FORM_DEFAULTS = {
  progress_type: 'PERCENT', priority: '17', assign_other_off: '0', follower_not_view: '0', assign_parent_off: '0',
  follower_other_not_view: '0', status_after_report: 'REVIEW', no_allow_file_on_success: 'no',
  proportion_auto_completed: '0', progress_required_desc: 'yes', progress_required_file: 'no',
};

/**
 * Performs the actions the integration API cannot: the progress-report record and the
 * date edit that corrects actual dates. Both use the UI endpoint with a browser session cookie plus a CSRF token that the
 * server returns in the `csrf-token-cache` response header.
 */
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#39;': "'" };
const decode = (text) => String(text ?? '').replace(/&(?:amp|lt|gt|quot|#0?39);/g, (entity) => ENTITIES[entity]);
const isoFromUi = (value) => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? '');
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};

// The list page is server-driven markup with the row data embedded as JSON; this reads that JSON only.
export function parseTaskRows(text) {
  const starts = [...text.matchAll(/\{"view":"list","ID":(\d+),"vals":\{/g)];
  return starts.map((match, index) => {
    const valsStart = match.index + match[0].length - 1;
    let depth = 0;
    let end = valsStart;
    for (; end < text.length; end += 1) {
      if (text[end] === '{') depth += 1;
      if (text[end] === '}' && (depth -= 1) === 0) break;
    }
    const vals = JSON.parse(text.slice(valsStart, end + 1));
    const segment = text.slice(end, starts[index + 1]?.index ?? text.length);
    const parent = /table-sub-title[^]{0,40}?view\?ID=(\d+)/.exec(segment)?.[1];
    return {
      id: Number(match[1]),
      title: decode(vals.title),
      parentId: parent === undefined ? null : Number(parent),
      owner_ids: vals.owner_ids ?? '',
      assign_ids: vals.assign_ids ?? '',
      status: vals.status,
      percent: vals.percent,
      start_plan: isoFromUi(vals.start_plan),
      end_plan: isoFromUi(vals.end_plan),
      start: isoFromUi(vals.start),
      end: isoFromUi(vals.end),
    };
  });
}

export function createSessionClient({ baseUrl, cookie, fetchImpl = globalThis.fetch }) {
  if (!cookie) throw new EofficeApiError('EOFFICE_SESSION_COOKIE is not set', { code: 'missing_env' });
  const origin = new URL(baseUrl).origin;
  const scrub = (value) => String(value).split(cookie).join('<cookie>');
  const base = {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest',
    cookie,
  };

  async function send(path, init) {
    try {
      return await fetchImpl(new URL(path, origin), { redirect: 'manual', ...init });
    } catch (err) {
      throw new EofficeApiError(scrub(`Session request failed: ${err.message}`), { code: 'network' });
    }
  }

  async function freshCsrf() {
    const res = await send(RELOAD, {
      headers: { ...base, referer: `${origin}/integration-document` },
    });
    const csrf = res.headers.get('csrf-token-cache');
    if (res.status !== 200 || !csrf) {
      throw new EofficeApiError('Session rejected: cookie expired or no CSRF token', { code: 'session' });
    }
    return csrf;
  }

  async function reportProgress({ taskId, date, percent = 100, note }) {
    const csrf = await freshCsrf();
    const form = new FormData();
    const fields = [
      ['form_plus', '1'], ['ID', String(taskId)], ['items[1][is_history]', '0'],
      ['items[1][date_report]', toApiDate(date)], ['items[1][percent]', String(percent)],
      ['items[1][progress_note]', note], ['items[1][id_attachments]', ''],
      ['items[1][attachment_report]', ''], ['inlineLogin', '1'],
      ['_cacheApplyStyletask_form_plus', '1.0'],
    ];
    for (const [key, value] of fields) form.append(key, value);
    const res = await send(PROGRESS, {
      method: 'POST',
      body: form,
      headers: { ...base, origin, referer: `${origin}/work-normal-normal`, 'csrf-token-cache': csrf },
    });
    const text = scrub(await res.text()).split(csrf).join('<csrf>');
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (res.status !== 200 || !body || body.error || !body.notice) {
      const message = (body?.message ?? text).slice(0, 120);
      const hint = /Ngày bắt đầu không được lớn hơn ngày kết thúc/.test(message)
        ? ' (the actual start is after the report date; correct the actual start first)' : '';
      throw new EofficeApiError(`Progress report refused: ${message}${hint}`, { code: 'report' });
    }
  }

  // Every date is sent together: an update that omits a date can clear it (seen with the API's update).
  async function updateDates({ taskId, startPlan, endPlan, start, end }) {
    const csrf = await freshCsrf();
    const form = new FormData();
    form.append('ID', String(taskId));
    for (const [key, value] of [['start_plan', startPlan], ['end_plan', endPlan], ['start', start], ['end', end]]) {
      if (value) form.append(key, toApiDate(value));
    }
    form.append('inlineLogin', '1');
    const res = await send(REALTIME, {
      method: 'POST',
      body: form,
      headers: { ...base, origin, referer: `${origin}/work-normal-normal/view?ID=${taskId}`, 'csrf-token-cache': csrf },
    });
    const text = scrub(await res.text()).split(csrf).join('<csrf>');
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    // A refusal answers with only a message; success carries a notice or close flag. The caller still verifies by read-back.
    const refused = body?.error || (body?.message && !body.notice && !body.close);
    if (res.status !== 200 || refused) {
      const message = (body?.message ?? text).slice(0, 120);
      const hint = /permission|quyền/i.test(message) ? " (once a task is in REVIEW only an owner of the task may edit its dates)" : '';
      throw new EofficeApiError(`Date update refused: ${message}${hint}`, { code: 'dates' });
    }
  }

  // People are numeric user IDs and dates are dd/mm/YYYY. A task made here belongs to the signed-in user
  // (the integration API makes the creator the API account) and starts in DOING.
  async function addTask({
    title, projectId, parentId, startPlan, endPlan, ownerIds, assigneeIds, followerIds = [],
  }) {
    const csrf = await freshCsrf();
    const form = new FormData();
    form.append('title', title);
    form.append('project_id', String(projectId));
    form.append('parent_id', String(parentId));
    if (startPlan) form.append('start_plan', startPlan);
    if (endPlan) form.append('end_plan', endPlan);
    for (const [field, ids] of [['owner_ids[]', ownerIds], ['assign_ids[]', assigneeIds], ['follower_ids[]', followerIds]]) {
      for (const id of ids) form.append(field, String(id));
    }
    for (const [key, value] of Object.entries(ADD_FORM_DEFAULTS)) form.append(key, value);
    form.append('inlineLogin', '1');
    const res = await send(ADD, {
      method: 'POST',
      body: form,
      headers: { ...base, origin, referer: `${origin}/work-task-task/add`, 'csrf-token-cache': csrf },
    });
    const text = scrub(await res.text()).split(csrf).join('<csrf>');
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (res.status !== 200 || !body || body.error || !body.notice) {
      throw new EofficeApiError(`Task creation refused: ${(body?.message ?? text).slice(0, 120)}`, { code: 'session_add' });
    }
    const id = /ID=(\d+)/.exec(body.redirect ?? '')?.[1];
    if (!id) throw new EofficeApiError('Task created but the response carries no ID', { code: 'no_id' });
    return Number(id);
  }

  async function getText(path, referer) {
    const res = await send(path, { headers: { ...base, referer: `${origin}${referer}` } });
    return { status: res.status, text: scrub(await res.text()) };
  }

  // The list search box sends `s=<text>` and only takes effect with an explicit tab; all_all covers every task the
  // user can see, so a duplicate made by anyone is found.
  async function listTasks({ search, ids, tab = 'all_all' } = {}) {
    const rows = [];
    for (let page = 1; page <= LIST_PAGES; page += 1) {
      const query = new URLSearchParams({ v: 'list', tab, _json: '1' });
      if (search) query.set('s', search);
      if (ids) query.set('ids', ids.join(','));
      if (page > 1) query.set('p', String(page));
      const { status, text } = await getText(`${LIST}?${query}`, LIST);
      if (status !== 200) throw new EofficeApiError(`Task list refused (HTTP ${status})`, { code: 'session' });
      const batch = parseTaskRows(text);
      rows.push(...batch);
      const range = Number(/"page":\{"total":\d+,"current":\d+,"range":(\d+)/.exec(text)?.[1] ?? 50);
      if (batch.length < range) break;
    }
    return rows;
  }

  // `ids=1,2,3` filters the list to those tasks; unknown ids are simply absent from the answer.
  const getTasksByIds = async (ids) => new Map((await listTasks({ ids })).map((row) => [row.id, row]));

  const findByTitle = async ({ title, parentId }) => (
    (await listTasks({ search: title })).find((row) => row.title === title && String(row.parentId) === String(parentId)) ?? null
  );

  // Status, percent and actual end come from the detail page; people come from the edit form, which only opens while
  // the task is still DOING, so call this with people:true right after creating it.
  async function readTask({ id, people = false }) {
    const view = await getText(`${LIST}/view?ID=${id}&_json=1`, LIST);
    const row = /"rows":\[\{"view":"view","ID":(\d+),"status":"([A-Z_]+)","end":(null|"[^"]*"),"percent":(\d+)/.exec(view.text);
    if (!row) return null;
    const task = { id: Number(row[1]), status: row[2], end: row[3] === 'null' ? null : row[3].slice(1, 11), percent: Number(row[4]) };
    if (people) {
      const edit = await getText(`/work-task-task/edit?ID=${id}&_json=1`, LIST);
      task.owner_ids = /"owner_ids":"([\d,]*)","all_owner_ids"/.exec(edit.text)?.[1];
      task.assign_ids = /"assign_ids":"([\d,]*)","all_assign_ids"/.exec(edit.text)?.[1];
      if (task.owner_ids === undefined || task.assign_ids === undefined) {
        throw new EofficeApiError('Cannot read the people of the new task from the edit form', { code: 'session_read' });
      }
    }
    return task;
  }

  return { reportProgress, updateDates, addTask, listTasks, getTasksByIds, findByTitle, readTask };
}
