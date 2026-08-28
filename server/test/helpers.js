import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db.js';

// Creates a fresh SQLite DB in a unique temp directory for a single test.
// Every test that touches the DB should call this rather than sharing state.
export function makeTestDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lazybutts-test-'));
  const { db, mediaDir } = createDb(dataDir);
  return { db, mediaDir, dataDir };
}
