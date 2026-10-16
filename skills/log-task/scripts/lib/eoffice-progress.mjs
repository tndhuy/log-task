import { EofficeApiError } from './eoffice-api.mjs';
import { toApiDate } from './eoffice-rules.mjs';

const RELOAD = '/integration-document?_json=1&reloadCsrfToken=1&inlineLogin=1';
const PROGRESS = '/work-task-task/progress?_json=1';

/**
 * Creates the progress-report record, which the integration API cannot do.
 * Uses the UI endpoint with a browser session cookie plus a CSRF token that the
 * server returns in the `csrf-token-cache` response header.
 */
export function createProgressClient({ baseUrl, cookie, fetchImpl = globalThis.fetch }) {
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

  return { reportProgress };
}
