import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Problem } from './problem';

export type Tx = Prisma.TransactionClient;

export async function setContext(tx: Tx, actorId: string, tenantId?: string) {
  await tx.$queryRaw`SELECT set_config('app.actor_id', ${actorId}, true),
    set_config('app.tenant_id', ${tenantId ?? ''}, true)`;
}

function canonical(value: Prisma.InputJsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === null ? 'null' : canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Prisma.InputJsonObject;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${object[key] == null ? 'null' : canonical(object[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function lockScope(tx: Tx, scope: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
}

export function requestId(request: Request) {
  return String(request.res?.getHeader('x-request-id'));
}

export function mutationKey(request: Request) {
  const key = request.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
    throw new Problem(422, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key is required');
  }
  return key;
}

export async function idempotent<T extends Prisma.InputJsonValue>(
  tx: Tx, actorId: string, tenantId: string | null, operation: string,
  key: string, input: Prisma.InputJsonValue, perform: () => Promise<T>,
) {
  const scope = `${actorId}/${tenantId ?? 'global'}/${operation}`;
  const requestHash = digest(canonical(input));
  await lockScope(tx, `idempotency/${scope}/${key}`);
  const where = { scope_key: { scope, key } };
  const existing = await tx.idempotencyRecord.findUnique({ where });
  if (existing && existing.expiresAt > new Date()) {
    if (existing.requestHash !== requestHash) {
      throw new Problem(409, 'IDEMPOTENCY_KEY_REUSED', 'The key was already used with a different request');
    }
    return existing.outcome as T;
  }
  if (existing) await tx.idempotencyRecord.delete({ where });
  const outcome = await perform();
  await tx.idempotencyRecord.create({
    data: { scope, key, requestHash, actorId, tenantId, outcome, expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return outcome;
}

export async function audit(
  tx: Tx, tenantId: string, actorId: string, requestId: string, action: string,
  resourceId: string, version?: number, metadata: Prisma.InputJsonObject = {},
) {
  await tx.auditEvent.create({ data: { tenantId, actorId, requestId, action, resourceId, version, metadata } });
}
