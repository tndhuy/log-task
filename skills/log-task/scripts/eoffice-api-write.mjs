#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, flag } from './lib/cli-args.mjs';
import { resolveDataDir } from './lib/data-dir.mjs';
import { loadDefaultEnv } from './lib/env-file.mjs';
import {
  EofficeApiError, createClient, createOfflineClient, deleteTask, findDuplicate, findParents, getItem, insertTask, isUatHost, readTask, taskLink, updateTask,
} from './lib/eoffice-api.mjs';
import { createSessionClient } from './lib/eoffice-session.mjs';
import {
  RulesError, STATUS_DISPLAY, buildInsertPayload, toApiDate, toUserIds, validateRules,
} from './lib/eoffice-rules.mjs';

const USAGE = `Usage:
  eoffice-api-write.mjs search-parent --project-id <rawId> --search <text>
  eoffice-api-write.mjs get --ids <id>[,<id>...] [--raw]
  eoffice-api-write.mjs delete --dry-run --project-id <rawId> --ids <id>[,<id>...]
  eoffice-api-write.mjs delete --apply --confirm-host <host> [--allow-production] [--allow-foreign] --project-id <rawId> --ids <id>[,<id>...]
  eoffice-api-write.mjs set-dates --dry-run --project-id <rawId> --ids <id>[,<id>...] (--actual-from-plan | [--start d] [--end d] [--start-plan d] [--end-plan d])
  eoffice-api-write.mjs set-dates --apply --confirm-host <host> [--allow-production] [--session-from chrome|brave] --project-id <rawId> --ids ... (same date options)
  eoffice-api-write.mjs create --dry-run <batch.json>
  eoffice-api-write.mjs create --apply --confirm-host <host> [--allow-production] [--via api|session] [--no-report] [--session-from chrome|brave] <batch.json>`;

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
  for (const task of batch.tasks) {
    if (task.children !== undefined && !Array.isArray(task.children)) {
      throw new UsageError(`tasks[].children must be an array ("${task.summary}")`);
    }
    if (task.children?.some((child) => child.children !== undefined)) {
      throw new UsageError(`Only one level of children is supported ("${task.summary}" has nested children)`);
    }
  }
  applyFixedRules(batch);
  if (!batch.settings?.parent) throw new UsageError('batch.settings.parent is required');
  return batch;
}

function applyFixedRules(batch) {
  const settings = { ...batch.settings };
  for (const key of ['parent', 'owner', 'assignees', 'followers']) {
    const rule = batch.rules[key];
    if (rule?.mode === 'fixed' && settings[key] === undefined) settings[key] = rule.value;
  }
  batch.settings = settings;
}

async function cookieFromBrowser(browser, host) {
  const { importCookies, domainsFor, cookieHeader } = await import('./lib/cookie-import.mjs');
  const { cookies } = importCookies(domainsFor(host), 'Default', browser);
  if (cookies.length === 0) {
    throw new UsageError(`No ${browser} cookies for ${host}: sign in to eOffice in ${browser} first`);
  }
  return cookieHeader(cookies);
}

const HALTED_MESSAGE = 'batch stopped: people not resolved';
const idCount = (value) => String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).length;

// The server drops people it cannot resolve and still answers error:false, so compare the stored IDs.
function unresolvedPeople(payload, stored) {
  return [['owner_ids', 'owner'], ['assign_ids', 'assignees']]
    .filter(([field]) => payload[field] && idCount(stored?.[field]) < idCount(payload[field]))
    .map(([, label]) => label);
}

const HINT_TEMPLATE = 'hint: set EOFFICE_TASK_URL_TEMPLATE (for example {origin}/work-normal-normal/view?ID={id}) to include task links';

function makeLinker(env) {
  let hinted = false;
  return (id) => {
    const link = taskLink(id, { baseUrl: env.EOFFICE_BASE_URL, template: env.EOFFICE_TASK_URL_TEMPLATE });
    if (link === undefined && !hinted) {
      hinted = true;
      console.error(HINT_TEMPLATE);
    }
    return link;
  };
}

