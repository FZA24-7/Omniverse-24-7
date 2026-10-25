import { loadConfig } from './config';
import { createPool } from './db';
import { buildApp } from './app';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const app = await buildApp({ pool, config, logger: true });
  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
