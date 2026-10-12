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
const UPDATE = '/api/work/normal/update';

export function createClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  if (!baseUrl) throw new EofficeApiError('EOFFICE_BASE_URL is not set', { code: 'missing_env' });
  if (!token) throw new EofficeApiError('EOFFICE_ACCESS_TOKEN is not set', { code: 'missing_env' });
  let host;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new EofficeApiError('EOFFICE_BASE_URL is not a valid URL (include https://)', { code: 'missing_env' });
  }
  const scrub = (value) => String(value).split(token).join('<token>')
    .split(encodeURIComponent(token)).join('<token>');

  async function call(method, path, params = {}) {
    const url = new URL(path, baseUrl);
    url.searchParams.set('access_token', token);
    const init = { method, redirect: 'error' };
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
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new EofficeApiError(`Unexpected response body from ${host}`, { code: 'bad_body', status: res.status });
    }
    if (body.error === true) {
      throw new EofficeApiError(scrub(body.message || body.code || 'API error'), {
        code: String(body.code ?? 'api_error'), status: res.status,
      });
    }
    if (!res.ok) {
      throw new EofficeApiError(`HTTP ${res.status} from ${host}`, { code: 'http', status: res.status });
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
  if (body.data !== undefined && !Array.isArray(body.data)) {
    throw new EofficeApiError(`Unexpected response body from ${client.host}`, { code: 'bad_body' });
  }
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

export async function readTask(client, { title, parentId }) {
  const rows = await gets(client, { s: title, parent_id: String(parentId) }, 100);
  const hit = rows.find((row) => row.title === title);
  return hit ? { id: hit.ID, title: hit.title, status: hit.status, percent: hit.percent } : null;
}

export function updateTask(client, { id, status }) {
  return client.call('POST', UPDATE, { ID: String(id), status });
}

export function insertTask(client, payload) {
  return client.call('POST', INSERT, payload);
}
