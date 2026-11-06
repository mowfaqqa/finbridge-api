import { createApp } from './app';
import { readConfig } from './platform/config';

async function bootstrap() {
  const config = readConfig();
  const app = await createApp();
  await app.listen(config.API_PORT, config.API_HOST);
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.message}\n` : 'API could not start\n');
  process.exitCode = 1;
});
