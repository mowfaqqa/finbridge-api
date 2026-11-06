import type { ImportBatch, ImportRow, OutboxEvent, Prisma } from '@prisma/client';
import { fromDateOnly } from '../financial/money';
import { hasJobAuthority } from '../jobs/authority';
import { type Handler, TerminalJobError } from '../jobs/runner';
import type { ObjectStorage } from '../platform/storage';
import { audit, lockScope, setContext, type Tx } from '../platform/transaction';
import { CsvProblem, parseStatement, type Mapping, type ParsedRow } from './csv';
import { getBatch } from './imports';

type Classified = ParsedRow & {
  ambiguous: boolean; previousCount: number; disposition: 'KEEP' | 'DUPLICATE' | 'REVIEW'; error?: string | null;
};

function eligible(batch: ImportBatch, event: OutboxEvent) {
  return batch.version === event.targetVersion && batch.state === (event.kind === 'IMPORT_VALIDATE' ? 'VALIDATING' : 'COMMIT_QUEUED');
}

async function authorize(tx: Tx, event: OutboxEvent, accountId: string, serial: boolean) {
  const authorized = await hasJobAuthority(tx, event, serial);
  const account = await tx.bankAccount.findFirst({ where: { tenantId: event.tenantId, id: accountId, active: true }, select: { id: true } });
  if (!authorized || !account) throw new TerminalJobError('IMPORT_PERMISSION_REVOKED');
}

async function classify(tx: Tx, batch: ImportBatch, source: ParsedRow[]): Promise<Classified[]> {
  const { tenantId, accountId } = batch;
  const fingerprints = [...new Set(source.flatMap((row) => row.fingerprint ? [row.fingerprint] : []))];
  const stableIds = [...new Set(source.flatMap((row) => row.sourceId ? [row.sourceId] : []))];
  const previous = await tx.statementEntry.groupBy({
    by: ['fingerprint'], where: { tenantId, accountId, fingerprint: { in: fingerprints } }, _count: { _all: true },
  });
  const existingIds = await tx.statementEntry.findMany({
    where: { tenantId, accountId, sourceId: { in: stableIds } }, select: { sourceId: true, contentHash: true },
  });
  const byStableId = new Map(existingIds.map((row) => [row.sourceId!, row.contentHash]));
  const seen = new Map<string, number>();
  for (const row of source) {
    if (row.fingerprint) seen.set(row.fingerprint, (seen.get(row.fingerprint) ?? 0) + 1);
  }
  const counts = new Map(previous.map((row) => [row.fingerprint, row._count._all]));
  return source.map((row) => {
    const base = { ...row, ambiguous: false, previousCount: 0, disposition: 'KEEP' as const };
    if (row.error || !row.fingerprint || !row.contentHash) return base;
    if (row.sourceId) {
      const existing = byStableId.get(row.sourceId);
      if (existing === undefined) {
        byStableId.set(row.sourceId, row.contentHash);
        return base;
      }
      if (existing !== row.contentHash) return { ...base, error: 'This source transaction ID has different fields. Correct the file before committing.' };
      return { ...base, disposition: 'DUPLICATE' };
    }
    const previousCount = counts.get(row.fingerprint) ?? 0;
    const ambiguous = previousCount > 0 || (seen.get(row.fingerprint) ?? 0) > 1;
    if (!ambiguous) return base;
    const unchanged = row.ambiguous && row.previousCount === previousCount && row.disposition;
    return { ...base, ambiguous, previousCount, disposition: unchanged || 'REVIEW' };
  });
}

function statusCounts(rows: Classified[]) {
  return {
    rowCount: rows.length,
    errorCount: rows.filter((row) => !!row.error).length,
    reviewCount: rows.filter((row) => row.disposition === 'REVIEW').length,
  };
}

async function setBatch(tx: Tx, batch: ImportBatch, data: Prisma.ImportBatchUpdateInput) {
  return tx.importBatch.update({
    where: { tenantId_id: { tenantId: batch.tenantId, id: batch.id } },
    data: { ...data, version: { increment: 1 } },
  });
}

