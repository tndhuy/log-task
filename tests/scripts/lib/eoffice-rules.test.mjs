import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RulesError, REQUIRED_FLAG_DEFAULTS, validateRules, renderName, toApiDate,
  buildInsertPayload, settingsPlan, pickRemembered,
} from '../../../skills/log-task/scripts/lib/eoffice-rules.mjs';

const rules = () => ({
  nameTemplate: '[NVG.ITD - CDS Tập Đoàn] - One Nova - {layer} - [{layer}] {summary}',
  layer: { mode: 'fixed', value: 'BE' },
  parent: { mode: 'ask', search: 'OneNova -P', remember: true },
  owner: { mode: 'ask', default: 'Trần Nguyễn Đang Huy', remember: true },
  assignees: { mode: 'ask', default: ['Trần Nguyễn Đang Huy'], remember: true },
  followers: { mode: 'fixed', value: [] },
  done: { status: 'REVIEW' },
});
const settings = () => ({
  parent: 2089469,
  owner: 'Trần Nguyễn Đang Huy',
  assignees: ['Trần Nguyễn Đang Huy', 'Hoàng Văn Châu'],
  followers: [],
});
const project = { ref: '1456', id: '3869' };
const task = () => ({
  summary: 'Admin broadcast notification: endpoint, FCM topic',
  startPlan: '2026-10-06', endPlan: '2026-10-09', start: '2026-10-06', end: '2026-10-08',
});
const build = (t = task(), r = rules(), s = settings()) =>
  buildInsertPayload(t, { rules: r, project, settings: s });

test('validateRules accepts a complete rules object', () => {
  assert.equal(validateRules(rules()).layer.value, 'BE');
});

test('validateRules rejects a template without {summary}', () => {
  const r = rules(); r.nameTemplate = 'no summary here';
  assert.throws(() => validateRules(r), RulesError);
});

test('validateRules rejects an unknown template variable', () => {
  const r = rules(); r.nameTemplate = '{summary} {foo}';
  assert.throws(() => validateRules(r), (e) => e instanceof RulesError && e.message.includes('{foo}'));
});

test('validateRules requires rules.layer when the template uses {layer}', () => {
  const r = rules(); delete r.layer;
  assert.throws(() => validateRules(r), (e) => e instanceof RulesError && e.message.includes('layer'));
});

test('validateRules rejects a bad mode and a fixed field without a value', () => {
  const a = rules(); a.owner = { mode: 'sometimes' };
  assert.throws(() => validateRules(a), RulesError);
  const b = rules(); b.followers = { mode: 'fixed' };
  assert.throws(() => validateRules(b), RulesError);
});

test('renderName fills layer and summary', () => {
  assert.equal(renderName('[{layer}] {summary}', { layer: 'BE', summary: 'x' }), '[BE] x');
});

test('renderName throws when a used variable has no value', () => {
  assert.throws(() => renderName('[{layer}] {summary}', { summary: 'x' }), RulesError);
});

test('toApiDate converts ISO dates and rejects bad input', () => {
  assert.equal(toApiDate('2026-10-06'), '06/10/2026');
  assert.throws(() => toApiDate('2026-13-40'), RulesError);
  assert.throws(() => toApiDate('06/10/2026'), RulesError);
});

test('buildInsertPayload renders the title and maps people, parent and project', () => {
  const { title, payload } = build();
  assert.equal(title, '[NVG.ITD - CDS Tập Đoàn] - One Nova - BE - [BE] Admin broadcast notification: endpoint, FCM topic');
  assert.equal(payload.title, title);
  assert.equal(payload.project_id, '1456');
  assert.equal(payload.parent_id, '2089469');
  assert.equal(payload.owner_ids, 'Trần Nguyễn Đang Huy');
  assert.equal(payload.assign_ids, 'Trần Nguyễn Đang Huy,Hoàng Văn Châu');
  assert.equal('status' in payload, false);
});

test('buildInsertPayload converts dates and omits empty followers', () => {
  const { payload } = build();
  assert.equal(payload.start_plan, '06/10/2026');
  assert.equal(payload.end_plan, '09/10/2026');
  assert.equal(payload.start, '06/10/2026');
  assert.equal(payload.end, '08/10/2026');
  assert.equal('follower_ids' in payload, false);
});

test('buildInsertPayload includes the four display-value flags', () => {
  const { payload } = build();
  for (const [k, v] of Object.entries(REQUIRED_FLAG_DEFAULTS)) assert.equal(payload[k], v);
  assert.equal(Object.keys(REQUIRED_FLAG_DEFAULTS).length, 4);
});

