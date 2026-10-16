#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from './lib/data-dir.mjs';
import { runChecks } from './lib/doctor.mjs';
import { loadDefaultEnv } from './lib/env-file.mjs';

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolveDataDir({ skillDir });
const MARK = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };

try {
  loadDefaultEnv({ dataDir });
} catch (err) {
  console.error(`Cannot read the default env file: ${String(err.message).split('\n')[0]}`);
  process.exit(2);
}

const checks = runChecks({ env: process.env, cwd: process.cwd(), dataDir });
console.log(`log-task doctor (data directory: ${dataDir})`);
for (const { name, status, detail } of checks) console.log(`${MARK[status]} ${name}: ${detail}`);
process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