function parseIds(args) {
  const ids = flag(args, '--ids', { required: true }).split(',').map((entry) => entry.trim());
  if (ids.some((entry) => !/^\d+$/.test(entry))) throw new UsageError('--ids needs comma-separated numeric task IDs');
  return [...new Set(ids)];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

function assertApplyAllowed(args, client, env) {
  if (flag(args, '--confirm-host') !== client.host) {
    throw new UsageError(`--apply needs --confirm-host ${client.host}`);
  }
  if (!isUatHost(client.host, env.EOFFICE_UAT_HOSTS) && !args.includes('--allow-production')) {
    throw new UsageError(`${client.host} is not in the UAT allowlist (EOFFICE_UAT_HOSTS): refused. --allow-production may be added only when the user states in this run that the UAT checklist is complete`);
  }
}

const orUndefined = (value) => (value === null || value === '' ? undefined : value);

async function runGet(client, args, env) {
  const raw = args.includes('--raw');
  const linkFor = makeLinker(env);
  const rows = [];
  for (const id of parseIds(args)) {
    const data = await getItem(client, { id, raw });
    const link = linkFor(id);
    rows.push(data ? {
      id: Number(id), found: true, title: data.title, status: data.status, percent: data.percent,
      startPlan: data.start_plan, endPlan: data.end_plan, start: data.start, end: data.end,
      owner: orUndefined(data.owner_ids), assignees: orUndefined(data.assign_ids),
      creator: data.created_by_id, parentId: data.parent_id, link,
    } : { id: Number(id), found: false, link });
  }
  console.log(JSON.stringify(rows, null, 2));
  return rows.every((row) => row.found) ? 0 : 1;
}

const API_ACCOUNT_ID = 1;

const isoDate = (value) => {
  const day = value ? String(value).slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !day.startsWith('0000') ? day : null;
};

function dateTargets(args, current) {
  const given = {
    start: flag(args, '--start'), end: flag(args, '--end'),
    startPlan: flag(args, '--start-plan'), endPlan: flag(args, '--end-plan'),
  };
  const fromPlan = args.includes('--actual-from-plan');
  const anyGiven = Object.values(given).some((value) => value !== undefined);
  if (fromPlan === anyGiven) {
    throw new UsageError('set-dates needs --actual-from-plan or at least one of --start --end --start-plan --end-plan, not both');
  }
  for (const value of Object.values(given)) if (value !== undefined) toApiDate(value);
  const target = fromPlan
    ? { ...current, start: current.startPlan, end: current.endPlan }
    : { ...current, ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) };
  return target;
}

