import * as path from 'node:path';

const DEFAULT_LOG_DIR = '.log-task';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function ledgerKey(absPath) {
  return absPath.replace(/^\/+/, '').replaceAll('/', '-');
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function longest(paths) {
  return paths.reduce((a, b) => (b.length > a.length ? b : a));
}

export function assertSingleOwner(config) {
  const owners = new Map();
  for (const [key, entry] of Object.entries(config)) {
    const paths = entry.type === 'group'
      ? Object.keys(entry.children ?? {}).map((name) => path.resolve(key, name))
      : [key];
    for (const p of paths) {
      const previous = owners.get(p);
      if (previous) {
        throw new ConfigError(`${p} is declared by both ${previous} and ${key}`);
      }
      owners.set(p, key);
    }
  }
}

function buildChild(groupKey, group, name, logRoot) {
  const params = { ...group.params, ...group.children[name].params };
  if (typeof params.project !== 'string' || params.project.trim() === '') {
    throw new ConfigError(`Child "${name}" of ${groupKey} has no params.project`);
  }
  const childPath = path.resolve(groupKey, name);
  return {
    name: path.relative(groupKey, childPath),
    path: childPath,
    platform: group.platform,
    gitEmails: group.children[name].gitEmails ?? group.gitEmails ?? [],
    params,
    rules: { ...group.rules, ...group.children[name].rules },
    ledgerPath: path.join(logRoot, 'ledger', `${ledgerKey(path.relative(groupKey, childPath))}.json`),
    statePath: path.join(logRoot, 'state', `${ledgerKey(path.relative(groupKey, childPath))}.json`),
  };
}

export function resolveProject(config, cwd, { skillDir }) {
  assertSingleOwner(config);
  const matching = Object.keys(config).filter((key) => isInside(key, cwd));
  if (matching.length === 0) {
    throw new ConfigError(`No project configured for ${cwd}`);
  }
  const key = longest(matching);
  const entry = config[key];

  if (entry.type !== 'group') {
    return {
      mode: 'standalone',
      key,
      groupRoot: null,
      logRoot: null,
      targets: [{
        name: key,
        path: key,
        platform: entry.platform,
        gitEmails: entry.gitEmails ?? [],
        params: entry.params ?? {},
        ledgerPath: path.join(skillDir, 'ledger', `${ledgerKey(key)}.json`),
        rules: entry.rules ?? {},
        statePath: path.join(skillDir, 'state', `${ledgerKey(key)}.json`),
      }],
    };
  }

  const names = Object.keys(entry.children ?? {});
  if (names.length === 0) {
    throw new ConfigError(`Group ${key} has no children`);
  }
  const logRoot = path.resolve(key, entry.logDir ?? DEFAULT_LOG_DIR);
  const hit = names.filter((name) => isInside(path.resolve(key, name), cwd));

  if (hit.length > 0) {
    const name = longest(hit);
    return {
      mode: 'child-run', key, groupRoot: key, logRoot,
      targets: [buildChild(key, entry, name, logRoot)],
    };
  }
  return {
    mode: 'group-run', key, groupRoot: key, logRoot,
    targets: names.map((name) => buildChild(key, entry, name, logRoot)),
  };
}
