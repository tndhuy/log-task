#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject, ConfigError } from './lib/resolve-project.mjs';
import { planLedgerMigration } from './lib/ledger-migration.mjs';

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: resolve-project.mjs <resolve|migration-plan> [--cwd <dir>] [--config <file>]';

function option(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
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
  const configPath = option(rest, '--config', path.join(skillDir, 'projects.json'));
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const resolved = resolveProject(config, cwd, { skillDir });
    assertChildrenOnDisk(resolved);
    const output = command === 'resolve' ? resolved : planLedgerMigration(resolved, { skillDir });
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
