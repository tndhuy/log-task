import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_ENV_FILE = 'eoffice.env';

// An explicit --env-file replaces the default file entirely, so a production file never
// inherits leftover UAT values. Exported shell variables still win over either file.
export function loadDefaultEnv({
  dataDir, exists = fs.existsSync, load = (file) => process.loadEnvFile(file), execArgv = process.execArgv,
}) {
  if (execArgv.some((arg) => arg.startsWith('--env-file'))) return null;
  const file = path.join(dataDir, DEFAULT_ENV_FILE);
  if (!exists(file)) return null;
  load(file);
  return file;
}
