#!/usr/bin/env node
import * as fs from 'node:fs';
import { UsageError, flag } from './lib/cli-args.mjs';
import {
  EofficeApiError, createClient, findDuplicate, findParents, insertTask,
} from './lib/eoffice-api.mjs';
import { RulesError, buildInsertPayload, validateRules } from './lib/eoffice-rules.mjs';

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
  const plan = [];
  const seenTitles = new Set();
  for (const task of batch.tasks) {
    const { title, payload } = buildInsertPayload(task, batch);
    const repeated = seenTitles.has(title);
    seenTitles.add(title);
    const duplicate = repeated ? null : await findDuplicate(client, { title, parentId: batch.settings.parent });
    plan.push({ summary: task.summary, title, duplicate, payload, repeated });
  }

  if (!apply) {
    console.log(JSON.stringify({ host: client.host, plan }, null, 2));
    return 0;
  }

  const results = [];
  for (const item of plan) {
    const base = { summary: item.summary, title: item.title };
    if (item.repeated) {
      results.push({ ...base, submitted: false, skipped: 'duplicate title in batch' });
      continue;
    }
    if (item.duplicate) {
      results.push({ ...base, submitted: false, skipped: 'already exists', externalId: item.duplicate.id });
      continue;
    }
    let created = false;
    try {
      await insertTask(client, item.payload);
      created = true;
      const confirmed = await findDuplicate(client, { title: item.title, parentId: batch.settings.parent });
      if (!confirmed) throw new Error('task not found');
      results.push({ ...base, submitted: true, externalId: confirmed.id });
    } catch (err) {
      results.push(created
        ? { ...base, submitted: false, created: true, error: `created but not confirmed on read-back: ${firstLine(err)}` }
        : { ...base, submitted: false, error: firstLine(err) });
    }
  }
  console.log(JSON.stringify(results));
  return results.every((r) => r.submitted || r.skipped) ? 0 : 1;
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
