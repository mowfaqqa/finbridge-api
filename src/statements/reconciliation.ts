import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma, type ReconciliationMatch, type StatementEntry } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { lockInvoice } from '../financial/invoices';
import { dateOnly, fromDateOnly } from '../financial/money';
import { addSettlement, reverseSettlement } from '../financial/settlements';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, dateTime, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { audit, idempotent, lockScope, mutationKey, requestId, type Tx } from '../platform/transaction';
import { normalizeReference } from './csv';
import { renderTransfer, transferSchema } from './transfer-view';

const targetKind = z.enum(['INVOICE', 'SETTLEMENT', 'EXPENSE']);
const lineStatus = z.enum(['UNMATCHED', 'MATCHED', 'TRANSFER']);
const account = z.object({ id: uuid, label: z.string(), lastFour: z.string().nullable() });
export const lineSchema = z.object({
  id: uuid, account, batchId: uuid, date: dateOnly, description: z.string(), reference: z.string().nullable(),
  amountKobo: z.string(), currency: z.literal('NGN'), status: lineStatus,
});
const matchSchema = z.object({
  id: uuid, entryId: uuid, expenseId: uuid.nullable(), settlementId: uuid.nullable(), version,
  createdAt: dateTime, reversedAt: dateTime.nullable(), reversalReason: z.string().nullable(),
});
const candidateSchema = z.object({
  id: uuid, kind: targetKind, label: z.string(), reference: z.string().nullable(), date: dateOnly,
  amountKobo: z.string(), currency: z.literal('NGN'), version,
  resultingBalanceKobo: z.string().nullable(), signal: z.enum(['REFERENCE', 'AMOUNT_DATE', 'SEARCH']), distance: z.number().int(),
});
const querySchema = listQuery.extend({
  accountId: uuid.optional(), accounts: z.string().transform((value) => value.split(',')).pipe(z.array(uuid).max(100)).optional(), status: lineStatus.optional(), start: dateOnly.optional(), end: dateOnly.optional(),
  sort: z.enum(['asc', 'desc']).default('desc'),
}).refine((query) => !(query.before && query.after), { message: 'Use either the next or previous cursor' })
  .refine((query) => !(query.start && query.end && query.end < query.start), { message: 'Choose an ordered date range' });
const confirmBody = z.object({ entryId: uuid, targetKind, targetId: uuid, targetVersion: version }).strict();
const reverseBody = z.object({ version, reason: z.string().trim().min(1).max(250) }).strict();
const searchBody = z.object({ q: z.string().trim().min(1).max(120).optional() });

const accountSelect = { id: true, label: true, lastFour: true } as const;
export const entryInclude = {
  account: { select: accountSelect }, allocations: { where: { releasedAt: null }, select: { transferId: true } },
} satisfies Prisma.StatementEntryInclude;
export const renderLine = (row: Prisma.StatementEntryGetPayload<{ include: typeof entryInclude }>) => ({
  id: row.id, account: row.account, batchId: row.batchId, date: fromDateOnly(row.bookingDate),
  description: row.description, reference: row.reference, amountKobo: row.amountKobo.toString(), currency: 'NGN' as const,
  status: row.allocations[0]?.transferId ? 'TRANSFER' : row.allocations.length ? 'MATCHED' : 'UNMATCHED',
});
const renderMatch = (row: ReconciliationMatch) => ({
  id: row.id, entryId: row.entryId, expenseId: row.expenseId, settlementId: row.settlementId, version: row.version,
  createdAt: row.createdAt.toISOString(), reversedAt: row.reversedAt?.toISOString() ?? null, reversalReason: row.reversalReason,
});

const missing = () => new Problem(404, 'STATEMENT_LINE_NOT_FOUND', 'Statement line unavailable');
const conflict = () => new Problem(409, 'MATCH_CONFLICT', 'The statement line or target changed. Refresh before confirming.');
const ApiKey = () => ApiHeader({ name: 'Idempotency-Key', required: true });

export async function lockStatement(tx: Tx, tenantId: string, id: string) {
  await lockScope(tx, `statement-line/${tenantId}/${id}`);
  const row = await tx.statementEntry.findUnique({ where: { tenantId_id: { tenantId, id } } });
  if (!row) throw missing();
  return row;
}

export async function requireUnallocated(tx: Tx, tenantId: string, entryId: string) {
  if (await tx.lineAllocation.findFirst({ where: { tenantId, entryId, releasedAt: null }, select: { id: true } })) throw conflict();
}

