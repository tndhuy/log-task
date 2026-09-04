import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EofficeError,
  buildLocator,
  executeTask,
  formatDateForEoffice,
  formatDryRun,
  resolveActionMap,
  validateTasks,
} from './eoffice-automation.mjs';

function automationPage({ optionCount = 1, signalTexts = {} } = {}) {
  const calls = [];
  function makeLocator(key) {
    return {
      nth(index) {
        calls.push(['nth', key, index]);
        return makeLocator(`${key}#${index}`);
      },
      async click() { calls.push(['click', key]); },
      async fill(value) { calls.push(['fill', key, value]); },
      async count() {
        calls.push(['count', key]);
        return key.startsWith('text:') ? optionCount : 1;
      },
      async waitFor(options) { calls.push(['waitFor', key, options]); },
      async innerText() {
        calls.push(['innerText', key]);
        return signalTexts[key] ?? key.slice(key.indexOf(':') + 1);
      },
      async getAttribute(name) {
        calls.push(['getAttribute', key, name]);
        return name === 'href' ? '/work-task-task/view?ID=42' : null;
      },
    };
  }
  const page = {
    async goto(url) { calls.push(['goto', url]); },
    url() { return 'https://eoffice.novagroup.vn/project'; },
    getByLabel(value) { return makeLocator(`label:${value}`); },
    getByPlaceholder(value) { return makeLocator(`placeholder:${value}`); },
    getByRole(role, options) { return makeLocator(`role:${role}:${options.name}`); },
    getByText(value) { return makeLocator(`text:${value}`); },
  };
  return { page, calls };
}

function locatorRecorder() {
  const calls = [];
  const locator = {
    nth(index) {
      calls.push(['nth', index]);
      return locator;
    },
  };
  const page = {
    getByLabel(value, options) {
      calls.push(['label', value, options]);
      return locator;
    },
    getByPlaceholder(value, options) {
      calls.push(['placeholder', value, options]);
      return locator;
    },
    getByRole(role, options) {
      calls.push(['role', role, options]);
      return locator;
    },
    getByText(value, options) {
      calls.push(['text', value, options]);
      return locator;
    },
  };
  return { page, locator, calls };
}

test('buildLocator uses semantic locator options and an optional index', () => {
  const { page, locator, calls } = locatorRecorder();

  const result = buildLocator(page, {
    locatorType: 'role',
    role: 'button',
    locatorValue: 'SUBMIT',
    exact: true,
    index: 1,
  });

  assert.equal(result, locator);
  assert.deepEqual(calls, [
    ['role', 'button', { name: 'SUBMIT', exact: true }],
    ['nth', 1],
  ]);
});

test('buildLocator supports an indexed role without an accessible name', () => {
  const { page, calls } = locatorRecorder();
  buildLocator(page, { locatorType: 'role', role: 'textbox', index: 4 });
  assert.deepEqual(calls, [
    ['role', 'textbox', {}],
    ['nth', 4],
  ]);
});

test('buildLocator supports a semantic accessible-name pattern', () => {
  const { page, calls } = locatorRecorder();
  buildLocator(page, {
    locatorType: 'role',
    role: 'link',
    locatorPattern: '^Tasks(?: \\(\\d+\\))?$',
  });

  assert.equal(calls[0][0], 'role');
  assert.equal(calls[0][1], 'link');
  assert.ok(calls[0][2].name instanceof RegExp);
  assert.equal(calls[0][2].name.source, '^Tasks(?: \\(\\d+\\))?$');
});

test('buildLocator supports labels, placeholders, and visible text', () => {
  for (const [locatorType, expectedMethod] of [
    ['label', 'label'],
    ['placeholder', 'placeholder'],
    ['text', 'text'],
  ]) {
    const { page, calls } = locatorRecorder();
    buildLocator(page, { locatorType, locatorValue: 'Task name' });
    assert.equal(calls[0][0], expectedMethod);
    assert.equal(calls[0][1], 'Task name');
  }
});

