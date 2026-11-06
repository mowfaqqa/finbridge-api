import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, dateTime, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { ObjectStorage } from '../platform/storage';
import { audit, idempotent, jsonDigest, lockScope, mutationKey, requestId, type Tx } from '../platform/transaction';
import { evaluateReadiness, readinessSchema, type Readiness } from './readiness';

const packState = z.enum(['QUEUED', 'READY', 'FAILED', 'EXPIRED']);
const packSummary = z.object({
  id: uuid, state: packState, asOf: dateTime, expiresAt: dateTime.nullable(), incomplete: z.boolean(),
  version, problemCode: z.string().nullable(), checksum: z.string(), rulesVersion: z.string(),
});
const packDetail = packSummary.extend({ evidence: readinessSchema });
const queuedSchema = z.object({ id: uuid, state: packState, statusUrl: z.string() });
const listSchema = listQuery.omit({ q: true }).refine((query) => !(query.before && query.after), { message: 'Use either the next or previous cursor' });
const retryBody = z.object({ version }).strict();
const createBody = z.object({ confirmIncomplete: z.boolean().default(false) }).strict();
const repeatable = { isolationLevel: 'RepeatableRead' } as const;
const ApiKey = () => ApiHeader({ name: 'Idempotency-Key', required: true });
const missing = () => new Problem(404, 'EVIDENCE_NOT_FOUND', 'Evidence pack unavailable');
const location = (tenantId: string, id: string) => `/api/v1/workspaces/${tenantId}/evidence/${id}`;
const withSnapshot = { snapshot: true } satisfies Prisma.ArtifactInclude;
const withSummary = { snapshot: { select: { asOf: true, incomplete: true, checksum: true, rulesVersion: true } } } satisfies Prisma.ArtifactInclude;
type ArtifactSummary = Prisma.ArtifactGetPayload<{ include: typeof withSummary }>;

function status(row: ArtifactSummary, now = new Date()) {
  return row.state === 'READY' && row.expiresAt && row.expiresAt <= now ? 'EXPIRED' : row.state;
}

function summarize(row: ArtifactSummary) {
  return {
    id: row.id, state: status(row), asOf: row.snapshot.asOf.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null,
    incomplete: row.snapshot.incomplete, version: row.version, problemCode: row.problemCode,
    checksum: row.snapshot.checksum, rulesVersion: row.snapshot.rulesVersion,
  };
}