async function expenseTarget(tx: Tx, tenantId: string, id: string) {
  const [expense] = await tx.$queryRaw<{ id: string; status: string; version: number; amountKobo: bigint }[]>`
    SELECT id, status::text, version, amount_kobo AS "amountKobo"
    FROM expenses WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  if (!expense) throw conflict();
  return expense;
}

async function settlementTarget(tx: Tx, tenantId: string, id: string) {
  const where = { tenantId_id: { tenantId, id } };
  const existing = await tx.settlement.findUnique({ where, select: { invoiceId: true } });
  if (!existing) throw conflict();
  await lockInvoice(tx, tenantId, existing.invoiceId);
  return tx.settlement.findUniqueOrThrow({ where });
}

type Candidate = {
  id: string; kind: 'INVOICE' | 'SETTLEMENT' | 'EXPENSE'; label: string; reference: string | null;
  date: string; amountKobo: bigint; version: number; strong: boolean; distance: number; resultingBalanceKobo: bigint | null;
};

async function candidates(tx: Tx, line: StatementEntry, search?: string) {
  const tenant = Prisma.sql`${line.tenantId}::uuid`;
  const date = Prisma.sql`${fromDateOnly(line.bookingDate)}::date`;
  const value = line.amountKobo < 0n ? -line.amountKobo : line.amountKobo;
  const ref = normalizeReference(line.reference ?? '');
  const term = search ?? '';
  const refMatch = (column: Prisma.Sql) => Prisma.sql`(${ref} <> '' AND
    lower(regexp_replace(btrim(normalize(coalesce(${column}, ''), NFKC)), '[[:space:]]+', ' ', 'g')) = ${ref})`;
  const expenseRef = refMatch(Prisma.sql`e.reference`);
  const receiptRef = refMatch(Prisma.sql`s.reference`);
  const number = Prisma.sql`'INV-' || lpad(i.issued_number::text, greatest(3, length(i.issued_number::text)), '0')`;
  const invoiceRef = refMatch(number);
  const customer = Prisma.sql`i.customer_snapshot->>'displayName'`;
  const expense = Prisma.sql`
    SELECT e.id, 'EXPENSE' AS kind, e.payee AS label, e.reference, to_char(e.expense_date, 'YYYY-MM-DD') AS date,
      e.amount_kobo AS "amountKobo", e.version, NULL::bigint AS "resultingBalanceKobo", ${expenseRef} AS strong, abs(e.expense_date - ${date}) AS distance
    FROM expenses e WHERE e.tenant_id = ${tenant} AND e.status = 'ACTIVE' AND e.amount_kobo = ${value}
      AND NOT EXISTS (SELECT 1 FROM reconciliation_matches m WHERE m.tenant_id = e.tenant_id AND m.expense_id = e.id AND m.reversed_at IS NULL)
      AND (${term} = '' AND (${expenseRef} OR abs(e.expense_date - ${date}) <= 7)
        OR ${term} <> '' AND strpos(lower(e.payee || ' ' || coalesce(e.reference, '')), lower(${term})) > 0)`;
  const credit = Prisma.sql`
    SELECT s.id, 'SETTLEMENT' AS kind, ${number} || ' · ' || coalesce(${customer}, '') AS label,
      s.reference, to_char(s.receipt_date, 'YYYY-MM-DD') AS date, s.amount_kobo AS "amountKobo", s.version, i.total_kobo - i.settled_kobo AS "resultingBalanceKobo",
      ${receiptRef} AS strong, abs(s.receipt_date - ${date}) AS distance
    FROM settlements s JOIN invoices i ON i.tenant_id = s.tenant_id AND i.id = s.invoice_id
    WHERE s.tenant_id = ${tenant} AND s.source = 'MANUAL' AND s.reversed_at IS NULL AND s.amount_kobo = ${value}
      AND NOT EXISTS (SELECT 1 FROM reconciliation_matches m WHERE m.tenant_id = s.tenant_id AND m.settlement_id = s.id AND m.reversed_at IS NULL)
      AND (${term} = '' AND (${receiptRef} OR abs(s.receipt_date - ${date}) <= 7)
        OR ${term} <> '' AND strpos(lower(${number} || ' ' || coalesce(${customer}, '') || ' ' || coalesce(s.reference, '')), lower(${term})) > 0)
    UNION ALL
    SELECT i.id, 'INVOICE' AS kind, ${number} || ' · ' || coalesce(${customer}, '') AS label,
      ${number} AS reference, to_char(i.issue_date, 'YYYY-MM-DD') AS date, i.total_kobo - i.settled_kobo AS "amountKobo", i.version, i.total_kobo - i.settled_kobo - ${value} AS "resultingBalanceKobo",
      (${invoiceRef} AND i.total_kobo - i.settled_kobo = ${value}) AS strong, abs(i.issue_date - ${date}) AS distance
    FROM invoices i WHERE i.tenant_id = ${tenant} AND i.status = 'ISSUED' AND i.total_kobo - i.settled_kobo >= ${value}
      AND (${term} = '' AND i.total_kobo - i.settled_kobo = ${value} AND ${date} BETWEEN i.issue_date AND i.due_date + 30
        OR ${term} <> '' AND strpos(lower(${number} || ' ' || coalesce(${customer}, '')), lower(${term})) > 0)`;
  const result = await tx.$queryRaw<Candidate[]>`
    SELECT * FROM (${line.amountKobo > 0n ? credit : expense}) candidate ORDER BY strong DESC, distance ASC, id ASC LIMIT 100`;
  return result.map(({ strong, amountKobo, resultingBalanceKobo, ...row }) => ({
    ...row, amountKobo: amountKobo.toString(), resultingBalanceKobo: resultingBalanceKobo?.toString() ?? null, currency: 'NGN' as const,
    signal: strong ? 'REFERENCE' : search ? 'SEARCH' : 'AMOUNT_DATE',
  }));
}

@Controller('workspaces/:wid')
@ApiTags('reconciliation')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class ReconciliationController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get('statement-entries')
  @ApiListQuery()
  @ApiQuery({ name: 'status', enum: lineStatus.options, required: false })
  @ApiQuery({ name: 'accountId', type: String, required: false })
  @ApiQuery({ name: 'accounts', type: String, required: false })
  @ApiQuery({ name: 'start', type: String, required: false })
  @ApiQuery({ name: 'end', type: String, required: false })
  @ApiQuery({ name: 'sort', enum: ['asc', 'desc'], required: false })
  @ApiOutput(200, pageView(lineSchema))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(querySchema, raw);
    const cursor = query.after ?? query.before;
    const direction = query.before ? (query.sort === 'asc' ? 'desc' : 'asc') : query.sort;
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const rows = await tx.statementEntry.findMany({
        where: {
          tenantId, accountId: query.accountId ?? (query.accounts ? { in: query.accounts } : undefined),
          bookingDate: { gte: query.start ? new Date(query.start) : undefined, lte: query.end ? new Date(query.end) : undefined },
          allocations: query.status === 'MATCHED' ? { some: { releasedAt: null, matchId: { not: null } } } :
            query.status === 'TRANSFER' ? { some: { releasedAt: null, transferId: { not: null } } } :
            query.status === 'UNMATCHED' ? { none: { releasedAt: null } } : undefined,
          ...(query.q && { OR: [{ description: { contains: query.q, mode: 'insensitive' } }, { reference: { contains: query.q, mode: 'insensitive' } }] }),
        },
        include: entryInclude, orderBy: [{ bookingDate: direction }, { id: direction }], take: query.limit + 1,
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
      });
      return pageResult(rows.map(renderLine), query);
    });
  }

  @Get('statement-entries/:sid')
  @ApiOutput(200, lineSchema.extend({ history: z.array(matchSchema), transfers: z.array(transferSchema) }))
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('sid') sid: string) {
    const tenantId = resourceId(wid);
    const id = resourceId(sid);
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const line = await tx.statementEntry.findUnique({ where: { tenantId_id: { tenantId, id } }, include: entryInclude });
      if (!line) throw missing();
      const history = await tx.reconciliationMatch.findMany({
        where: { tenantId, entryId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25,
      });
      const transfers = await tx.internalTransfer.findMany({
        where: { tenantId, OR: [{ debitEntryId: id }, { creditEntryId: id }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25,
      });
      return { ...renderLine(line), history: history.map(renderMatch), transfers: transfers.map(renderTransfer) };
    });
  }

  @Get('statement-entries/:sid/candidates')
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiOutput(200, z.array(candidateSchema))
  findCandidates(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('sid') sid: string, @Query() query: unknown) {
    const tenantId = resourceId(wid);
    const id = resourceId(sid);
    const { q } = parse(searchBody, query);
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const entry = await tx.statementEntry.findUnique({ where: { tenantId_id: { tenantId, id } } });
      if (!entry) throw missing();
      if (await tx.lineAllocation.findFirst({ where: { tenantId, entryId: id, releasedAt: null } })) return [];
      return candidates(tx, entry, q);
    });
  }

  @Post('matches')
  @ApiKey()
  @ApiInput(confirmBody)
  @ApiOutput(201, matchSchema)
  confirm(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const input = parse(confirmBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'match.confirm', mutationKey(req), input, async () => {
        const line = await lockStatement(tx, tenantId, input.entryId);
        await requireUnallocated(tx, tenantId, line.id);
        let expenseId: string | undefined;
        let settlementId: string | undefined;
        if (input.targetKind === 'EXPENSE') {
          const target = await expenseTarget(tx, tenantId, input.targetId);
          if (target.version !== input.targetVersion || target.status !== 'ACTIVE') throw conflict();
          if (line.amountKobo >= 0n || -line.amountKobo !== target.amountKobo) throw new Problem(422, 'MATCH_AMOUNT_INVALID', 'Select an equal-value debit and expense');
          if (await tx.reconciliationMatch.findFirst({ where: { tenantId, expenseId: target.id, reversedAt: null } })) throw conflict();
          expenseId = target.id;
        } else if (input.targetKind === 'SETTLEMENT') {
          const target = await settlementTarget(tx, tenantId, input.targetId);
          if (target.version !== input.targetVersion || target.source !== 'MANUAL' || target.reversedAt) throw conflict();
          if (line.amountKobo <= 0n || line.amountKobo !== target.amountKobo) throw new Problem(422, 'MATCH_AMOUNT_INVALID', 'Select an equal-value credit and recorded receipt');
          if (await tx.reconciliationMatch.findFirst({ where: { tenantId, settlementId: target.id, reversedAt: null } })) throw conflict();
          settlementId = target.id;
        } else {
          const invoice = await lockInvoice(tx, tenantId, input.targetId);
          if (invoice.version !== input.targetVersion) throw conflict();
          if (line.amountKobo <= 0n) throw new Problem(422, 'MATCH_POLARITY_INVALID', 'Only a credit can settle an invoice');
          settlementId = (await addSettlement(tx, tenantId, input.targetId, invoice, 'STATEMENT',
            line.amountKobo, line.bookingDate, line.reference)).id;
        }
        const match = await tx.reconciliationMatch.create({
          data: { tenantId, entryId: line.id, expenseId, settlementId, actorId: actor.id },
        });
        await tx.lineAllocation.create({ data: { tenantId, entryId: line.id, matchId: match.id } });
        await audit(tx, tenantId, actor.id, requestId(req), 'match_confirmed', match.id, match.version, { entryId: line.id, targetKind: input.targetKind });
        return renderMatch(match);
      },
    ));
  }

  @Post('matches/:mid/reverse')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(reverseBody)
  @ApiOutput(200, matchSchema)
  reverse(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('mid') mid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(mid);
    const input = parse(reverseBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'match.reverse', mutationKey(req), { id, ...input }, async () => {
        const where = { tenantId_id: { tenantId, id } };
        const selected = await tx.reconciliationMatch.findUnique({ where });
        if (!selected) throw new Problem(404, 'MATCH_NOT_FOUND', 'Match unavailable');
        await lockStatement(tx, tenantId, selected.entryId);
        const current = await tx.reconciliationMatch.findUniqueOrThrow({ where });
        if (current.version !== input.version || current.reversedAt) throw conflict();
        if (current.expenseId) await expenseTarget(tx, tenantId, current.expenseId);
        if (current.settlementId) {
          const settlement = await settlementTarget(tx, tenantId, current.settlementId);
          if (settlement.source === 'STATEMENT') await reverseSettlement(tx, tenantId, settlement.id, actor.id, input.reason);
        }
        const reversedAt = new Date();
        await tx.lineAllocation.updateMany({ where: { tenantId, matchId: id, releasedAt: null }, data: { releasedAt: reversedAt } });
        const match = await tx.reconciliationMatch.update({
          where, data: { reversedAt, reversedBy: actor.id, reversalReason: input.reason, version: { increment: 1 } },
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'match_reversed', id, match.version, { entryId: match.entryId, reason: input.reason });
        return renderMatch(match);
      },
    ));
  }
}
