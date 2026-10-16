#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject, ConfigError } from './lib/resolve-project.mjs';
import { planLedgerMigration } from './lib/ledger-migration.mjs';
import { resolveDataDir } from './lib/data-dir.mjs';

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolveDataDir({ skillDir });
const USAGE = 'Usage: resolve-project.mjs <resolve|migration-plan> [--cwd <dir>] [--config <file>]';

function option(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function loadConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new ConfigError(`projects.json not found at ${configPath}`);
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`invalid JSON in ${configPath}: ${err.message}`);
  }
}

function assertChildrenOnDisk(resolved) {
  if (resolved.mode === 'standalone') return;
  for (const target of resolved.targets) {
    if (!fs.existsSync(target.path)) {
      throw new ConfigError(`Child "${target.name}" directory does not exist: ${target.path}`);
    }
    if (!fs.existsSync(path.join(target.path, '.git'))) {
      throw new ConfigError(`Child "${target.name}" is not a git repo: ${target.path}`);
    }
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'resolve' && command !== 'migration-plan') {
    console.error(USAGE);
    return 2;
  }
  const cwd = option(rest, '--cwd', process.cwd());
  const configPath = option(rest, '--config', path.join(dataDir, 'projects.json'));
  if (cwd === null || configPath === null) {
    console.error(USAGE);
    return 2;
  }
  try {
    const config = loadConfig(configPath);
    const resolved = resolveProject(config, cwd, { dataDir });
    assertChildrenOnDisk(resolved);
    const output = command === 'resolve' ? resolved : planLedgerMigration(resolved, { dataDir });
    console.log(JSON.stringify(output, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
}

process.exit(main(process.argv.slice(2)));
