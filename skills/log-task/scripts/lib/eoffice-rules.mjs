export class RulesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RulesError';
  }
}

export const REQUIRED_FLAG_DEFAULTS = Object.freeze({
  assign_other_off: 'Cho phép xem chéo',
  follower_not_view: 'Cho phép xem',
  assign_parent_off: 'Cho phép xem',
  follower_other_not_view: 'Cho phép xem',
});

// Without field_raws the API takes display values; only REVIEW was verified on UAT.
export const STATUS_DISPLAY = Object.freeze({ DOING: 'Đang thực hiện', REVIEW: 'Đang đánh giá' });

const ALLOWED_FLAG_KEYS = new Set([...Object.keys(REQUIRED_FLAG_DEFAULTS), 'progress_type', 'method']);
const TEMPLATE_VARS = new Set(['layer', 'summary']);
const FIELD_KEYS = ['layer', 'parent', 'owner', 'assignees', 'followers'];
const SETTING_FIELDS = ['parent', 'owner', 'assignees', 'followers'];

function validateCandidates(key, candidates) {
  if (key !== 'parent') throw new RulesError('candidates is only supported on rules.parent');
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new RulesError('rules.parent.candidates must be a non-empty array');
  }
  const seen = new Set();
  for (const entry of candidates) {
    const id = entry?.id;
    const validId = (Number.isInteger(id) && id > 0) || (typeof id === 'string' && id.trim() !== '');
    if (!validId || typeof entry.label !== 'string' || entry.label.trim() === '') {
      throw new RulesError('rules.parent.candidates entries need an id (positive integer or non-blank string) and a non-blank label');
    }
    if (seen.has(String(id))) throw new RulesError(`rules.parent.candidates has duplicate id ${id}`);
    seen.add(String(id));
  }
}

function validateDates(dates) {
  if (!dates || typeof dates !== 'object' || Array.isArray(dates)) {
    throw new RulesError('rules.dates must be an object');
  }
  for (const [key, value] of Object.entries(dates)) {
    if (key !== 'actualFromPlan') throw new RulesError(`rules.dates.${key} is not supported`);
    if (typeof value !== 'boolean') throw new RulesError('rules.dates.actualFromPlan must be a boolean');
  }
}

function validatePeople(people) {
  if (!people || typeof people !== 'object' || Array.isArray(people)) {
    throw new RulesError('rules.people must be an object of display name to numeric user ID');
  }
  for (const [name, id] of Object.entries(people)) {
    if (!name.trim() || !Number.isInteger(id) || id <= 0) {
      throw new RulesError(`rules.people["${name}"] must be a positive integer user ID`);
    }
  }
}

// The UI form takes user IDs, the API takes display names; this map is the bridge and is never guessed.
export function toUserIds(names, people = {}) {
  const list = Array.isArray(names) ? names : String(names ?? '').split(',');
  const wanted = list.map((name) => name.trim()).filter(Boolean);
  const missing = wanted.filter((name) => people[name] === undefined);
  if (missing.length) {
    throw new RulesError(`rules.people has no user ID for: ${missing.join(', ')} (needed for --via session)`);
  }
  return wanted.map((name) => people[name]);
}

export function validateRules(rules) {
  if (!rules || typeof rules !== 'object') throw new RulesError('rules is required');
  const template = rules.nameTemplate;
  if (typeof template !== 'string' || !template.includes('{summary}')) {
    throw new RulesError('rules.nameTemplate must be a string containing {summary}');
  }
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
    if (!TEMPLATE_VARS.has(name)) {
      throw new RulesError(`rules.nameTemplate uses unknown variable {${name}}`);
    }
  }
  if (template.includes('{layer}') && !rules.layer) {
    throw new RulesError('rules.layer is required when nameTemplate uses {layer}');
  }
  for (const key of FIELD_KEYS) {
    const field = rules[key];
    if (field === undefined) continue;
    if (!field || (field.mode !== 'fixed' && field.mode !== 'ask')) {
      throw new RulesError(`rules.${key}.mode must be "fixed" or "ask"`);
    }
    if (field.mode === 'fixed' && field.value === undefined) {
      throw new RulesError(`rules.${key} is fixed but has no value`);
    }
    if (field.candidates !== undefined) {
      validateCandidates(key, field.candidates);
      if (field.mode !== 'ask') throw new RulesError('rules.parent candidates require mode "ask"');
    }
  }
  if (rules.layer !== undefined && rules.layer.mode !== 'fixed') {
    throw new RulesError('rules.layer must be fixed (set a per-task "layer" in the batch to vary it)');
  }
  if (rules.dates !== undefined) validateDates(rules.dates);
  if (rules.people !== undefined) validatePeople(rules.people);
  if (rules.done?.status !== undefined && rules.done.status !== 'REVIEW') {
    throw new RulesError(`rules.done.status must be REVIEW`);
  }
  if (rules.flags !== undefined) {
    if (!rules.flags || typeof rules.flags !== 'object' || Array.isArray(rules.flags)) {
      throw new RulesError('rules.flags must be an object');
    }
    for (const [key, value] of Object.entries(rules.flags)) {
      if (!ALLOWED_FLAG_KEYS.has(key)) throw new RulesError(`rules.flags.${key} is not an allowed flag`);
      if (typeof value !== 'string') throw new RulesError(`rules.flags.${key} must be a string`);
    }
  }
  return rules;
}

