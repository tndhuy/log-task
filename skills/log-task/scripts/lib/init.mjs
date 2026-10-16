import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_ENV_FILE } from './env-file.mjs';

const PLACEHOLDER_EMAIL = 'you@example.com';

// Existing files are never overwritten: the data directory belongs to the user.
export function initSetup({ dataDir, assetsDir, email }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const actions = [];

  const projectsFile = path.join(dataDir, 'projects.json');
  if (fs.existsSync(projectsFile)) {
    actions.push({ file: projectsFile, status: 'kept' });
  } else {
    let example = fs.readFileSync(path.join(assetsDir, 'projects.json.example'), 'utf8');
    if (email) example = example.replaceAll(PLACEHOLDER_EMAIL, email);
    fs.writeFileSync(projectsFile, example, { mode: 0o600 });
    actions.push({ file: projectsFile, status: 'created' });
  }

  const envFile = path.join(dataDir, DEFAULT_ENV_FILE);
  if (fs.existsSync(envFile)) {
    actions.push({ file: envFile, status: 'kept' });
  } else {
    fs.copyFileSync(path.join(assetsDir, 'env.example'), envFile);
    fs.chmodSync(envFile, 0o600);
    actions.push({ file: envFile, status: 'created' });
  }
  return actions;
}
