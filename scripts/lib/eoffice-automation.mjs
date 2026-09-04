const ACTION_KEYS = {
  'create-task': 'createTask',
  'report-progress': 'reportProgress',
};

export class EofficeError extends Error {
  constructor(message, exitCode, code = 'eoffice_error') {
    super(message);
    this.name = 'EofficeError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function buildLocator(page, spec, values = {}) {
  let locatorValue;
  if (spec.locatorPattern !== undefined) {
    if (typeof spec.locatorPattern !== 'string' || spec.locatorPattern.trim() === '') {
      throw new EofficeError('An eOffice locatorPattern must be a non-empty string.', 4, 'bad_form_map');
    }
    locatorValue = new RegExp(spec.locatorPattern);
  } else {
    locatorValue = spec.locatorType === 'role' && !spec.locatorValue && !spec.locatorValueField
      ? undefined
      : resolveLocatorValue(spec, values);
  }
  const options = spec.exact === undefined || spec.locatorPattern !== undefined
    ? undefined
    : { exact: spec.exact };
  let locator;

  if (spec.locatorType === 'role') {
    if (!spec.role) throw new EofficeError('A role locator requires "role".', 4, 'bad_form_map');
    locator = page.getByRole(spec.role, {
      ...(locatorValue === undefined ? {} : { name: locatorValue }),
      ...(options ?? {}),
    });
  } else if (spec.locatorType === 'label') {
    locator = page.getByLabel(locatorValue, options);
  } else if (spec.locatorType === 'placeholder') {
    locator = page.getByPlaceholder(locatorValue, options);
  } else if (spec.locatorType === 'text') {
    locator = page.getByText(locatorValue, options);
  } else {
    throw new EofficeError(
      `Unknown locatorType "${spec.locatorType}" in eoffice-form-map.json`,
      4,
      'bad_form_map',
    );
  }

  return Number.isInteger(spec.index) ? locator.nth(spec.index) : locator;
}

function resolveLocatorValue(spec, values) {
  const value = spec.locatorValueField ? values[spec.locatorValueField] : spec.locatorValue;
  if (typeof value !== 'string' || value.trim() === '') {
    const source = spec.locatorValueField ? `field "${spec.locatorValueField}"` : 'locatorValue';
    throw new EofficeError(`Could not resolve ${source} for an eOffice locator.`, 4, 'bad_form_map');
  }
  return value;
}

export function formatDateForEoffice(value) {
  const displayMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!displayMatch && !isoMatch) {
    throw new EofficeError(`Expected a date as YYYY-MM-DD or DD/MM/YYYY, received "${value}".`, 4, 'bad_task');
  }
  const [year, month, day] = isoMatch
    ? [Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])]
    : [Number(displayMatch[3]), Number(displayMatch[2]), Number(displayMatch[1])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new EofficeError(`Expected a valid date, received "${value}".`, 4, 'bad_task');
  }
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

export function resolveActionMap(formMap, action) {
  const key = ACTION_KEYS[action];
  if (!key) throw new EofficeError(`Unsupported action "${action}".`, 1, 'bad_action');
  if (!formMap?.[key]) {
    throw new EofficeError(`eoffice-form-map.json has no "${key}" section.`, 4, 'bad_form_map');
  }
  return formMap[key];
}

export function validateTasks(actionMap, tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new EofficeError('The tasks file must contain a non-empty JSON array.', 4, 'bad_task');
  }
  if (!actionMap?.fields || !actionMap.submitLocator) {
    throw new EofficeError('The action form map requires fields and submitLocator.', 4, 'bad_form_map');
  }

  for (const task of tasks) {
    for (const [fieldName, expected] of Object.entries(actionMap.fixedValues ?? {})) {
      if (String(task[fieldName]) !== String(expected)) {
        throw new EofficeError(
          `Task "${task.taskName || '(unnamed)'}" field "${fieldName}" must be "${expected}".`,
          4,
          'bad_task',
        );
      }
    }
    for (const fieldName of actionMap.requiredFields ?? []) {
      const value = task[fieldName];
      if (value === undefined || value === null || String(value).trim() === '') {
        throw new EofficeError(
          `Task "${task.taskName || '(unnamed)'}" has no required "${fieldName}" resolved.`,
          ['assignor', 'assignee', 'follower', 'collaborator'].includes(fieldName) ? 6 : 4,
          'bad_task',
        );
      }
    }
    for (const [left, right] of actionMap.equalFields ?? []) {
      if (task[left] !== task[right]) {
        throw new EofficeError(
          `Task "${task.taskName || '(unnamed)'}" fields "${left}" and "${right}" must match.`,
          6,
          'ambiguous_person',
        );
      }
    }
    for (const [fieldName, field] of Object.entries(actionMap.fields)) {
      const value = task[fieldName];
      if (value === undefined || value === null || String(value).trim() === '') {
        if (field.optional) continue;
        const taskName = task.taskName || '(unnamed)';
        if (field.type === 'person') {
          throw new EofficeError(
            `Task "${taskName}" has no "${fieldName}" resolved. This must come from projects.json params; never guess a person.`,
            6,
            'unresolved_person',
          );
        }
        throw new EofficeError(
          `Task "${taskName}" is missing field "${fieldName}" required by the form map.`,
          4,
          'bad_task',
        );
      }
    }
  }
}

