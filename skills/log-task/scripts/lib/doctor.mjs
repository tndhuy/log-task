import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { ConfigError, resolveProject } from './resolve-project.mjs';
import { isUatHost } from './eoffice-api.mjs';

const MIN_NODE = [22, 13];

const ok = (name, detail) => ({ name, status: 'ok', detail });
const warn = (name, detail) => ({ name, status: 'warn', detail });
const fail = (name, detail) => ({ name, status: 'fail', detail });

function checkNode(version) {
  const [major, minor] = version.split('.').map(Number);
  const supported = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return supported
    ? ok('node', `v${version}`)
    : fail('node', `v${version} is too old, need ${MIN_NODE.join('.')} or newer`);
}

function checkGit(run) {
  const result = run('git', ['--version']);
  return result.status === 0 ? ok('git', result.stdout.trim()) : fail('git', 'git is not installed');
}

function readConfig(dataDir, readFile) {
  const file = path.join(dataDir, 'projects.json');
  let raw;
  try {
    raw = readFile(file, 'utf8');
  } catch {
    return { check: fail('config', `${file} not found. Run: node <skill-dir>/scripts/init.mjs`) };
  }
  try {
    return { check: ok('config', file), config: JSON.parse(raw) };
  } catch (err) {
    return { check: fail('config', `invalid JSON in ${file}: ${err.message}`) };
  }
}

function checkProject(config, cwd, dataDir) {
  try {
    const resolved = resolveProject(config, cwd, { dataDir });
    const names = resolved.targets.map((t) => `${t.name} (${t.platform})`).join(', ');
    return { check: ok('project', `${resolved.mode}: ${names}`), resolved };
  } catch (err) {
    if (err instanceof ConfigError) return { check: warn('project', err.message) };
    throw err;
  }
}

function checkEnv(env) {
  const checks = [];
  for (const name of ['EOFFICE_BASE_URL', 'EOFFICE_ACCESS_TOKEN']) {
    checks.push(env[name] ? ok(name, 'set') : fail(name, 'not set'));
  }
  if (env.EOFFICE_BASE_URL) {
    try {
      const { host } = new URL(env.EOFFICE_BASE_URL);
      const kind = isUatHost(host, env.EOFFICE_UAT_HOSTS) ? 'UAT' : 'NOT in the UAT list: writes need an explicit production instruction';
      checks.push(ok('host', `${host} (${kind})`));
    } catch {
      checks.push(fail('EOFFICE_BASE_URL', 'not a valid URL, use scheme and host only'));
    }
  }
  return checks;
}

export function runChecks({
  env, cwd, dataDir, nodeVersion = process.versions.node, readFile = fs.readFileSync,
  run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }),
}) {
  const checks = [checkNode(nodeVersion), checkGit(run)];
  const { check, config } = readConfig(dataDir, readFile);
  checks.push(check);
  if (!config) return checks;
  const { check: projectCheck, resolved } = checkProject(config, cwd, dataDir);
  checks.push(projectCheck);
  if (resolved?.targets.some((t) => t.platform === 'eoffice-api')) checks.push(...checkEnv(env));
  return checks;
}
