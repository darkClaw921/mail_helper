// Standalone init-db script: create DB file + apply schema.
// Usage: npm run init-db

import { db, closeDb } from './index.js';

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name)
  .filter((n) => !n.startsWith('sqlite_'));

console.log(`[init-db] database ready, tables: ${tables.join(', ')}`);
closeDb();
