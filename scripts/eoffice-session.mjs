#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCookies, CookieImportError } from './lib/cookie-import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, '..', '.eoffice-session.json');
const DOMAIN = 'eoffice.novagroup.vn';

export function buildStorageState(cookies) {
  return { cookies, origins: [] };
}

function main() {
  let result;
  try {
    result = importCookies([DOMAIN]);
  } catch (err) {
    if (err instanceof CookieImportError) {
      console.error(`Could not import eOffice session: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  if (result.count === 0) {
    console.error(`No ${DOMAIN} session found in Chrome. Log into eOffice in Chrome, then re-run this script.`);
    process.exit(1);
  }
  fs.writeFileSync(SESSION_PATH, JSON.stringify(buildStorageState(result.cookies), null, 2));
  console.log(`Saved eOffice session (${result.count} cookie(s)) to ${SESSION_PATH}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