test('rules.flags override a default flag', () => {
  const r = rules(); r.flags = { assign_parent_off: '1' };
  assert.equal(build(task(), r).payload.assign_parent_off, '1');
});

test('a per-task layer overrides the fixed layer', () => {
  const t = { ...task(), layer: 'Mobile' };
  assert.match(build(t).title, / - Mobile - \[Mobile\] /);
});

test('payload never contains a key that ends in _code', () => {
  const { payload } = build();
  assert.equal(Object.keys(payload).some((k) => k.endsWith('_code') || k === 'code'), false);
});

test('a blank summary is rejected', () => {
  assert.throws(() => build({ ...task(), summary: '   ' }), (e) => e instanceof RulesError && e.message.includes('summary'));
});

test('a missing parent is rejected', () => {
  const s = settings(); delete s.parent;
  assert.throws(() => build(task(), rules(), s), (e) => e instanceof RulesError && e.message.includes('parent'));
});

test('settingsPlan prefers remembered values over the configured default', () => {
  const plan = settingsPlan(rules(), { owner: 'Remembered Owner', parent: 2089469 });
  assert.deepEqual(plan.owner, { mode: 'ask', preselected: 'Remembered Owner', search: undefined });
  assert.deepEqual(plan.parent, { mode: 'ask', preselected: 2089469, search: 'OneNova -P' });
  assert.deepEqual(plan.assignees.preselected, ['Trần Nguyễn Đang Huy']);
  assert.deepEqual(plan.followers, { mode: 'fixed', value: [] });
});

test('pickRemembered keeps only ask fields with remember true', () => {
  const r = rules(); r.assignees.remember = false;
  assert.deepEqual(pickRemembered(r, settings()), { parent: 2089469, owner: 'Trần Nguyễn Đang Huy' });
});

test('validateRules rejects flags keys outside the allowlist', () => {
  for (const flags of [{ parent_id: '1' }, { title: 'x' }, { percent: '100' }, { foo_code: 'x' }]) {
    const key = Object.keys(flags)[0];
    assert.throws(() => validateRules({ ...rules(), flags }),
      (e) => e instanceof RulesError && e.message.includes(key));
  }
});

test('validateRules accepts allowlisted flags and rejects non-string values or non-objects', () => {
  const flags = { assign_parent_off: '1', progress_type: 'TIMEFINISH', method: 'NORMAL' };
  assert.deepEqual(validateRules({ ...rules(), flags }).flags, flags);
  assert.throws(() => validateRules({ ...rules(), flags: { assign_parent_off: 1 } }), RulesError);
  assert.throws(() => validateRules({ ...rules(), flags: ['x'] }), RulesError);
  assert.throws(() => validateRules({ ...rules(), flags: null }), RulesError);
});

test('validateRules restricts done.status to the verified statuses', () => {
  assert.equal(validateRules({ ...rules(), done: { status: 'REVIEW' } }).done.status, 'REVIEW');
  assert.throws(() => validateRules({ ...rules(), done: { status: 'COMPLETED' } }), RulesError);
  assert.throws(() => validateRules({ ...rules(), done: { status: 'DONE' } }),
    (e) => e instanceof RulesError && e.message.includes('done.status'));
});

test('validateRules requires rules.layer to be fixed', () => {
  assert.throws(() => validateRules({ ...rules(), layer: { mode: 'ask' } }),
    (e) => e instanceof RulesError
      && e.message === 'rules.layer must be fixed (set a per-task "layer" in the batch to vary it)');
});

const candidates = () => [
  { id: 2089469, label: 'OneNova -P5- Development' },
  { id: '2087612', label: '05. One Nova - Phase 5' },
];
const withCandidates = (list = candidates()) => {
  const r = rules();
  r.parent = { mode: 'ask', remember: true, candidates: list };
  return r;
};

test('validateRules accepts parent candidates without search', () => {
  assert.equal(validateRules(withCandidates()).parent.candidates.length, 2);
});

test('validateRules rejects invalid parent candidates', () => {
  for (const bad of ['x', [], [{ label: 'no id' }], [{ id: 1 }], [{ id: 1, label: '' }], [{ id: '', label: 'a' }]]) {
    assert.throws(() => validateRules(withCandidates(bad)), RulesError, JSON.stringify(bad));
  }
});

