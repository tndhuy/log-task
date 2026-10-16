import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Per-user data (projects.json, ledgers, state) must live outside the skill
// directory because `npx skills update` replaces that directory.
export function resolveDataDir({
  env = process.env, home = os.homedir(), skillDir, exists = fs.existsSync,
}) {
  if (env.LOG_TASK_HOME) return path.resolve(env.LOG_TASK_HOME);
  if (skillDir && exists(path.join(skillDir, 'projects.json'))) return skillDir;
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'log-task');
}
