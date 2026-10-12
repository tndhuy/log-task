import * as fs from 'node:fs';
import * as path from 'node:path';
import { ledgerKey } from './resolve-project.mjs';

export function planLedgerMigration(resolved, { skillDir, exists = fs.existsSync }) {
  if (resolved.mode === 'standalone') {
    return { moves: [], legacyRoot: null };
  }
  const oldLedger = (absPath) => path.join(skillDir, 'ledger', `${ledgerKey(absPath)}.json`);

  const moves = [];
  for (const target of resolved.targets) {
    const from = oldLedger(target.path);
    if (exists(from)) {
      moves.push({ from, to: target.ledgerPath, conflict: exists(target.ledgerPath) });
    }
  }
  const legacyRoot = oldLedger(resolved.groupRoot);
  return { moves, legacyRoot: exists(legacyRoot) ? legacyRoot : null };
}
