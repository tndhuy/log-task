#!/usr/bin/env node
import * as fs from 'node:fs';
import { UsageError, flag } from './lib/cli-args.mjs';
import {
  EofficeApiError, createClient, findDuplicate, findParents, insertTask, readTask, updateTask,
} from './lib/eoffice-api.mjs';
import { createProgressClient } from './lib/eoffice-progress.mjs';
import {
  RulesError, STATUS_DISPLAY, buildInsertPayload, validateRules,
} from './lib/eoffice-rules.mjs';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

function assertApplyAllowed(args, client) {
  if (flag(args, '--confirm-host') !== client.host) {
    throw new UsageError(`--apply needs --confirm-host ${client.host}`);
  }
  if (!isUatHost(client.host) && !args.includes('--allow-production')) {
    throw new UsageError(`${client.host} is not a UAT host: refused. --allow-production may be added only when the user states in this run that the UAT checklist is complete`);
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
  const buildItem = async (task, parentId, seen) => {
    const { title, payload } = buildInsertPayload(task, {
      ...batch, settings: { ...batch.settings, parent: parentId },
    });
    const repeated = seen.has(title);
    seen.add(title);
    const duplicate = repeated ? null : await findDuplicate(client, { title, parentId });
    const reportDate = task.end ?? task.endPlan ?? task.startPlan;
    if (!reportDate) throw new RulesError('each task needs end, endPlan or startPlan (used as the report date)');
    return {
      summary: task.summary, title, duplicate, payload, repeated, reportDate, note: task.note ?? task.summary.trim(),
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

  if (!apply) {
    console.log(JSON.stringify({ host: client.host, plan }, null, 2));
    return 0;
  }

  const settleMs = Number(env.EOFFICE_SETTLE_MS ?? 3000);
  const progress = env.EOFFICE_SESSION_COOKIE
    ? createProgressClient({ baseUrl: env.EOFFICE_BASE_URL, cookie: env.EOFFICE_SESSION_COOKIE })
    : null;
  const doneStatus = STATUS_DISPLAY[batch.rules.done?.status ?? 'REVIEW'];
  const readBack = (item, parentId) => readTask(client, { title: item.title, parentId });

  async function create(item, parentId) {
    let created = false;
    try {
      try {
        await insertTask(client, { ...item.payload, parent_id: String(parentId) });
        created = true;
      } catch (err) {
        if (err.code !== 'network' && err.code !== 'non_json') throw err;
        created = Boolean(await readBack(item, parentId));
        if (!created) throw err;
      }
      const inserted = await readBack(item, parentId);
      if (!inserted) throw new Error('task not found');
      return inserted;
    } catch (err) {
      err.created = created;
      throw err;
    }
  }

  // The server hides the report button on subtasks and on tasks that have subtasks.
  async function complete(item, inserted, parentId, reportable) {
    await sleep(settleMs);
    if (progress && reportable) {
      await progress.reportProgress({
        taskId: inserted.id, date: item.reportDate, percent: 100, note: item.note,
      });
    } else {
      await updateTask(client, { id: inserted.id, status: doneStatus });
    }
    const final = await readBack(item, parentId);
    return {
      status: final?.status, percent: final?.percent, report: progress && reportable ? 'progress-report' : 'status-update-only',
    };
  }

  const failure = (base, err) => (err.created
    ? { ...base, submitted: false, created: true, error: `created but not finished: ${firstLine(err)}` }
    : { ...base, submitted: false, error: firstLine(err) });

  // Children are finished before the parent so the parent's report comes last.
  async function runItem(item, parentId, isChild = false) {
    const base = { summary: item.summary, title: item.title };
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
    const children = [];
    for (const child of item.children ?? []) children.push(await runItem(child, id, true));
    let own;
    if (item.duplicate) {
      own = { ...base, submitted: false, skipped: 'already exists', externalId: id };
    } else {
      try {
        own = { ...base, submitted: true, externalId: id, ...(await complete(item, { id }, parentId, !isChild && !item.children?.length)) };
      } catch (err) {
        err.created = true;
        own = failure(base, err);
      }
    }
    return children.length ? { ...own, children } : own;
  }

  const results = [];
  for (const item of plan) results.push(await runItem(item, batch.settings.parent));
  console.log(JSON.stringify(results));
  const flat = (rows) => rows.flatMap((r) => [r, ...flat(r.children ?? [])]);
  return flat(results).every((r) => r.submitted || r.skipped) ? 0 : 1;
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
