#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EofficeError,
  executeTask,
  formatDryRun,
  resolveActionMap,
  validateTasks,
} from './lib/eoffice-automation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultSessionPath = path.join(scriptDir, '..', '.eoffice-session.json');
const defaultFormMapPath = path.join(scriptDir, '..', 'references', 'eoffice-form-map.json');

function usage() {
  return 'Usage: node scripts/eoffice-write.mjs <create-task|report-progress> [--dry-run] <tasks.json>';
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new EofficeError(`Could not read ${label} at ${filePath}: ${error.message}`, 4, 'invalid_json');
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const [action, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const tasksPath = rest.find((argument) => !argument.startsWith('--'));
  if (!['create-task', 'report-progress'].includes(action) || !tasksPath) {
    throw new EofficeError(usage(), 1, 'bad_action');
  }

  const formMapPath = env.EOFFICE_FORM_MAP_PATH || defaultFormMapPath;
  if (!fs.existsSync(formMapPath)) {
    throw new EofficeError(
      `No eOffice form map found at ${formMapPath}. Run discover-eoffice-form.mjs first.`,
      4,
      'missing_form_map',
    );
  }
  const actionMap = resolveActionMap(readJson(formMapPath, 'eOffice form map'), action);
  const tasks = readJson(path.resolve(tasksPath), 'tasks file');
  validateTasks(actionMap, tasks);

  if (dryRun) {
    console.log(formatDryRun(action, actionMap, tasks));
    return 0;
  }

  const sessionPath = env.EOFFICE_SESSION_PATH || defaultSessionPath;
  if (!fs.existsSync(sessionPath)) {
    throw new EofficeError(
      `No eOffice session found at ${sessionPath}. Run eoffice-session.mjs first.`,
      3,
      'missing_session',
    );
  }

  let chromium = dependencies.chromium;
  if (!chromium) {
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new EofficeError(
        'Playwright is not installed. Run npm install && npx playwright install chromium.',
        4,
        'missing_playwright',
      );
    }
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: env.EOFFICE_HEADED !== '1' });
  } catch (error) {
    throw new EofficeError(
      `Could not launch Playwright Chromium: ${error.message}. Run npx playwright install chromium.`,
      4,
      'missing_browser',
    );
  }
  try {
    let context;
    try {
      context = await browser.newContext({ storageState: sessionPath });
    } catch (error) {
      throw new EofficeError(
        `Could not load the eOffice session: ${error.message}. Re-run eoffice-session.mjs.`,
        3,
        'invalid_session',
      );
    }
    const page = await context.newPage();
    const results = [];
    for (const task of tasks) {
      try {
        results.push(await executeTask(page, actionMap, task));
      } catch (error) {
        if (error instanceof EofficeError && error.exitCode === 3) throw error;
        results.push({ taskName: task.taskName, submitted: false, error: error.message });
      }
    }
    console.log(JSON.stringify(results));
    return results.every((result) => result.submitted) ? 0 : 5;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error instanceof EofficeError ? error.exitCode : 1;
  }
}
