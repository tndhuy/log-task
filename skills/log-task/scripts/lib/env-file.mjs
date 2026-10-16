import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_ENV_FILE = 'eoffice.env';

// Variables already set in the shell win over the file, so --env-file and exports still override it.
export function loadDefaultEnv({ dataDir, exists = fs.existsSync, load = (file) => process.loadEnvFile(file) }) {
  const file = path.join(dataDir, DEFAULT_ENV_FILE);
  if (!exists(file)) return null;
  load(file);
  return file;
}