export function renderName(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!TEMPLATE_VARS.has(name)) throw new RulesError(`Unknown template variable {${name}}`);
    const value = vars[name];
    if (typeof value !== 'string' || value === '') {
      throw new RulesError(`Template variable {${name}} has no value`);
    }
    return value;
  });
}

export function toApiDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!match) throw new RulesError(`Date must be YYYY-MM-DD, got "${iso}"`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    throw new RulesError(`Not a real date: "${iso}"`);
  }
  return `${day}/${month}/${year}`;
}

export function buildInsertPayload(task, { rules, project, settings }) {
  if (typeof task.summary !== 'string' || task.summary.trim() === '') {
    throw new RulesError('task.summary is required');
  }
  if (settings?.parent === undefined || settings.parent === null || settings.parent === '') {
    throw new RulesError('settings.parent is required');
  }
  if (!project?.ref) throw new RulesError('project.ref is required');
  if (!settings.assignees?.length) {
    throw new RulesError('settings.assignees needs at least one username (tasks without an assignee trigger an automatic warning)');
  }

  const layer = task.layer ?? rules.layer?.value;
  const title = renderName(rules.nameTemplate, { layer, summary: task.summary.trim() });
  const payload = {
    title,
    project_id: String(project.ref),
    parent_id: String(settings.parent),
    ...REQUIRED_FLAG_DEFAULTS,
    ...rules.flags,
  };
  if (settings.owner) payload.owner_ids = settings.owner;
  if (settings.assignees?.length) payload.assign_ids = settings.assignees.join(',');
  if (settings.followers?.length) payload.follower_ids = settings.followers.join(',');
  for (const [from, to] of [
    ['startPlan', 'start_plan'], ['endPlan', 'end_plan'], ['start', 'start'], ['end', 'end'],
  ]) {
    if (task[from] !== undefined) payload[to] = toApiDate(task[from]);
  }
  if (rules.dates?.actualFromPlan === true) {
    for (const [plan, actual] of [['startPlan', 'start'], ['endPlan', 'end']]) {
      if (task[actual] === undefined && task[plan] !== undefined) payload[actual] = toApiDate(task[plan]);
    }
  }
  return { title, payload };
}

function preselectedFor(field, remembered) {
  if (!field.candidates) return remembered ?? field.default;
  const match = remembered === undefined || remembered === null
    ? undefined
    : field.candidates.find((c) => String(c.id) === String(remembered));
  return match ? match.id : (field.default ?? field.candidates[0].id);
}

export function settingsPlan(rules, remembered = {}) {
  const plan = {};
  for (const key of SETTING_FIELDS) {
    const field = rules[key];
    if (!field) continue;
    if (field.mode === 'fixed') {
      plan[key] = { mode: 'fixed', value: field.value };
      continue;
    }
    plan[key] = { mode: 'ask', preselected: preselectedFor(field, remembered[key]), search: field.search };
    if (field.candidates) plan[key].candidates = field.candidates;
  }
  return plan;
}

export function pickRemembered(rules, settings) {
  const picked = {};
  for (const key of SETTING_FIELDS) {
    const field = rules[key];
    if (field?.mode === 'ask' && field.remember && settings[key] !== undefined) {
      picked[key] = settings[key];
    }
  }
  return picked;
}