function describeLocator(spec, values) {
  const value = spec.locatorPattern
    ? `/${spec.locatorPattern}/`
    : spec.locatorType === 'role' && !spec.locatorValue && !spec.locatorValueField
    ? spec.role
    : resolveLocatorValue(spec, values);
  return `[${spec.locatorType}:${value}${Number.isInteger(spec.index) ? `#${spec.index}` : ''}]`;
}

function displayValue(field, value) {
  return field.type === 'date' ? formatDateForEoffice(String(value)) : String(value);
}

export function formatDryRun(action, actionMap, tasks) {
  validateTasks(actionMap, tasks);
  const lines = [`Dry run (${action}) -- no browser will be opened:`];
  for (const task of tasks) {
    lines.push('', `- Task: ${task.taskName || '(unnamed)'}`, `  Navigate to ${actionMap.entryUrl}`);
    for (const step of actionMap.navigation ?? []) {
      lines.push(`  ${step.action === 'wait' ? 'Wait for' : 'Click'} ${describeLocator(step, task)}`);
    }
    for (const [fieldName, field] of Object.entries(actionMap.fields)) {
      if (field.optional && (task[fieldName] === undefined || task[fieldName] === null || task[fieldName] === '')) continue;
      lines.push(`  Fill ${describeLocator(field, task)} (${field.type}) with: ${displayValue(field, task[fieldName])}`);
    }
    lines.push(`  Click ${describeLocator(actionMap.submitLocator, task)}`);
    for (const signal of normalizeSignals(actionMap)) {
      lines.push(signal.state === 'hidden'
        ? `  Confirm ${describeLocator(signal, task)} is hidden`
        : `  Confirm ${describeLocator(signal, task)} matches "${signal.matches ?? resolveLocatorValue(signal, task)}"`);
    }
  }
  return lines.join('\n');
}

export function normalizeSignals(actionMap) {
  const signals = actionMap.successSignals ?? actionMap.successSignal;
  if (!signals) return [];
  return Array.isArray(signals) ? signals : [signals];
}

async function fillField(page, fieldName, field, task) {
  const locator = buildLocator(page, field, task);
  const value = displayValue(field, task[fieldName]);

  if (field.type === 'person') {
    await locator.click();
    await locator.fill(value);
    if (!field.optionLocator) {
      throw new EofficeError(
        `Person field "${fieldName}" has no optionLocator in eoffice-form-map.json.`,
        4,
        'bad_form_map',
      );
    }
    const option = buildLocator(page, field.optionLocator, task);
    const count = await option.count();
    if (count !== 1) {
      throw new EofficeError(
        `Task "${task.taskName || '(unnamed)'}" field "${fieldName}" matched ${count} people for "${value}"; expected exactly one.`,
        6,
        'ambiguous_person',
      );
    }
    await option.click();
    return;
  }

  await locator.fill(value);
}

async function verifySuccess(page, actionMap, task) {
  let externalLink;
  for (const signal of normalizeSignals(actionMap)) {
    const locator = buildLocator(page, signal, task);
    await locator.waitFor({ state: signal.state ?? 'visible', timeout: signal.timeoutMs ?? 10_000 });
    if (signal.matches) {
      const actual = await locator.innerText();
      if (!actual.includes(signal.matches)) {
        throw new EofficeError(
          `Success signal ${describeLocator(signal, task)} read "${actual}", expected "${signal.matches}".`,
          5,
          'verification_failed',
        );
      }
    }
    if (signal.captureHref) {
      const href = await locator.getAttribute('href');
      if (href) externalLink = new URL(href, page.url()).href;
    }
  }
  return externalLink;
}

export async function executeTask(page, actionMap, task) {
  validateTasks(actionMap, [task]);
  if (!actionMap.entryUrl) {
    throw new EofficeError('The action form map requires entryUrl.', 4, 'bad_form_map');
  }

  await page.goto(actionMap.entryUrl, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) {
    throw new EofficeError(
      'eOffice redirected to login. Re-run eoffice-session.mjs.',
      3,
      'session_expired',
    );
  }

  for (const step of actionMap.navigation ?? []) {
    const locator = buildLocator(page, step, task);
    const expectedState = step.state ?? 'visible';
    await locator.waitFor({ state: expectedState, timeout: step.timeoutMs ?? 10_000 });
    const count = await locator.count();
    if (expectedState !== 'hidden' && step.requireUnique !== false && count !== 1) {
      throw new EofficeError(
        `Navigation ${describeLocator(step, task)} matched ${count} elements; expected exactly one.`,
        5,
        'ambiguous_navigation',
      );
    }
    if (step.action !== 'wait') {
      await locator.click();
    }
  }

  for (const [fieldName, field] of Object.entries(actionMap.fields)) {
    if (field.optional && (task[fieldName] === undefined || task[fieldName] === null || task[fieldName] === '')) continue;
    await fillField(page, fieldName, field, task);
  }

  await buildLocator(page, actionMap.submitLocator, task).click();
  const externalLink = await verifySuccess(page, actionMap, task);
  return {
    taskName: task.taskName,
    submitted: true,
    ...(externalLink ? { externalLink } : {}),
  };
}
