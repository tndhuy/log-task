#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const action = process.argv[2];
const sessionPath = process.env.EOFFICE_SESSION_PATH
  || path.join(scriptDir, '..', '.eoffice-session.json');

if (!['create-task', 'report-progress'].includes(action)) {
  console.error('Usage: node scripts/discover-eoffice-form.mjs <create-task|report-progress>');
  process.exit(1);
}
if (!fs.existsSync(sessionPath)) {
  console.error(`No eOffice session found at ${sessionPath}. Run eoffice-session.mjs first.`);
  process.exit(3);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run npm install && npx playwright install chromium.');
  process.exit(4);
}

const instructions = action === 'create-task'
  ? 'Navigate to Project → the target project → Tasks → Add task → Add task.'
  : 'Navigate to Project → the target project → Tasks → open a task → Report.';
let browser;
try {
  browser = await chromium.launch({ headless: false });
} catch (error) {
  console.error(`Could not launch Playwright Chromium: ${error.message}. Run npx playwright install chromium.`);
  process.exit(4);
}
try {
  const context = await browser.newContext({ storageState: sessionPath });
  const page = await context.newPage();
  await page.goto('https://eoffice.novagroup.vn/user?customMenu=work-project-project', {
    waitUntil: 'domcontentloaded',
  });
  if (page.url().includes('/login')) {
    console.error('eOffice redirected to login. Re-run eoffice-session.mjs.');
    process.exitCode = 3;
  } else {
    console.log(instructions);
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    await readline.question('When the target form is open, press Enter to inspect it: ');
    readline.close();

    const controls = await page.locator('input, textarea, [contenteditable="true"], button, a').evaluateAll((elements) => (
      elements
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .map((element, index) => ({
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          accessibleName: element.getAttribute('aria-label') || element.getAttribute('title'),
          placeholder: element.getAttribute('placeholder'),
          type: element.getAttribute('type'),
          text: (element.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          disabled: element.matches(':disabled'),
        }))
    ));
    console.log(JSON.stringify({ action, url: page.url(), controls }, null, 2));
  }
} finally {
  await browser.close();
}