async function runSetDates(client, args, env) {
  const apply = args.includes('--apply');
  if (apply === args.includes('--dry-run')) throw new UsageError('set-dates needs exactly one of --dry-run or --apply');
  const projectId = flag(args, '--project-id') ?? env.EOFFICE_PROJECT_ID;
  if (!projectId) throw new UsageError('set-dates needs --project-id <raw project id> or EOFFICE_PROJECT_ID');
  if (apply) assertApplyAllowed(args, client, env);
  const sessionFrom = flag(args, '--session-from');
  if (sessionFrom !== undefined && !['chrome', 'brave'].includes(sessionFrom)) throw new UsageError('--session-from must be chrome or brave');
  if (sessionFrom !== undefined && !apply) throw new UsageError('--session-from only applies to --apply');
  const linkFor = makeLinker(env);

  const rows = [];
  for (const id of parseIds(args)) {
    const data = await getItem(client, { id, raw: true });
    const row = { id: Number(id), title: data?.title, link: linkFor(id) };
    if (!data) rows.push({ ...row, result: 'absent' });
    else if (String(data.project_id) !== String(projectId)) {
      rows.push({ ...row, result: 'refused', reason: `project_id ${data.project_id} is not ${projectId}` });
    } else {
      const before = {
        startPlan: isoDate(data.start_plan), endPlan: isoDate(data.end_plan), start: isoDate(data.start), end: isoDate(data.end),
      };
      const after = dateTargets(args, before);
      const same = Object.keys(before).every((key) => before[key] === after[key]);
      rows.push({ ...row, before, after, result: same ? 'unchanged' : (apply ? 'pending' : 'would update') });
    }
  }
  const blocked = rows.some((row) => row.result === 'absent' || row.result === 'refused');
  if (!apply || blocked || !rows.some((row) => row.result === 'pending')) {
    console.log(JSON.stringify(rows, null, 2));
    return blocked ? (apply ? 2 : 1) : 0;
  }

  const cookie = env.EOFFICE_SESSION_COOKIE || (sessionFrom ? await cookieFromBrowser(sessionFrom, client.host) : '');
  if (!cookie) throw new UsageError('set-dates --apply needs a browser session: pass --session-from brave|chrome or set EOFFICE_SESSION_COOKIE');
  const session = createSessionClient({ baseUrl: env.EOFFICE_BASE_URL, cookie });
  const settleMs = Number(env.EOFFICE_SETTLE_MS ?? 3000);
  let failed = false;
  for (const row of rows.filter((entry) => entry.result === 'pending')) {
    if (failed) {
      row.result = 'not attempted';
      continue;
    }
    try {
      await session.updateDates({ taskId: row.id, ...row.after });
      await sleep(settleMs);
      const data = await getItem(client, { id: row.id, raw: true });
      const actual = {
        startPlan: isoDate(data?.start_plan), endPlan: isoDate(data?.end_plan), start: isoDate(data?.start), end: isoDate(data?.end),
      };
      const matches = Object.keys(row.after).every((key) => !row.after[key] || row.after[key] === actual[key]);
      row.result = matches ? 'updated' : 'mismatch';
      if (!matches) row.actual = actual;
    } catch (err) {
      row.result = 'error';
      row.error = firstLine(err);
    }
    failed = row.result !== 'updated';
  }
  console.log(JSON.stringify(rows, null, 2));
  return rows.some((row) => ['mismatch', 'error', 'not attempted'].includes(row.result)) ? 1 : 0;
}

function classify(data, { projectId, allowForeign }) {
  if (!data) return { result: 'absent' };
  if (String(data.project_id) !== String(projectId)) {
    return { result: 'refused', reason: `project_id ${data.project_id} is not ${projectId}` };
  }
  if (Number(data.created_by_id) !== API_ACCOUNT_ID && !allowForeign) {
    return { result: 'refused', reason: `created_by_id ${data.created_by_id} is not the API account; --allow-foreign overrides` };
  }
  return { result: 'deletable' };
}

async function runDelete(client, args, env) {
  const apply = args.includes('--apply');
  if (apply === args.includes('--dry-run')) throw new UsageError('delete needs exactly one of --dry-run or --apply');
  const projectId = flag(args, '--project-id') ?? env.EOFFICE_PROJECT_ID;
  if (!projectId) throw new UsageError('delete needs --project-id <raw project id> or EOFFICE_PROJECT_ID');
  if (apply) assertApplyAllowed(args, client, env);
  const ids = parseIds(args);
  const allowForeign = args.includes('--allow-foreign');
  const linkFor = makeLinker(env);

  const rows = [];
  for (const id of ids) {
    const data = await getItem(client, { id, raw: true });
    rows.push({ id: Number(id), title: data?.title, link: linkFor(id), ...classify(data, { projectId, allowForeign }) });
  }
  const refused = rows.some((row) => row.result === 'refused');
  if (!apply || refused) {
    console.log(JSON.stringify(rows, null, 2));
    return refused ? (apply ? 2 : 1) : 0;
  }

  const settleMs = Number(env.EOFFICE_SETTLE_MS ?? 3000);
  let stopped = false;
  for (const row of rows.filter((entry) => entry.result === 'deletable')) {
    if (stopped) {
      row.reason = 'not attempted: an earlier delete is still present';
      continue;
    }
    try {
      await deleteTask(client, { id: row.id });
      await sleep(settleMs);
      row.result = (await getItem(client, { id: row.id, raw: true })) ? 'still present' : 'deleted';
    } catch (err) {
      row.result = 'still present';
      row.error = firstLine(err);
    }
    if (row.result === 'still present') stopped = true;
  }
  console.log(JSON.stringify(rows, null, 2));
  return rows.some((row) => row.result === 'still present') ? 1 : 0;
}

