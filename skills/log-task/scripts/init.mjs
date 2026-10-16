#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, flag } from './lib/cli-args.mjs';
import { resolveDataDir } from './lib/data-dir.mjs';
import { initSetup } from './lib/init.mjs';

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitEmail() {
  const result = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

try {
  const email = flag(process.argv.slice(2), '--email') ?? gitEmail();
  const dataDir = resolveDataDir({ skillDir });
  const actions = initSetup({ dataDir, assetsDir: path.join(skillDir, 'assets'), email });
  for (const { file, status } of actions) console.log(`${status.padEnd(7)} ${file}`);
  console.log(`\nNext: edit projects.json for your projects, then run: node ${path.join(skillDir, 'scripts/doctor.mjs')}`);
  if (email) console.log(`gitEmails placeholder replaced with ${email}`);
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(err.message);
  process.exitCode = 2;
}