export function importHandlers(storage: ObjectStorage): Record<string, Handler> {
  const fail: Handler['fail'] = async (event, tx, code) => {
    const batch = await getBatch(tx, event.tenantId, event.targetId, true);
    if (eligible(batch, event)) await setBatch(tx, batch, { state: 'FAILED', problemCode: code, failedStage: event.kind });
  };

  return {
    IMPORT_VALIDATE: {
      fail,
      async prepare(event, database) {
        const batch = await database.$transaction(async (tx) => {
          await setContext(tx, event.actorId, event.tenantId);
          const candidate = await getBatch(tx, event.tenantId, event.targetId);
          if (!eligible(candidate, event)) return null;
          await authorize(tx, event, candidate.accountId, false);
          return candidate;
        });
        if (!batch) return null;
        if (!batch.objectKey || !batch.mapping || !batch.coverageStart || !batch.coverageEnd) {
          throw new TerminalJobError('IMPORT_INPUT_UNAVAILABLE');
        }
        const { body } = await storage.open(batch.objectKey);
        try {
          return await parseStatement(body, batch.accountId, batch.mapping as Mapping, batch.headers,
            fromDateOnly(batch.coverageStart), fromDateOnly(batch.coverageEnd));
        } catch (error) {
          if (error instanceof CsvProblem) throw new TerminalJobError(error.code);
          throw error;
        }
      },
      async apply(event, tx, prepared) {
        const batch = await getBatch(tx, event.tenantId, event.targetId, true);
        if (!eligible(batch, event) || !prepared) return;
        await authorize(tx, event, batch.accountId, true);
        const oldRows = await tx.importRow.findMany({
          where: { tenantId: event.tenantId, batchId: batch.id, ambiguous: true },
          select: { rowNumber: true, fingerprint: true, disposition: true, previousCount: true },
        });
        const byRow = new Map(oldRows.map((row) => [row.rowNumber, row]));
        const draft = (prepared as ParsedRow[]).map((row) => {
          const previous = byRow.get(row.rowNumber);
          if (!previous || previous.fingerprint !== row.fingerprint) return row;
          return { ...row, ambiguous: true, disposition: previous.disposition, previousCount: previous.previousCount };
        });
        const rows = await classify(tx, batch, draft);
        await tx.importRow.deleteMany({ where: { tenantId: event.tenantId, batchId: batch.id } });
        await tx.importRow.createMany({ data: rows.map((row) => ({ ...row, tenantId: event.tenantId, batchId: batch.id })) });
        await setBatch(tx, batch, { state: 'REVIEW', ...statusCounts(rows), problemCode: null });
      },
    },
    IMPORT_COMMIT: {
      fail,
      async apply(event, tx) {
        const batch = await getBatch(tx, event.tenantId, event.targetId, true);
        if (!eligible(batch, event)) return;
        const { tenantId, accountId } = batch;
        await authorize(tx, event, accountId, true);
        await lockScope(tx, `statement-account/${tenantId}/${accountId}`);
        const previous = await tx.importBatch.findFirst({
          where: { tenantId, accountId, rawDigest: batch.rawDigest, state: 'COMMITTED' },
        });
        if (previous) {
          if (previous.mappingDigest !== batch.mappingDigest) throw new TerminalJobError('FILE_ALREADY_COMMITTED');
          await setBatch(tx, batch, { state: 'DISCARDED', replayId: previous.id });
          return;
        }
        const current = await tx.importRow.findMany({ where: { tenantId, batchId: batch.id }, orderBy: { rowNumber: 'asc' } });
        const rows = await classify(tx, batch, current.map(({ tenantId: _, batchId: __, ...row }) => row));
        const changed = rows.filter((row, index) => differs(row, current[index]));
        const counts = statusCounts(rows);
        if (changed.length || counts.errorCount || counts.reviewCount) {
          await tx.$executeRaw`
            UPDATE import_rows AS row SET
              ambiguous = change.ambiguous, previous_count = change."previousCount",
              disposition = change.disposition::row_disposition, error = change.error
            FROM jsonb_to_recordset(${JSON.stringify(changed.map(({ id, ambiguous, previousCount, disposition, error }) =>
              ({ id, ambiguous, previousCount, disposition, error: error ?? null })))}::jsonb)
              AS change(id uuid, ambiguous boolean, "previousCount" integer, disposition text, error text)
            WHERE row.tenant_id = ${tenantId}::uuid AND row.batch_id = ${batch.id}::uuid AND row.id = change.id`;
          await setBatch(tx, batch, { state: 'REVIEW', problemCode: 'IMPORT_PREVIEW_STALE', ...counts });
          return;
        }
        const accepted = rows.filter((row) => row.disposition === 'KEEP');
        await tx.statementEntry.createMany({ data: accepted.map((row) => ({
          tenantId, accountId, batchId: batch.id, importRowId: row.id!, bookingDate: row.bookingDate!,
          description: row.description!, reference: row.reference, sourceId: row.sourceId,
          amountKobo: row.amountKobo!, fingerprint: row.fingerprint!, contentHash: row.contentHash!,
        })) });
        const published = await setBatch(tx, batch, { state: 'COMMITTED', acceptedCount: accepted.length, committedAt: new Date() });
        await audit(tx, tenantId, event.actorId, event.requestId, 'import_committed', batch.id, published.version, { rowCount: accepted.length });
      },
    },
  };
}

function differs(row: Classified, original: ImportRow) {
  return row.ambiguous !== original.ambiguous || row.previousCount !== original.previousCount
    || row.disposition !== original.disposition || (row.error ?? null) !== original.error;
}
