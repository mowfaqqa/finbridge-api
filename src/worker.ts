import 'reflect-metadata';
import { logWorker, startJobs } from './jobs/runner';
import { ObjectStorage } from './platform/storage';
import { importHandlers } from './statements/import-worker';

try {
  const storage = new ObjectStorage();
  const runtime = startJobs(importHandlers(storage));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void runtime.stop().then(() => storage.onModuleDestroy()).catch(() => {
      logWorker('worker_shutdown_failed');
      process.exitCode = 1;
    });
  });
  logWorker('worker_started');
} catch (error) {
  logWorker('worker_start_failed', { error: error instanceof Error ? error.message : 'UnknownError' });
  process.exitCode = 1;
}