test('buildLocator rejects unsupported locator types', () => {
  const { page } = locatorRecorder();
  assert.throws(
    () => buildLocator(page, { locatorType: 'css', locatorValue: '#submit' }),
    /Unknown locatorType/,
  );
});

test('formatDateForEoffice converts ISO dates and preserves display dates', () => {
  assert.equal(formatDateForEoffice('2026-08-25'), '25/08/2026');
  assert.equal(formatDateForEoffice('25/08/2026'), '25/08/2026');
  assert.throws(() => formatDateForEoffice('25-08-2026'), /Expected a date/);
  assert.throws(() => formatDateForEoffice('2026-02-30'), /Expected a valid date/);
});

test('resolveActionMap selects the requested action and rejects an incomplete map', () => {
  const createTask = { fields: {} };
  assert.equal(resolveActionMap({ createTask }, 'create-task'), createTask);
  assert.throws(
    () => resolveActionMap({ createTask }, 'report-progress'),
    (error) => error instanceof EofficeError && error.exitCode === 4,
  );
});

test('validateTasks reports unresolved person fields with exit code 6', () => {
  const actionMap = {
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
    fields: {
      taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
      follower: { locatorType: 'placeholder', locatorValue: 'Select followers', type: 'person' },
    },
  };

  assert.throws(
    () => validateTasks(actionMap, [{ taskName: 'Example' }]),
    (error) => error instanceof EofficeError
      && error.exitCode === 6
      && /follower/.test(error.message)
      && /Example/.test(error.message),
  );
});

test('validateTasks rejects missing non-person fields with exit code 4', () => {
  const actionMap = {
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
    fields: {
      taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
      reportDate: { locatorType: 'placeholder', locatorValue: 'dd/mm/yyyy', type: 'date' },
    },
  };

  assert.throws(
    () => validateTasks(actionMap, [{ taskName: 'Example' }]),
    (error) => error instanceof EofficeError && error.exitCode === 4,
  );
});

