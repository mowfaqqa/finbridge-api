import { PrismaClient, type OutboxEvent } from '@prisma/client';
import { Queue, Worker, type RedisOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../platform/config';
import { Problem } from '../platform/problem';
import { lockScope, setContext, type Tx } from '../platform/transaction';

type JobPayload = { eventId: string };
const maxAttempts = 5;
const leaseTime = 120_000;
const recoveryAge = 60_000;

export class TerminalJobError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type Handler = {
  prepare?(event: OutboxEvent, database: PrismaClient): Promise<unknown>;
  apply(event: OutboxEvent, tx: Tx, prepared: unknown): Promise<void>;
  fail(event: OutboxEvent, tx: Tx, code: string): Promise<void>;
};

function connectionOptions(redis: string): RedisOptions {
  const url = new URL(redis);
  return {
    host: url.hostname, port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    connectTimeout: 5_000,
  };
}

export function logWorker(event: string, fields: Record<string, string | number> = {}) {
  process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
}

export function startJobs(handlers: Record<string, Handler>) {
  const config = readConfig();
  if (!config.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required for the worker');
  const database = new PrismaClient({ datasourceUrl: config.WORKER_DATABASE_URL });
  const connection = connectionOptions(config.REDIS_URL);
  const queue = new Queue<JobPayload, void, 'run', JobPayload, void, 'run'>('finbridge-jobs', {
    connection: { ...connection, maxRetriesPerRequest: 1, enableOfflineQueue: false },
  });
  let stopped = false;

  async function relay() {
    if (stopped) return;
    try {
      await database.$transaction(async (tx) => {
        const events = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM outbox_events
          WHERE completed_at IS NULL AND (delivered_at IS NULL OR delivered_at < now() - interval '1 second' * ${recoveryAge / 1000})
          ORDER BY created_at, id LIMIT 20 FOR UPDATE SKIP LOCKED`;
        for (const { id } of events) {
          const existing = await queue.getJob(id);
          const state = await existing?.getState();
          if (state === 'completed' || state === 'failed') await existing?.remove();
          await queue.add('run', { eventId: id }, {
            jobId: id, attempts: maxAttempts, backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },
            removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 },
          });
          await tx.outboxEvent.update({ where: { id }, data: { deliveredAt: new Date() } });
        }
      }, { timeout: 15_000 });
    } catch (error) {
      logWorker('outbox_relay_error', { error: error instanceof Error ? error.name : 'UnknownError' });
    } finally {
      if (!stopped) timer = setTimeout(() => { void relay(); }, 700);
    }
  }

  const worker = new Worker<JobPayload, void, 'run'>('finbridge-jobs', async (job) => {
    const event = await database.outboxEvent.findUnique({ where: { id: job.data.eventId } });
    if (!event || event.completedAt) return;
    const leaseToken = randomUUID();
    const run = await database.$transaction(async (tx) => {
      await setContext(tx, event.actorId, event.tenantId);
      await lockScope(tx, `job/${event.id}`);
      const existing = await tx.jobRun.findUnique({ where: { eventId: event.id } });
      if (existing?.completedAt || (existing?.leaseUntil && existing.leaseUntil > new Date())) return null;
      const leaseUntil = new Date(Date.now() + leaseTime);
      return tx.jobRun.upsert({
        where: { eventId: event.id }, create: { eventId: event.id, tenantId: event.tenantId, leaseToken, leaseUntil, attempts: 1 },
        update: { leaseToken, leaseUntil, attempts: { increment: 1 } },
      });
    });
    if (!run) return;
    const handler = handlers[event.kind];
    if (!handler) throw new Error('Unknown job type');

    const finalize = async (error?: unknown, prepared?: unknown) => database.$transaction(async (tx) => {
      await setContext(tx, event.actorId, event.tenantId);
      await lockScope(tx, `job/${event.id}`);
      const current = await tx.jobRun.findUniqueOrThrow({ where: { eventId: event.id } });
      if (current.completedAt || current.leaseToken !== leaseToken) return;
      if (!error) await handler.apply(event, tx, prepared);
      let failure: string | undefined;
      if (error instanceof TerminalJobError || error instanceof Problem) failure = error.code;
      else if (error && run.attempts >= maxAttempts) failure = 'JOB_RETRIES_EXHAUSTED';
      const completedAt = !error || failure ? new Date() : null;
      if (failure) await handler.fail(event, tx, failure);
      await tx.jobRun.update({
        where: { eventId: event.id }, data: { completedAt, failureCode: failure, leaseToken: null, leaseUntil: null },
      });
      if (completedAt) await tx.outboxEvent.update({ where: { id: event.id }, data: { completedAt } });
    }, { timeout: 30_000 });

    try {
      if (run.attempts > maxAttempts) throw new TerminalJobError('JOB_RETRIES_EXHAUSTED');
      const prepared = await handler.prepare?.(event, database);
      await finalize(undefined, prepared);
      logWorker('job_completed', { job: event.kind, requestId: event.requestId, attempts: run.attempts });
    } catch (error) {
      await finalize(error);
      const safeCode = error instanceof TerminalJobError || error instanceof Problem ? error.code : 'JOB_TRANSIENT_ERROR';
      logWorker('job_failed', { job: event.kind, requestId: event.requestId, code: safeCode, attempts: run.attempts });
      if (!(error instanceof TerminalJobError) && !(error instanceof Problem)) throw new Error(safeCode);
    }
  }, { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 2, lockDuration: leaseTime });

  const logQueueError = (error: Error) => logWorker('queue_error', { error: error.name });
  queue.on('error', logQueueError);
  worker.on('error', logQueueError);
  let timer: NodeJS.Timeout | undefined;
  void queue.waitUntilReady().then(() => relay()).catch(() => {
    if (!stopped) timer = setTimeout(() => { void relay(); }, 1_000);
  });

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await worker.close();
      await queue.close();
      await database.$disconnect();
    },
  };
}
