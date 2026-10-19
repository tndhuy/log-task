import { EofficeApiError } from './eoffice-api.mjs';
import { toApiDate } from './eoffice-rules.mjs';

const RELOAD = '/integration-document?_json=1&reloadCsrfToken=1&inlineLogin=1';
const PROGRESS = '/work-task-task/progress?_json=1';
const REALTIME = '/work-task-task/realtime?_json=1';
const ADD = '/work-task-task/add?_json=1';

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
      throw new EofficeApiError(`Progress report refused: ${(body?.message ?? text).slice(0, 120)}`, { code: 'report' });
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
      const hint = /permission|quyền/i.test(message) ? " (the date route needs the owner of the task; being its creator is not enough)" : '';
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

  return { reportProgress, updateDates, addTask };
}
