import { createApp, createOpenApi } from './app';

async function exportOpenApi() {
  const app = await createApp(true);
  try {
    process.stdout.write(JSON.stringify(createOpenApi(app), null, 2) + '\n');
  } finally {
    await app.close();
  }
}

void exportOpenApi().catch(() => {
  process.stderr.write('OpenAPI export failed\n');
  process.exitCode = 1;
});
