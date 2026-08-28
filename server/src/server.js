import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { buildApp } from './app.js';
import { startCleanup } from './cleanup.js';

const config = loadConfig(process.env);
const { db, mediaDir } = createDb(config.dataDir);
const app = buildApp({ config, db, mediaDir });

startCleanup(db, mediaDir);

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
