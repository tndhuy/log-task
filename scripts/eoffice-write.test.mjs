import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from './eoffice-write.mjs';
import { EofficeError } from './lib/eoffice-automation.mjs';

const SCRIPT_PATH = new URL('./eoffice-write.mjs', import.meta.url);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'log-task-eoffice-test-'));
  const formMapPath = join(dir, 'form-map.json');
  const tasksPath = join(dir, 'tasks.json');
  writeFileSync(formMapPath, JSON.stringify({
    createTask: {
      entryUrl: 'https://eoffice.example/projects',
      navigation: [],
      fields: {
        taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
        assignee: {
          locatorType: 'placeholder', locatorValue: 'Assignee name', type: 'person',
          optionLocator: { locatorType: 'text', locatorValueField: 'assignee', exact: true },
        },
      },
      submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
      successSignal: { locatorType: 'text', locatorValueField: 'taskName' },
    },
  }));
  return { dir, formMapPath, tasksPath };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('dry-run prints a plan and does not require a captured browser session', () => {
  const { formMapPath, tasksPath } = fixture();
  writeFileSync(tasksPath, JSON.stringify([{ taskName: 'Example', assignee: 'Me' }]));

  const result = run(['create-task', '--dry-run', tasksPath], {
    EOFFICE_FORM_MAP_PATH: formMapPath,
    EOFFICE_SESSION_PATH: '/does/not/exist.json',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run \(create-task\)/);
  assert.match(result.stdout, /no browser will be opened/);
});

test('dry-run exits 6 when a required person has not been resolved', () => {
  const { formMapPath, tasksPath } = fixture();
  writeFileSync(tasksPath, JSON.stringify([{ taskName: 'Example' }]));

  const result = run(['create-task', '--dry-run', tasksPath], {
    EOFFICE_FORM_MAP_PATH: formMapPath,
  });

  assert.equal(result.status, 6);
  assert.match(result.stderr, /assignee/);
  assert.match(result.stderr, /never guess a person/);
});

test('real mode exits 3 before launching a browser when session state is absent', () => {
  const { formMapPath, tasksPath } = fixture();
  writeFileSync(tasksPath, JSON.stringify([{ taskName: 'Example', assignee: 'Me' }]));

  const result = run(['create-task', tasksPath], {
    EOFFICE_FORM_MAP_PATH: formMapPath,
    EOFFICE_SESSION_PATH: '/does/not/exist.json',
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /eoffice-session\.mjs/);
});

test('invalid action exits 1 with usage information', () => {
  const result = run(['delete-task', 'tasks.json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /create-task\|report-progress/);
});

test('real mode classifies an unreadable storage state as a session error', async () => {
  const { dir, formMapPath, tasksPath } = fixture();
  const sessionPath = join(dir, 'session.json');
  writeFileSync(tasksPath, JSON.stringify([{ taskName: 'Example', assignee: 'Me' }]));
  writeFileSync(sessionPath, '{}');
  const browser = {
    async newContext() { throw new Error('storageState is malformed'); },
    async close() {},
  };

  await assert.rejects(
    () => main(['create-task', tasksPath], {
      EOFFICE_FORM_MAP_PATH: formMapPath,
      EOFFICE_SESSION_PATH: sessionPath,
    }, { chromium: { async launch() { return browser; } } }),
    (error) => error instanceof EofficeError && error.exitCode === 3,
  );
});

test('real mode reports a missing Playwright browser as a setup error', async () => {
  const { dir, formMapPath, tasksPath } = fixture();
  const sessionPath = join(dir, 'session.json');
  writeFileSync(tasksPath, JSON.stringify([{ taskName: 'Example', assignee: 'Me' }]));
  writeFileSync(sessionPath, '{}');

  await assert.rejects(
    () => main(['create-task', tasksPath], {
      EOFFICE_FORM_MAP_PATH: formMapPath,
      EOFFICE_SESSION_PATH: sessionPath,
    }, { chromium: { async launch() { throw new Error('Executable does not exist'); } } }),
    (error) => error instanceof EofficeError && error.exitCode === 4 && /playwright install chromium/.test(error.message),
  );
});