test('validateTasks enforces required values that are not directly editable controls', () => {
  const actionMap = {
    requiredFields: ['project', 'assignor', 'collaborator'],
    equalFields: [['follower', 'collaborator']],
    fields: {
      taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
      taskCode: { locatorType: 'placeholder', locatorValue: 'Task code', type: 'text', optional: true },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
  };

  assert.doesNotThrow(() => validateTasks(actionMap, [{
    taskName: 'Example', project: 'Alpha', assignor: 'Me', follower: 'Boss', collaborator: 'Boss',
  }]));
  assert.throws(
    () => validateTasks(actionMap, [{
      taskName: 'Example', project: 'Alpha', assignor: 'Me', follower: 'Boss', collaborator: 'Other',
    }]),
    (error) => error instanceof EofficeError && error.exitCode === 6 && /must match/.test(error.message),
  );
});

test('validateTasks rejects a report progress value other than the configured 100 percent', () => {
  const actionMap = {
    fixedValues: { progress: '100' },
    fields: {
      progress: { locatorType: 'placeholder', locatorValue: 'Progress %', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
  };

  assert.throws(
    () => validateTasks(actionMap, [{ taskName: 'Example', progress: '50' }]),
    (error) => error instanceof EofficeError && error.exitCode === 4 && /must be "100"/.test(error.message),
  );
});

test('formatDryRun lists navigation, fields, submit, and every success signal', () => {
  const actionMap = {
    entryUrl: 'https://eoffice.example/projects',
    navigation: [
      { locatorType: 'text', locatorValueField: 'project', exact: true },
    ],
    fields: {
      reportDate: { locatorType: 'placeholder', locatorValue: 'dd/mm/yyyy', type: 'date' },
      progress: { locatorType: 'placeholder', locatorValue: 'Progress %', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
    successSignals: [
      { locatorType: 'text', locatorValue: '100%' },
      { locatorType: 'text', locatorValue: 'Evaluating' },
    ],
  };

  const output = formatDryRun('report-progress', actionMap, [{
    taskName: 'Example', project: 'Alpha', reportDate: '2026-08-25', progress: '100',
  }]);

  assert.match(output, /Dry run \(report-progress\)/);
  assert.match(output, /Navigate to https:\/\/eoffice\.example\/projects/);
  assert.match(output, /Click \[text:Alpha\]/);
  assert.match(output, /Fill \[placeholder:dd\/mm\/yyyy\].*25\/08\/2026/);
  assert.match(output, /Click \[role:SUBMIT\]/);
  assert.match(output, /Confirm \[text:100%\]/);
  assert.match(output, /Confirm \[text:Evaluating\]/);
});

test('executeTask navigates, fills normalized values, submits, and verifies signals', async () => {
  const { page, calls } = automationPage({
    signalTexts: {
      'text:100%': 'Progress 100%',
      'text:Evaluating': 'Evaluating',
    },
  });
  const actionMap = {
    entryUrl: 'https://eoffice.novagroup.vn/projects',
    navigation: [{ locatorType: 'text', locatorValueField: 'taskName', exact: true }],
    fields: {
      reportDate: { locatorType: 'placeholder', locatorValue: 'dd/mm/yyyy', type: 'date' },
      progress: { locatorType: 'placeholder', locatorValue: 'Progress %', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
    successSignals: [
      { locatorType: 'text', locatorValue: '100%', matches: '100%' },
      { locatorType: 'text', locatorValue: 'Evaluating', matches: 'Evaluating' },
    ],
  };

  const result = await executeTask(page, actionMap, {
    taskName: 'Example task', reportDate: '2026-08-25', progress: '100',
  });

  assert.deepEqual(result, { taskName: 'Example task', submitted: true });
  assert.ok(calls.some((call) => call[0] === 'goto' && call[1] === actionMap.entryUrl));
  assert.ok(calls.some((call) => call[0] === 'fill' && call[2] === '25/08/2026'));
  assert.ok(calls.some((call) => call[0] === 'click' && call[1] === 'role:button:SUBMIT'));
  assert.ok(calls.some((call) => call[0] === 'waitFor' && call[1] === 'text:100%'));
  assert.ok(calls.some((call) => call[0] === 'waitFor' && call[1] === 'text:Evaluating'));
});

test('executeTask refuses an ambiguous person match with exit code 6', async () => {
  const { page } = automationPage({ optionCount: 2 });
  const actionMap = {
    entryUrl: 'https://eoffice.novagroup.vn/projects',
    fields: {
      assignee: {
        locatorType: 'placeholder', locatorValue: 'Assignee name', type: 'person',
        optionLocator: { locatorType: 'text', locatorValueField: 'assignee', exact: true },
      },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
  };

  await assert.rejects(
    () => executeTask(page, actionMap, { taskName: 'Example', assignee: 'Me' }),
    (error) => error instanceof EofficeError && error.exitCode === 6 && /assignee/.test(error.message),
  );
});

test('executeTask captures a task link from a success signal', async () => {
  const { page } = automationPage();
  const actionMap = {
    entryUrl: 'https://eoffice.novagroup.vn/projects',
    fields: {
      taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
    successSignal: {
      locatorType: 'text', locatorValueField: 'taskName', captureHref: true,
    },
  };

  const result = await executeTask(page, actionMap, { taskName: 'Example' });
  assert.equal(result.externalLink, 'https://eoffice.novagroup.vn/work-task-task/view?ID=42');
});

test('executeTask can wait for a navigation landmark without clicking it', async () => {
  const { page, calls } = automationPage();
  const actionMap = {
    entryUrl: 'https://eoffice.novagroup.vn/projects',
    navigation: [{
      action: 'wait', locatorType: 'text', locatorValue: 'Task progress report', exact: true,
    }],
    fields: {
      progress: { locatorType: 'placeholder', locatorValue: 'Progress %', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
  };

  await executeTask(page, actionMap, { taskName: 'Example', progress: '100' });
  assert.ok(calls.some((call) => call[0] === 'waitFor' && call[1] === 'text:Task progress report'));
  assert.ok(!calls.some((call) => call[0] === 'click' && call[1] === 'text:Task progress report'));
});

test('executeTask waits for lazy navigation controls before requiring a unique match', async () => {
  let ready = false;
  const navigationLocator = {
    async waitFor({ state }) {
      assert.equal(state, 'visible');
      ready = true;
    },
    async count() { return ready ? 1 : 0; },
    async click() {},
  };
  const ordinaryLocator = {
    async fill() {},
    async click() {},
    async waitFor() {},
    async count() { return 1; },
  };
  const page = {
    async goto() {},
    url() { return 'https://eoffice.novagroup.vn/project'; },
    getByText(value) {
      return value === 'Tasks' ? navigationLocator : ordinaryLocator;
    },
    getByPlaceholder() { return ordinaryLocator; },
    getByRole() { return ordinaryLocator; },
  };
  const actionMap = {
    entryUrl: 'https://eoffice.novagroup.vn/projects',
    navigation: [{ locatorType: 'text', locatorValue: 'Tasks', exact: true }],
    fields: {
      taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
  };

  await executeTask(page, actionMap, { taskName: 'Example' });
  assert.equal(ready, true);
});

test('executeTask can wait for a transient loading indicator to disappear', async () => {
  const calls = [];
  const loadingLocator = {
    async waitFor(options) { calls.push(['loading-wait', options]); },
    async count() { return 0; },
    async click() { calls.push(['loading-click']); },
  };
  const ordinaryLocator = {
    async fill() {},
    async click() {},
    async waitFor() {},
    async count() { return 1; },
  };
  const page = {
    async goto() {},
    url() { return 'https://eoffice.novagroup.vn/project'; },
    getByText(value) { return value === 'Loading' ? loadingLocator : ordinaryLocator; },
    getByPlaceholder() { return ordinaryLocator; },
    getByRole() { return ordinaryLocator; },
  };
  const actionMap = {
    entryUrl: 'https://eoffice.novagroup.vn/projects',
    navigation: [{
      action: 'wait', state: 'hidden', requireUnique: false,
      locatorType: 'text', locatorValue: 'Loading', exact: true,
    }],
    fields: {
      taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
  };

  await executeTask(page, actionMap, { taskName: 'Example' });
  assert.deepEqual(calls, [['loading-wait', { state: 'hidden', timeout: 10_000 }]]);
});

test('executeTask can require the submitted form to disappear', async () => {
  const { page, calls } = automationPage();
  const actionMap = {
    entryUrl: 'https://eoffice.novagroup.vn/projects',
    fields: {
      taskName: { locatorType: 'placeholder', locatorValue: 'Task name', type: 'text' },
    },
    submitLocator: { locatorType: 'role', role: 'button', locatorValue: 'SUBMIT' },
    successSignal: {
      locatorType: 'role', role: 'button', locatorValue: 'SUBMIT', state: 'hidden',
    },
  };

  await executeTask(page, actionMap, { taskName: 'Example' });
  assert.ok(calls.some((call) => call[0] === 'waitFor'
    && call[1] === 'role:button:SUBMIT'
    && call[2].state === 'hidden'));
  assert.ok(!calls.some((call) => call[0] === 'innerText' && call[1] === 'role:button:SUBMIT'));
});

test('recorded form map accepts both checked-in dry-run fixtures', () => {
  const formMap = JSON.parse(readFileSync(new URL('../../references/eoffice-form-map.json', import.meta.url)));
  const createTasks = JSON.parse(readFileSync(new URL('../../fixtures/eoffice-create.example.json', import.meta.url)));
  const reportTasks = JSON.parse(readFileSync(new URL('../../fixtures/eoffice-report.example.json', import.meta.url)));

  assert.match(formatDryRun('create-task', resolveActionMap(formMap, 'create-task'), createTasks), /SUBMIT/);
  assert.match(formatDryRun('report-progress', resolveActionMap(formMap, 'report-progress'), reportTasks), /Evaluating/);
});
