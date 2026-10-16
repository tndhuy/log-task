import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataDir } from '../../../skills/log-task/scripts/lib/data-dir.mjs';

const base = { home: '/home/u', skillDir: '/skill', exists: () => false };

test('LOG_TASK_HOME wins over everything', () => {
  const env = { LOG_TASK_HOME: '/data/lt', XDG_CONFIG_HOME: '/xdg' };
  assert.equal(resolveDataDir({ ...base, env, exists: () => true }), '/data/lt');
});

test('an existing projects.json beside the skill keeps working', () => {
  const exists = (p) => p === '/skill/projects.json';
  assert.equal(resolveDataDir({ ...base, env: {}, exists }), '/skill');
});

test('defaults to ~/.config/log-task', () => {
  assert.equal(resolveDataDir({ ...base, env: {} }), '/home/u/.config/log-task');
});

test('XDG_CONFIG_HOME is honoured', () => {
  assert.equal(resolveDataDir({ ...base, env: { XDG_CONFIG_HOME: '/xdg' } }), '/xdg/log-task');
});
