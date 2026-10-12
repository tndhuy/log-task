#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UsageError, flag } from './lib/cli-args.mjs';
import { RulesError, validateRules, settingsPlan, pickRemembered } from './lib/eoffice-rules.mjs';

const USAGE = `Usage:
  eoffice-api-state.mjs settings-plan --rules <rules.json> [--state <state.json>]
  eoffice-api-state.mjs remember --rules <rules.json> --state <state.json> --settings <settings.json>`;

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read ${label} ${file}: ${err.message}`);
  }
}

function readState(file) {
  return file && fs.existsSync(file) ? readJson(file, 'state') : {};
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command !== 'settings-plan' && command !== 'remember') throw new UsageError(USAGE);
  const rules = validateRules(readJson(flag(args, '--rules', { required: true }), 'rules'));
  const stateFile = flag(args, '--state', { required: command === 'remember' });
  const state = readState(stateFile);

  if (command === 'settings-plan') {
    console.log(JSON.stringify(settingsPlan(rules, state), null, 2));
    return 0;
  }
  const settings = readJson(flag(args, '--settings', { required: true }), 'settings');
  const picked = pickRemembered(rules, settings);
  writeAtomic(stateFile, { ...state, ...picked });
  console.log(JSON.stringify(picked));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError || err instanceof RulesError) {
    console.error(err.message.split('\n')[0]);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