test('validateRules rejects candidates on fields other than parent', () => {
  const r = rules();
  r.owner = { mode: 'ask', candidates: candidates() };
  assert.throws(() => validateRules(r),
    (e) => e instanceof RulesError && e.message.includes('candidates is only supported on rules.parent'));
});

test('settingsPlan returns candidates and preselects the first id by default', () => {
  const entry = settingsPlan(withCandidates()).parent;
  assert.deepEqual(entry.candidates, candidates());
  assert.equal(entry.preselected, 2089469);
});

test('settingsPlan: remembered wins over default and first candidate', () => {
  assert.equal(settingsPlan(withCandidates(), { parent: 2087612 }).parent.preselected, '2087612');
});

test('settingsPlan: default wins over the first candidate', () => {
  const r = withCandidates(); r.parent.default = '2087612';
  assert.equal(settingsPlan(r).parent.preselected, '2087612');
});

test('settingsPlan entry without candidates has no candidates key', () => {
  assert.equal('candidates' in settingsPlan(rules()).parent, false);
});

test('validateRules rejects malformed candidate ids, labels, duplicates', () => {
  const bads = [
    [{ id: 0, label: 'a' }], [{ id: -1, label: 'a' }], [{ id: NaN, label: 'a' }],
    [{ id: '  ', label: 'a' }], [{ id: 1, label: '   ' }],
    [{ id: 1, label: 'a' }, { id: '1', label: 'b' }],
  ];
  for (const bad of bads) {
    assert.throws(() => validateRules(withCandidates(bad)), RulesError, JSON.stringify(bad));
  }
});

test('validateRules rejects candidates on a fixed parent', () => {
  const r = rules();
  r.parent = { mode: 'fixed', value: 1, candidates: candidates() };
  assert.throws(() => validateRules(r),
    (e) => e instanceof RulesError && e.message.includes('rules.parent candidates require mode "ask"'));
});

test('settingsPlan: stale remembered parent falls back to default, then first candidate', () => {
  assert.equal(settingsPlan(withCandidates(), { parent: 999 }).parent.preselected, 2089469);
  const r = withCandidates(); r.parent.default = '2087612';
  assert.equal(settingsPlan(r, { parent: 999 }).parent.preselected, '2087612');
});

test('settingsPlan: remembered matches candidate id across number/string and returns its own id', () => {
  assert.equal(settingsPlan(withCandidates(), { parent: '2089469' }).parent.preselected, 2089469);
  assert.equal(settingsPlan(withCandidates(), { parent: 2087612 }).parent.preselected, '2087612');
});

test('settingsPlan: field without candidates still prefers remembered', () => {
  assert.equal(settingsPlan(rules(), { parent: 555 }).parent.preselected, 555);
});

const withDates = (dates) => ({ ...rules(), dates });
const planOnly = () => ({ summary: 'x', startPlan: '2026-10-06', endPlan: '2026-10-09' });

test('actualFromPlan copies plan dates into start/end', () => {
  const { payload } = build(planOnly(), withDates({ actualFromPlan: true }));
  assert.equal(payload.start, payload.start_plan);
  assert.equal(payload.end, payload.end_plan);
  assert.equal(payload.start, '06/10/2026');
  assert.equal(payload.end, '09/10/2026');
});

test('actualFromPlan: an explicit task.start wins', () => {
  const { payload } = build({ ...planOnly(), start: '2026-10-07' }, withDates({ actualFromPlan: true }));
  assert.equal(payload.start, '07/10/2026');
  assert.equal(payload.end, '09/10/2026');
});

test('without actualFromPlan no start/end keys are added', () => {
  for (const r of [rules(), withDates({ actualFromPlan: false })]) {
    const { payload } = build(planOnly(), r);
    assert.equal('start' in payload, false);
    assert.equal('end' in payload, false);
  }
});

test('validateRules rejects invalid dates shapes', () => {
  for (const dates of ['x', ['actualFromPlan'], { other: true }, { actualFromPlan: 'yes' }, null]) {
    assert.throws(() => validateRules(withDates(dates)), RulesError, JSON.stringify(dates));
  }
  assert.equal(validateRules(withDates({ actualFromPlan: true })).dates.actualFromPlan, true);
});

test('buildInsertPayload rejects empty assignees', () => {
  const { rules: r, project, settings } = { rules: rules(), project: { ref: '1456' }, settings: { parent: 1, owner: 'a', assignees: [] } };
  assert.throws(() => buildInsertPayload(task(), { rules: r, project, settings }),
    (e) => e instanceof RulesError && e.message.includes('assignees'));
});