export async function getArtifact(tx: Tx, tenantId: string, id: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT 1 FROM artifacts WHERE tenant_id = ${tenantId}::uuid AND snapshot_id = ${id}::uuid FOR UPDATE`;
  const row = await tx.artifact.findUnique({ where: { tenantId_id: { tenantId, id } }, include: withSnapshot });
  if (!row) throw missing();
  return row;
}

function rangeHeader(header: string | undefined, length: number) {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const invalid = () => new Problem(416, 'PDF_RANGE_INVALID', 'Choose a valid PDF byte range');
  if (!match || (!match[1] && !match[2])) throw invalid();
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= length) throw invalid();
  return { start, end, value: `bytes=${start}-${end}` };
}

@Controller('workspaces/:wid/evidence')
@ApiTags('readiness evidence')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class EvidenceController {
  constructor(private readonly workspaces: Workspaces, private readonly storage: ObjectStorage) {}

  @Get('readiness')
  @ApiOutput(200, readinessSchema)
  readiness(@Actor() actor: ActorIdentity, @Param('wid') wid: string) {
    const tenantId = resourceId(wid);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => evaluateReadiness(tx, tenantId, new Date()), repeatable);
  }

  @Get()
  @ApiListQuery()
  @ApiOutput(200, pageView(packSummary))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(listSchema, raw);
    const cursor = query.after ?? query.before;
    const direction = query.before ? 'asc' : 'desc';
    return this.workspaces.run(actor, tenantId, financialWriters, async (tx) => {
      const rows = await tx.artifact.findMany({
        where: { tenantId }, include: withSummary, take: query.limit + 1,
        orderBy: [{ snapshot: { asOf: direction } }, { id: direction }],
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
      });
      return pageResult(rows.map(summarize), query);
    });
  }

  @Get(':eid')
  @ApiOutput(200, packDetail)
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('eid') eid: string) {
    const tenantId = resourceId(wid);
    const id = resourceId(eid);
    return this.workspaces.run(actor, tenantId, financialWriters, async (tx) => {
      const row = await getArtifact(tx, tenantId, id);
      return { ...summarize(row), evidence: row.snapshot.inputs as Readiness };
    });
  }

  @Post()
  @HttpCode(202)
  @ApiKey()
  @ApiInput(createBody)
  @ApiOutput(202, queuedSchema)
  async create(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() raw: unknown,
    @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenantId = resourceId(wid);
    const input = parse(createBody, raw);
    const operation = () => this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'evidence.generate', mutationKey(req), input, async () => {
        await lockScope(tx, `evidence-rate/${tenantId}`);
        const now = new Date();
        if (await tx.evidenceSnapshot.count({ where: { tenantId, asOf: { gt: new Date(now.getTime() - 60_000) } } }) >= 6) {
          throw new Problem(429, 'EVIDENCE_RATE_LIMIT', 'Wait a minute before generating another pack');
        }
        const evidence = await evaluateReadiness(tx, tenantId, now);
        if (evidence.incomplete && !input.confirmIncomplete) {
          throw new Problem(422, 'INCOMPLETE_EVIDENCE_CONFIRMATION', 'Confirm that the export will be labelled incomplete');
        }
        if (Buffer.byteLength(JSON.stringify(evidence)) > 1_000_000) {
          throw new Problem(422, 'EVIDENCE_SIZE_LIMIT', 'The readiness snapshot is too large for one pack');
        }
        const snapshot = await tx.evidenceSnapshot.create({
          data: { tenantId, actorId: actor.id, asOf: now, rulesVersion: evidence.rulesVersion, incomplete: evidence.incomplete, checksum: jsonDigest(evidence), inputs: evidence },
        });
        await tx.artifact.create({ data: { tenantId, id: snapshot.id } });
        await tx.outboxEvent.create({ data: {
          tenantId, actorId: actor.id, kind: 'EVIDENCE_RENDER', targetId: snapshot.id, targetVersion: 1, requestId: requestId(req),
        } });
        await audit(tx, tenantId, actor.id, requestId(req), 'evidence_requested', snapshot.id, 1, { incomplete: evidence.incomplete });
        return { id: snapshot.id, state: 'QUEUED', statusUrl: location(tenantId, snapshot.id) };
      },
    ), repeatable);
    // A concurrent replay may take its repeatable-read snapshot before the first insert.
    let result;
    try {
      result = await operation();
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !['P2002', 'P2034'].includes(error.code)) throw error;
      result = await operation();
    }
    res.location(result.statusUrl);
    return result;
  }

  @Post(':eid/retry')
  @HttpCode(202)
  @ApiKey()
  @ApiInput(retryBody)
  @ApiOutput(202, queuedSchema)
  async retry(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('eid') eid: string, @Body() raw: unknown,
    @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenantId = resourceId(wid);
    const id = resourceId(eid);
    const input = parse(retryBody, raw);
    const result = await this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'evidence.retry', mutationKey(req), { id, ...input }, async () => {
        const current = await getArtifact(tx, tenantId, id, true);
        if (current.version !== input.version || current.state !== 'FAILED') {
          throw new Problem(409, 'EVIDENCE_STATE_CONFLICT', 'Refresh the pack before retrying');
        }
        const artifact = await tx.artifact.update({
          where: { tenantId_id: { tenantId, id } }, data: { state: 'QUEUED', problemCode: null, version: { increment: 1 } },
        });
        await tx.outboxEvent.create({ data: {
          tenantId, actorId: actor.id, kind: 'EVIDENCE_RENDER', targetId: id, targetVersion: artifact.version, requestId: requestId(req),
        } });
        await audit(tx, tenantId, actor.id, requestId(req), 'evidence_retry_requested', id, artifact.version);
        return { id, state: 'QUEUED', statusUrl: location(tenantId, id) };
      },
    ));
    res.location(result.statusUrl);
    return result;
  }

  @Get(':eid/download')
  @ApiProduces('application/pdf')
  @ApiHeader({ name: 'Range', required: false })
  @ApiResponse({ status: 200, schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 206, schema: { type: 'string', format: 'binary' } })
  async download(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('eid') eid: string, @Req() req: Request, @Res() res: Response) {
    const tenantId = resourceId(wid);
    const id = resourceId(eid);
    const download = await this.workspaces.run(actor, tenantId, financialWriters, async (tx) => {
      const row = await getArtifact(tx, tenantId, id);
      if (status(row) !== 'READY' || !row.objectKey || !row.bytes) throw missing();
      const range = rangeHeader(req.get('range'), row.bytes);
      await audit(tx, tenantId, actor.id, requestId(req), 'evidence_downloaded', id, row.version, { range: !!range });
      return { key: row.objectKey, range, bytes: row.bytes, day: row.snapshot.asOf.toISOString().slice(0, 10) };
    });
    const object = await this.storage.open(download.key, download.range?.value);
    const range = download.range;
    if (range && !object.contentRange) {
      object.body.destroy();
      throw new Problem(503, 'EVIDENCE_STORAGE_UNAVAILABLE', 'The requested PDF range is temporarily unavailable');
    }
    res.status(range ? 206 : 200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="finbridge-readiness-${download.day}.pdf"`);
    res.setHeader('Content-Length', range ? range.end - range.start + 1 : download.bytes);
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${download.bytes}`);
    await pipeline(object.body, res);
  }
}