async function main(argv, env) {
  const [command, ...args] = argv;
  if (!['search-parent', 'create', 'get', 'delete', 'set-dates'].includes(command)) throw new UsageError(USAGE);
  const hasToken = Boolean(env.EOFFICE_ACCESS_TOKEN);
  const client = hasToken
    ? createClient({ baseUrl: env.EOFFICE_BASE_URL, token: env.EOFFICE_ACCESS_TOKEN })
    : createOfflineClient({ baseUrl: env.EOFFICE_BASE_URL });

  if (command === 'search-parent') {
    const rows = await findParents(client, {
      projectId: flag(args, '--project-id', { required: true }),
      search: flag(args, '--search', { required: true }),
    });
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (command === 'get') return runGet(client, args, env);
  if (command === 'delete') return runDelete(client, args, env);
  if (command === 'set-dates') return runSetDates(client, args, env);

  const apply = args.includes('--apply');
  if (apply === args.includes('--dry-run')) {
    throw new UsageError('create needs exactly one of --dry-run or --apply');
  }
  if (apply) assertApplyAllowed(args, client, env);
  const sessionFrom = flag(args, '--session-from');
  if (sessionFrom !== undefined && !['chrome', 'brave'].includes(sessionFrom)) {
    throw new UsageError('--session-from must be chrome or brave');
  }

  const via = flag(args, '--via') ?? 'api';
  if (sessionFrom !== undefined && !apply && via !== 'session') throw new UsageError('--session-from only applies to --apply');
  // A progress report needs the signed-in user to be an assignee; --no-report finishes with a status update instead.
  const noReport = args.includes('--no-report');
  if (!['api', 'session'].includes(via)) throw new UsageError('--via must be api or session');
  const batch = readBatch(args.at(-1));
  const cookie = env.EOFFICE_SESSION_COOKIE || (sessionFrom ? await cookieFromBrowser(sessionFrom, client.host) : '');
  if (via === 'session' && apply && !cookie) {
    throw new UsageError('--via session needs a browser session: pass --session-from brave|chrome or set EOFFICE_SESSION_COOKIE');
  }
  if (!hasToken && !cookie) {
    throw new UsageError('Reading tasks needs EOFFICE_ACCESS_TOKEN or a browser session (--session-from brave|chrome, EOFFICE_SESSION_COOKIE)');
  }
  const progress = cookie ? createSessionClient({ baseUrl: env.EOFFICE_BASE_URL, cookie }) : null;
  // Reads go through the token when there is one; without it the signed-in user's own list, detail page and edit form.
  const reader = hasToken ? {
    findDuplicate: ({ title, parentId }) => findDuplicate(client, { title, parentId }),
    findByTitle: ({ title, parentId }) => readTask(client, { title, parentId }),
    item: ({ id }) => getItem(client, { id, raw: true }),
  } : {
    findDuplicate: async ({ title, parentId }) => {
      const hit = await progress.findByTitle({ title, parentId });
      return hit && { id: hit.id, title: hit.title };
    },
    findByTitle: ({ title, parentId }) => progress.findByTitle({ title, parentId }),
    item: ({ id, people = false }) => progress.readTask({ id, people }),
  };
  const linkFor = makeLinker(env);
  const today = env.EOFFICE_TODAY ?? new Date().toLocaleDateString('en-CA');
  const acceptRunDates = args.includes('--accept-run-dates') || env.EOFFICE_ACCEPT_RUN_DATES === '1';
  const buildItem = async (task, parentId, seen) => {
    const { title, payload } = buildInsertPayload(task, {
      ...batch, settings: { ...batch.settings, parent: parentId },
    });
    const repeated = seen.has(title);
    seen.add(title);
    const duplicate = repeated ? null : await reader.findDuplicate({ title, parentId });
    const reportDate = task.end ?? task.endPlan ?? task.startPlan;
    const sessionFields = via === 'session' ? {
      title,
      projectId: batch.project?.id,
      startPlan: payload.start_plan,
      endPlan: payload.end_plan,
      ownerIds: toUserIds(payload.owner_ids, batch.rules.people),
      assigneeIds: toUserIds(payload.assign_ids, batch.rules.people),
      followerIds: toUserIds(payload.follower_ids, batch.rules.people),
    } : undefined;
    if (sessionFields && !sessionFields.projectId) throw new RulesError('--via session needs batch.project.id (the raw project ID)');
    if (!reportDate) throw new RulesError('each task needs end, endPlan or startPlan (used as the report date)');
    return {
      pastDates: [task.start ?? task.startPlan, task.end ?? task.endPlan].filter(Boolean).some((day) => day < today),
      summary: task.summary, title, duplicate: duplicate && { ...duplicate, link: linkFor(duplicate.id) }, payload, session: sessionFields, repeated, reportDate, note: task.note ?? task.summary.trim(),
    };
  };

  const plan = [];
  const seenTop = new Set();
  for (const task of batch.tasks) {
    const item = await buildItem(task, batch.settings.parent, seenTop);
    const seenChildren = new Set();
    item.children = [];
    for (const child of task.children ?? []) {
      const childItem = await buildItem(
        { layer: task.layer, ...child }, item.duplicate?.id ?? batch.settings.parent, seenChildren,
      );
      if (!item.duplicate) {
        childItem.payload.parent_id = '<id of the new parent task>';
        childItem.duplicate = null;
      }
      item.children.push(childItem);
    }
    plan.push(item);
  }

  // Only a session-created flat task with a report gets its actual dates from the plan; every other path stamps the run date.
  const finishesWithReport = (item, isChild) => via === 'session' && !isChild && !item.children?.length && !noReport;
  const runDates = (item, isChild) => item.pastDates && !finishesWithReport(item, isChild);
  for (const item of plan) {
    item.datesFromRun = runDates(item, false);
    for (const child of item.children) child.datesFromRun = runDates(child, true);
  }

  if (!hasToken) {
    const needsToken = plan.flatMap((item) => [[item, false], ...item.children.map((c) => [c, true])])
      .filter(([item, isChild]) => !item.duplicate && !finishesWithReport(item, isChild));
    if (needsToken.length) {
      throw new UsageError(`${needsToken.length} task(s) finish with a status update, which needs EOFFICE_ACCESS_TOKEN (${needsToken[0][0].summary}...)`);
    }
  }

  if (!apply) {
    console.log(JSON.stringify({ host: client.host, plan }, null, 2));
    return 0;
  }
  const stamped = plan.flatMap((item) => [item, ...item.children]).filter((item) => item.datesFromRun && !item.duplicate);
  if (stamped.length && !isUatHost(client.host, env.EOFFICE_UAT_HOSTS) && !acceptRunDates) {
    throw new UsageError(`${stamped.length} task(s) would get actual dates = run date (${stamped[0].summary}...). Use --via session (flat tasks, with a report) for plan dates, or pass --accept-run-dates`);
  }

  const settleMs = Number(env.EOFFICE_SETTLE_MS ?? 3000);
  const doneStatus = STATUS_DISPLAY[batch.rules.done?.status ?? 'REVIEW'];
  const readBack = (item, parentId) => reader.findByTitle({ title: item.title, parentId });
  const withLink = (result) => {
    const link = result.externalId === undefined ? undefined : linkFor(result.externalId);
    return link ? { ...result, link } : result;
  };
  let halted = false;

  async function create(item, parentId) {
    let created = false;
    try {
      let newId;
      try {
        if (via === 'session') newId = await progress.addTask({ ...item.session, parentId });
        else await insertTask(client, { ...item.payload, parent_id: String(parentId) });
        created = true;
      } catch (err) {
        if (!['network', 'non_json', 'no_id'].includes(err.code)) throw err;
        created = Boolean(await readBack(item, parentId));
        if (!created) throw err;
      }
      if (newId !== undefined) return { id: newId };
      const inserted = await readBack(item, parentId);
      if (!inserted) throw new Error('task not found');
      return inserted;
    } catch (err) {
      err.created = created;
      throw err;
    }
  }

  // The server hides the report button on subtasks and on tasks that have subtasks.
  async function complete(item, inserted, reportable) {
    await sleep(settleMs);
    if (progress && reportable && !noReport) {
      // The server refuses a report while the task is still PENDING; the UI form already starts it in DOING.
      if (via !== 'session') {
        await updateTask(client, { id: inserted.id, status: STATUS_DISPLAY.DOING });
        await sleep(settleMs);
      }
      await progress.reportProgress({
        taskId: inserted.id, date: item.reportDate, percent: 100, note: item.note,
      });
    } else {
      await updateTask(client, { id: inserted.id, status: doneStatus });
    }
    const final = await reader.item({ id: inserted.id });
    return {
      status: final?.status, percent: final?.percent, report: progress && reportable && !noReport ? 'progress-report' : 'status-update-only',
    };
  }

  const failure = (base, err) => (err.created
    ? { ...base, submitted: false, created: true, error: `created but not finished: ${firstLine(err)}` }
    : { ...base, submitted: false, error: firstLine(err) });

  // A task whose people cannot be verified stays at its default status and stops the batch.
  async function checkPeople(item, base, id) {
    let error;
    try {
      const missing = unresolvedPeople(item.payload, await reader.item({ id, people: true }));
      if (!missing.length) return null;
      error = `people not resolved: ${missing.join(',')}`;
    } catch (err) {
      error = `created but not finished: ${firstLine(err)}`;
    }
    halted = true;
    const skipped = (item.children ?? []).map((c) => ({
      summary: c.summary, title: c.title, submitted: false, skipped: HALTED_MESSAGE,
    }));
    const own = withLink({ ...base, submitted: false, created: true, externalId: id, error });
    return skipped.length ? { ...own, children: skipped } : own;
  }

  // Children are finished before the parent so the parent's report comes last.
  async function runItem(item, parentId, isChild = false) {
    const base = { summary: item.summary, title: item.title };
    if (halted) return { ...base, submitted: false, skipped: HALTED_MESSAGE };
    if (item.repeated) return { ...base, submitted: false, skipped: 'duplicate title in batch' };
    let id = item.duplicate?.id;
    if (!item.duplicate) {
      try {
        id = (await create(item, parentId)).id;
      } catch (err) {
        const own = failure(base, err);
        const blocked = (item.children ?? []).map((c) => ({
          summary: c.summary, title: c.title, submitted: false, error: 'parent task was not created',
        }));
        return blocked.length ? { ...own, children: blocked } : own;
      }
    }
    if (!item.duplicate) {
      const stopped = await checkPeople(item, base, id);
      if (stopped) return stopped;
    }
    const children = [];
    for (const child of item.children ?? []) children.push(await runItem(child, id, true));
    let own;
    if (item.duplicate) {
      own = { ...base, submitted: false, skipped: 'already exists', externalId: id };
    } else {
      try {
        own = { ...base, submitted: true, externalId: id, ...(await complete(item, { id }, !isChild && !item.children?.length)) };
      } catch (err) {
        err.created = true;
        own = failure({ ...base, externalId: id }, err);
      }
    }
    const linked = withLink(item.datesFromRun ? { ...own, datesFromRun: true } : own);
    return children.length ? { ...linked, children } : linked;
  }

  const results = [];
  for (const item of plan) results.push(await runItem(item, batch.settings.parent));
  console.log(JSON.stringify(results));
  const flat = (rows) => rows.flatMap((r) => [r, ...flat(r.children ?? [])]);
  return flat(results).every((r) => r.submitted || r.skipped) ? 0 : 1;
}

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  try {
    loadDefaultEnv({ dataDir: resolveDataDir({ skillDir }) });
  } catch (err) {
    throw new UsageError(`Cannot read the default env file: ${firstLine(err)}`);
  }
}

Promise.resolve().then(loadEnv).then(() => main(process.argv.slice(2), process.env)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    const usage = err instanceof UsageError || err instanceof RulesError || err?.name === 'CookieImportError'
      || (err instanceof EofficeApiError && err.code === 'missing_env');
    if (usage || err instanceof EofficeApiError) {
      console.error(err.message.split('\n')[0]);
      process.exitCode = usage ? 2 : 1;
    } else {
      throw err;
    }
  },
);
