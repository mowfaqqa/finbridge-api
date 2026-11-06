import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiConsumes, ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { ImportBatch, ImportRow } from '@prisma/client';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { dateOnly, fromDateOnly, toDateOnly } from '../financial/money';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { readConfig } from '../platform/config';
import { ApiInput, ApiOutput, dateTime, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { ObjectStorage } from '../platform/storage';
import { audit, digest, idempotent, lockScope, mutationKey, requestId, type Tx } from '../platform/transaction';
import { csvMapping, CsvProblem, maxBytes, readHeaders, validateColumns } from './csv';

const states = z.enum(['UPLOADED', 'VALIDATING', 'REVIEW', 'COMMIT_QUEUED', 'COMMITTED', 'FAILED', 'DISCARDED']);
const createBody = z.object({
  accountId: uuid, filename: z.string().trim().min(1).max(120).regex(/^[^/\\\x00-\x1f]+\.csv$/i),
  bytes: z.number().int().min(1).max(maxBytes),
}).strict();
const validateBody = z.object({
  mapping: csvMapping, coverageStart: dateOnly, coverageEnd: dateOnly, version,
}).strict().refine((input) => input.coverageStart <= input.coverageEnd, { path: ['coverageEnd'], message: 'Coverage end must be on or after its start' });
const changeBody = z.object({ version }).strict();
const discardBody = changeBody.extend({ reason: z.string().trim().min(1).max(250) });
const resolveBody = z.object({
  version, choices: z.array(z.object({ rowId: uuid, decision: z.enum(['KEEP', 'DUPLICATE']) }).strict()).min(1).max(100),
}).strict().refine((input) => new Set(input.choices.map((choice) => choice.rowId)).size === input.choices.length, {
  path: ['choices'], message: 'Select one choice per row',
});
const batchView = z.object({
  id: uuid, accountId: uuid, filename: z.string(), bytes: z.number(), headers: z.array(z.string()), uploaded: z.boolean(),
  mapping: csvMapping.nullable(), coverageStart: dateOnly.nullable(), coverageEnd: dateOnly.nullable(),
  state: states, version, acceptedCount: z.number(), rowCount: z.number(), errorCount: z.number(), reviewCount: z.number(),
  problemCode: z.string().nullable(), failedStage: z.string().nullable(), committedAt: dateTime.nullable(),
});
const jobView = z.object({ id: uuid, statusUrl: z.string(), state: states });
const rowView = z.object({
  id: uuid, rowNumber: z.number(), bookingDate: dateOnly.nullable(), description: z.string().nullable(),
  reference: z.string().nullable(), sourceId: z.string().nullable(), amountKobo: z.string().nullable(),
  currency: z.literal('NGN'), ambiguous: z.boolean(), previousCount: z.number(),
  disposition: z.enum(['KEEP', 'DUPLICATE', 'REVIEW']), error: z.string().nullable(),
});
const rowsQuery = listQuery.extend({ filter: z.enum(['all', 'errors', 'duplicates']).default('all') })
  .refine((input) => !(input.before && input.after), { message: 'Use either the next or previous cursor' });
const ApiKey = () => ApiHeader({ name: 'Idempotency-Key', required: true });
const missing = () => new Problem(404, 'IMPORT_NOT_FOUND', 'Statement import unavailable');
const uploadLifetime = 15 * 60_000;
const url = (tenant: string, id: string) => `/api/v1/workspaces/${tenant}/imports/${id}`;
const poll = (batch: Pick<ImportBatch, 'tenantId' | 'id' | 'state'>) => ({
  id: batch.id, statusUrl: url(batch.tenantId, batch.id), state: batch.state,
});

const view = (batch: ImportBatch) => ({
  id: batch.id, accountId: batch.accountId, filename: batch.filename, bytes: batch.bytes, headers: batch.headers,
  uploaded: !!batch.objectKey, mapping: batch.mapping as z.output<typeof csvMapping> | null,
  coverageStart: batch.coverageStart ? fromDateOnly(batch.coverageStart) : null,
  coverageEnd: batch.coverageEnd ? fromDateOnly(batch.coverageEnd) : null,
  state: batch.state, version: batch.version, acceptedCount: batch.acceptedCount,
  rowCount: batch.rowCount, errorCount: batch.errorCount, reviewCount: batch.reviewCount,
  problemCode: batch.problemCode, failedStage: batch.failedStage, committedAt: batch.committedAt?.toISOString() ?? null,
});

const renderRow = (row: ImportRow) => ({
  id: row.id, rowNumber: row.rowNumber, bookingDate: row.bookingDate ? fromDateOnly(row.bookingDate) : null,
  description: row.description, reference: row.reference, sourceId: row.sourceId, amountKobo: row.amountKobo?.toString() ?? null,
  currency: 'NGN' as const, ambiguous: row.ambiguous, previousCount: row.previousCount, disposition: row.disposition, error: row.error,
});

export async function getBatch(tx: Tx, tenantId: string, id: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT 1 FROM import_batches WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  const batch = await tx.importBatch.findUnique({ where: { tenantId_id: { tenantId, id } } });
  if (!batch) throw missing();
  return batch;
}

function checkVersion(batch: ImportBatch, expected: number) {
  if (batch.version !== expected) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh the import before making changes');
}

function updateBatch(tx: Tx, batch: ImportBatch, data: Parameters<Tx['importBatch']['update']>[0]['data']) {
  return tx.importBatch.update({
    where: { tenantId_id: { tenantId: batch.tenantId, id: batch.id } }, data: { ...data, version: { increment: 1 } },
  });
}

@Controller('workspaces/:wid/imports')
@ApiTags('statement imports')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class ImportsController {
  private readonly config = readConfig();

  constructor(private readonly workspaces: Workspaces, private readonly storage: ObjectStorage) {}

  @Post()
  @ApiKey()
  @ApiInput(createBody)
  @ApiOutput(201, z.object({ batch: batchView, uploadUrl: z.string(), uploadTicket: z.string(), expiresAt: dateTime }))
  create(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const input = parse(createBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, async (tx) => {
      const result = await idempotent(tx, actor.id, tenantId, 'import.create', mutationKey(req), input, async () => {
        await lockScope(tx, `upload-quota/${tenantId}`);
        if (!await tx.bankAccount.findFirst({ where: { tenantId, id: input.accountId, active: true }, select: { id: true } })) {
          throw new Problem(422, 'ACCOUNT_UNAVAILABLE', 'Choose an active statement account');
        }
        const recent = await tx.importBatch.aggregate({
          where: { tenantId, createdAt: { gt: new Date(Date.now() - 60_000) } }, _count: true,
        });
        if (recent._count >= 10) throw new Problem(429, 'IMPORT_RATE_LIMIT', 'Wait a minute before creating another import');
        const staging = await tx.importBatch.aggregate({
          where: { tenantId, state: { notIn: ['COMMITTED', 'DISCARDED'] }, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
          _sum: { bytes: true },
        });
        if ((staging._sum.bytes ?? 0) + input.bytes > 50 * 1024 * 1024) {
          throw new Problem(429, 'IMPORT_STORAGE_LIMIT', 'Discard unused staged statements before uploading again');
        }
        const batch = await tx.importBatch.create({ data: { tenantId, ...input, createdBy: actor.id } });
        return { id: batch.id };
      });
      const batch = await getBatch(tx, tenantId, result.id);
      return { batch: view(batch), uploadUrl: `${url(tenantId, batch.id)}/upload`, ...this.issueTicket(batch) };
    });
  }

  @Put(':bid/upload')
  @HttpCode(200)
  @ApiConsumes('text/csv')
  @ApiHeader({ name: 'X-Upload-Ticket', required: true })
  @ApiOutput(200, batchView)
  async upload(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('bid') bid: string, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(bid);
    if (!req.is(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream'])) {
      throw new Problem(422, 'CSV_REQUIRED', 'Upload a UTF-8 CSV file');
    }
    const current = await this.workspaces.run(actor, tenantId, financialWriters, (tx) => getBatch(tx, tenantId, id));
    this.checkTicket(current, actor, req.get('x-upload-ticket'));
    if (current.state !== 'UPLOADED') throw new Problem(409, 'UPLOAD_LOCKED', 'This import already has a validation request');
    if (req.get('content-length') && Number(req.get('content-length')) !== current.bytes) {
      throw new Problem(422, 'UPLOAD_SIZE_INVALID', 'The upload size differs from the ticket');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > current.bytes || bytes > maxBytes) throw new Problem(422, 'UPLOAD_SIZE_INVALID', 'The upload size exceeds the ticket');
      chunks.push(value);
    }
    if (bytes !== current.bytes) throw new Problem(422, 'UPLOAD_SIZE_INVALID', 'The upload size differs from the ticket');
    const file = Buffer.concat(chunks, bytes);
    const rawDigest = digest(file);
    let headers: string[];
    try {
      headers = readHeaders(file);
    } catch (error) {
      if (error instanceof CsvProblem) throw new Problem(422, error.code, 'Use a UTF-8 CSV with a valid header row');
      throw error;
    }
    if (current.rawDigest && current.rawDigest !== rawDigest) throw new Problem(409, 'UPLOAD_LOCKED', 'Create a new import to upload a different file');
    const objectKey = `tenants/${tenantId}/imports/${id}/${rawDigest}.csv`;
    await this.storage.put(objectKey, file, 'text/csv');
    return this.workspaces.run(actor, tenantId, financialWriters, async (tx) => {
      const batch = await getBatch(tx, tenantId, id, true);
      if (batch.rawDigest === rawDigest) return view(batch);
      checkVersion(batch, current.version);
      return view(await updateBatch(tx, batch, { objectKey, rawDigest, headers }));
    });
  }

  @Get(':bid')
  @ApiOutput(200, batchView)
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('bid') bid: string) {
    const tenantId = resourceId(wid);
    const id = resourceId(bid);
    return this.workspaces.run(actor, tenantId, undefined, async (tx, role) => {
      const current = await getBatch(tx, tenantId, id);
      const batch = current.replayId ? await getBatch(tx, tenantId, current.replayId) : current;
      if (role === 'VIEWER' && batch.state !== 'COMMITTED') throw missing();
      return view(batch);
    });
  }

  @Get(':bid/rows')
  @ApiListQuery()
  @ApiOutput(200, pageView(rowView))
  rows(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('bid') bid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const id = resourceId(bid);
    const query = parse(rowsQuery, raw);
    return this.workspaces.run(actor, tenantId, undefined, async (tx, role) => {
      const batch = await getBatch(tx, tenantId, id);
      if (role === 'VIEWER' && batch.state !== 'COMMITTED' && !batch.replayId) throw missing();
      const cursor = query.after ?? query.before;
      const direction = query.before ? 'desc' : 'asc';
      const rows = await tx.importRow.findMany({
        where: { tenantId, batchId: batch.replayId ?? id, ...(query.filter === 'errors' && { error: { not: null } }),
          ...(query.filter === 'duplicates' && { ambiguous: true }) },
        orderBy: [{ rowNumber: direction }, { id: direction }], take: query.limit + 1,
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
      });
      return pageResult(rows.map(renderRow), query);
    });
  }

  @Post(':bid/validate')
  @HttpCode(202)
  @ApiKey()
  @ApiInput(validateBody)
  @ApiOutput(202, jobView)
  async validate(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('bid') bid: string, @Body() body: unknown,
    @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenantId = resourceId(wid);
    const id = resourceId(bid);
    const input = parse(validateBody, body);
    const result = await this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'import.validate', mutationKey(req), { id, ...input }, async () => {
        const batch = await getBatch(tx, tenantId, id, true);
        checkVersion(batch, input.version);
        if (!batch.objectKey || !batch.rawDigest || !['UPLOADED', 'REVIEW', 'FAILED'].includes(batch.state)) {
          throw new Problem(409, 'IMPORT_VALIDATION_UNAVAILABLE', 'Upload a file or wait for the current operation');
        }
        if (!validateColumns(input.mapping, batch.headers)) throw new Problem(422, 'CSV_MAPPING_INVALID', 'Select distinct columns from this file');
        const mappingDigest = digest(JSON.stringify(input.mapping));
        const previous = await tx.importBatch.findFirst({
          where: { tenantId, accountId: batch.accountId, rawDigest: batch.rawDigest, state: 'COMMITTED' },
        });
        if (previous) {
          if (previous.mappingDigest !== mappingDigest) throw new Problem(409, 'FILE_ALREADY_COMMITTED', 'This file was committed with a different mapping. Contact support to correct it.');
          await updateBatch(tx, batch, { state: 'DISCARDED', replayId: previous.id });
          return poll(previous);
        }
        const pending = await updateBatch(tx, batch, {
          state: 'VALIDATING', mapping: input.mapping, mappingDigest, coverageStart: toDateOnly(input.coverageStart),
          coverageEnd: toDateOnly(input.coverageEnd), problemCode: null, failedStage: null,
        });
        await tx.outboxEvent.create({ data: { tenantId, targetId: id, targetVersion: pending.version, actorId: actor.id, requestId: requestId(req), kind: 'IMPORT_VALIDATE' } });
        return poll(pending);
      },
    ));
    res.location(result.statusUrl);
    return result;
  }

  @Patch(':bid/resolutions')
  @ApiKey()
  @ApiInput(resolveBody)
  @ApiOutput(200, batchView)
  resolve(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('bid') bid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(bid);
    const input = parse(resolveBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'import.resolutions', mutationKey(req), { id, ...input }, async () => {
        const batch = await getBatch(tx, tenantId, id, true);
        checkVersion(batch, input.version);
        if (batch.state !== 'REVIEW') throw new Problem(409, 'IMPORT_REVIEW_REQUIRED', 'Open the review before resolving rows');
        const targets = await tx.importRow.findMany({
          where: { tenantId, batchId: id, ambiguous: true, error: null, id: { in: input.choices.map((choice) => choice.rowId) } },
          select: { id: true },
        });
        if (targets.length !== input.choices.length) throw new Problem(422, 'ROW_RESOLUTION_INVALID', 'Resolve only the ambiguous rows in this batch');
        for (const decision of ['KEEP', 'DUPLICATE'] as const) {
          await tx.importRow.updateMany({
            where: { tenantId, batchId: id, id: { in: input.choices.filter((choice) => choice.decision === decision).map((choice) => choice.rowId) } },
            data: { disposition: decision },
          });
        }
        const reviewCount = await tx.importRow.count({ where: { tenantId, batchId: id, disposition: 'REVIEW' } });
        await audit(tx, tenantId, actor.id, requestId(req), 'import_resolutions_saved', id, batch.version + 1, { changedCount: targets.length });
        return view(await updateBatch(tx, batch, { reviewCount, problemCode: null }));
      },
    ));
  }

  @Post(':bid/commit')
  @HttpCode(202)
  @ApiKey()
  @ApiInput(changeBody)
  @ApiOutput(202, jobView)
  async commit(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('bid') bid: string, @Body() body: unknown,
    @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenantId = resourceId(wid);
    const id = resourceId(bid);
    const input = parse(changeBody, body);
    const result = await this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'import.commit', mutationKey(req), { id, ...input }, async () => {
        const batch = await getBatch(tx, tenantId, id, true);
        if (batch.state === 'COMMITTED') return poll(batch);
        if (batch.replayId) return poll(await getBatch(tx, tenantId, batch.replayId));
        checkVersion(batch, input.version);
        if ((batch.state !== 'REVIEW' && !(batch.state === 'FAILED' && batch.failedStage === 'IMPORT_COMMIT'))
          || batch.errorCount || batch.reviewCount || !batch.coverageStart || !batch.coverageEnd) {
          throw new Problem(422, 'IMPORT_ROWS_UNRESOLVED', 'Fix validation errors and resolve duplicate rows before committing');
        }
        const pending = await updateBatch(tx, batch, { state: 'COMMIT_QUEUED', problemCode: null, failedStage: null });
        await tx.outboxEvent.create({ data: { tenantId, targetId: id, targetVersion: pending.version, actorId: actor.id, requestId: requestId(req), kind: 'IMPORT_COMMIT' } });
        return poll(pending);
      },
    ));
    res.location(result.statusUrl);
    return result;
  }

  @Post(':bid/discard')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(discardBody)
  @ApiOutput(200, batchView)
  discard(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('bid') bid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(bid);
    const input = parse(discardBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'import.discard', mutationKey(req), { id, ...input }, async () => {
        const batch = await getBatch(tx, tenantId, id, true);
        checkVersion(batch, input.version);
        if (batch.state === 'COMMITTED' || batch.replayId) throw new Problem(409, 'IMPORT_ALREADY_COMMITTED', 'Committed statement rows can only be corrected through support');
        await audit(tx, tenantId, actor.id, requestId(req), 'import_discarded', id, batch.version + 1, { reason: input.reason });
        return view(await updateBatch(tx, batch, { state: 'DISCARDED' }));
      },
    ));
  }

  private issueTicket(batch: ImportBatch) {
    if (!this.config.UPLOAD_TICKET_SECRET) throw new Problem(503, 'IMPORT_STORAGE_UNAVAILABLE', 'Statement uploads are not configured');
    const expiresAt = new Date(batch.createdAt.getTime() + uploadLifetime);
    const uploadTicket = createHmac('sha256', this.config.UPLOAD_TICKET_SECRET)
      .update(`${batch.tenantId}/${batch.id}/${batch.createdBy}/${batch.bytes}/${expiresAt.getTime()}`).digest('base64url');
    return { uploadTicket, expiresAt: expiresAt.toISOString() };
  }

  private checkTicket(batch: ImportBatch, actor: ActorIdentity, value?: string) {
    const ticket = this.issueTicket(batch);
    if (actor.id !== batch.createdBy || Date.parse(ticket.expiresAt) <= Date.now() || !value || !/^[A-Za-z0-9_-]{43}$/.test(value)
      || !timingSafeEqual(Buffer.from(value), Buffer.from(ticket.uploadTicket))) {
      throw new Problem(403, 'UPLOAD_TICKET_INVALID', 'Create a new upload ticket to continue');
    }
  }
}
