import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dateOnly, fromDateOnly, lagosDate, toDateOnly } from '../financial/money';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { Workspaces } from '../identity/workspaces';
import { ApiOutput, dateTime, parse, resourceId, uuid } from '../platform/contract';
import { Problem } from '../platform/problem';
import type { Tx } from '../platform/transaction';

const day = 86_400_000;
const calendar = (input: string) => toDateOnly(input).getTime();
const dateFromMs = (value: number) => fromDateOnly(new Date(value));
const intString = z.string().regex(/^-?[0-9]+$/);
const periodSchema = z.object({ start: dateOnly, end: dateOnly });
const totalsSchema = z.object({ inflowKobo: intString, outflowKobo: intString, netKobo: intString });
const coverageSchema = z.object({
  id: uuid, label: z.string(), lastFour: z.string().nullable(), coveredDays: z.number(), totalDays: z.number(),
  coveredRanges: z.array(periodSchema), gaps: z.array(periodSchema), lastImportAt: dateTime.nullable(),
});
export const cashFlowSchema = z.object({
  currency: z.literal('NGN'), period: periodSchema, asOf: dateTime,
  status: z.enum(['NO_DATA', 'PARTIAL', 'COMPLETE']), lastImportAt: dateTime.nullable(),
  accounts: z.array(coverageSchema), totals: totalsSchema, monthly: z.array(totalsSchema.extend({ month: z.string() })),
  unmatchedCount: z.number(), nonTransferCount: z.number(), matchedCount: z.number(),
});
export const receivablesSchema = z.object({
  currency: z.literal('NGN'), asOf: dateTime, asOfDate: dateOnly,
  totalOpenKobo: intString, currentKobo: intString, overdueKobo: intString,
  aging: z.array(z.object({ label: z.string(), amountKobo: intString })),
});
const reportQuery = z.object({
  start: dateOnly.optional(), end: dateOnly.optional(),
  accounts: z.string().transform((value) => value.split(',')).pipe(z.array(uuid).min(1).max(100)).optional(),
}).refine((input) => Boolean(input.start) === Boolean(input.end), { message: 'Provide both the start and end dates' });

export type Period = z.output<typeof periodSchema>;
export type CashFlow = z.output<typeof cashFlowSchema>;
export type Receivables = z.output<typeof receivablesSchema>;

function shiftMonths(date: string, delta: number) {
  const result = toDateOnly(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + delta);
  const lastDay = new Date(result);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(originalDay, lastDay.getUTCDate()));
  return result;
}

export function completedMonths(now: Date): Period {
  const current = lagosDate(now).slice(0, 7) + '-01';
  return { start: fromDateOnly(shiftMonths(current, -3)), end: dateFromMs(calendar(current) - day) };
}

export function unionCoverage(period: Period, ranges: Period[]) {
  const start = calendar(period.start);
  const end = calendar(period.end);
  const merged: { start: number; end: number }[] = [];
  const clipped = ranges.map((range) => ({
    start: Math.max(start, calendar(range.start)), end: Math.min(end, calendar(range.end)),
  })).filter((range) => range.start <= range.end).sort((left, right) => left.start - right.start);
  for (const range of clipped) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + day) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  let cursor = start;
  let coveredDays = 0;
  const gaps: Period[] = [];
  for (const range of merged) {
    if (cursor < range.start) gaps.push({ start: dateFromMs(cursor), end: dateFromMs(range.start - day) });
    coveredDays += (range.end - range.start) / day + 1;
    cursor = range.end + day;
  }
  if (cursor <= end) gaps.push({ start: dateFromMs(cursor), end: period.end });
  return {
    coveredDays, totalDays: (end - start) / day + 1, gaps,
    coveredRanges: merged.map((range) => ({ start: dateFromMs(range.start), end: dateFromMs(range.end) })),
  };
}

type Aggregate = {
  month: string; inflow: string; outflow: string; unmatched: number; nonTransfer: number; matched: number;
};

export async function readCashFlow(tx: Tx, tenantId: string, period: Period, now: Date, requested?: string[], sourceLimit?: number) {
  if (period.start > period.end || calendar(period.end) >= shiftMonths(period.start, 12).getTime()) {
    throw new Problem(422, 'REPORT_PERIOD_INVALID', 'Choose an inclusive range of up to 12 months');
  }
  const selection = requested ? [...new Set(requested)] : undefined;
  const selected = await tx.bankAccount.findMany({
    where: { tenantId, active: true, ...(selection && { id: { in: selection } }) },
    select: { id: true, label: true, lastFour: true }, orderBy: [{ label: 'asc' }, { id: 'asc' }],
  });
  if (selection && selected.length !== selection.length) throw new Problem(404, 'REPORT_ACCOUNT_UNAVAILABLE', 'Choose active accounts in this workspace');
  const ids = selected.map((row) => row.id);
  const bounds = { start: toDateOnly(period.start), end: toDateOnly(period.end) };
  const batches = await tx.importBatch.findMany({
    where: {
      tenantId, accountId: { in: ids }, state: 'COMMITTED',
      coverageStart: { lte: bounds.end }, coverageEnd: { gte: bounds.start },
    },
    select: { id: true, accountId: true, coverageStart: true, coverageEnd: true }, orderBy: [{ coverageStart: 'asc' }, { id: 'asc' }],
    take: sourceLimit === undefined ? undefined : sourceLimit + 1,
  });
  if (sourceLimit !== undefined && batches.length > sourceLimit) {
    throw new Problem(422, 'EVIDENCE_SOURCE_LIMIT', 'This workspace exceeds the source limit for one evidence pack');
  }
  const latest = await tx.importBatch.groupBy({
    by: ['accountId'], where: { tenantId, accountId: { in: ids }, state: 'COMMITTED' }, _max: { committedAt: true },
  });
  const committedAt = new Map(latest.map((row) => [row.accountId, row._max.committedAt?.toISOString() ?? null]));
  const ranges = new Map<string, Period[]>();
  for (const batch of batches) {
    if (!batch.coverageStart || !batch.coverageEnd) continue;
    const accountRanges = ranges.get(batch.accountId) ?? [];
    accountRanges.push({ start: fromDateOnly(batch.coverageStart), end: fromDateOnly(batch.coverageEnd) });
    ranges.set(batch.accountId, accountRanges);
  }
  const accounts = selected.map((account) => ({
    ...account, ...unionCoverage(period, ranges.get(account.id) ?? []), lastImportAt: committedAt.get(account.id) ?? null,
  }));

  const accountIds = ids.length ? Prisma.sql`ARRAY[${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}]` : Prisma.sql`ARRAY[]::uuid[]`;
  const aggregates = ids.length ? await tx.$queryRaw<Aggregate[]>`
    WITH movements AS (
      SELECT to_char(e.booking_date, 'YYYY-MM') AS month, e.amount_kobo AS amount, a.id AS allocation,
        a.match_id, a.transfer_id, coalesce(peer.account_id = ANY(${accountIds}), false) AS excluded
      FROM statement_entries e
      LEFT JOIN line_allocations a ON a.tenant_id = e.tenant_id AND a.entry_id = e.id AND a.released_at IS NULL
      LEFT JOIN internal_transfers t ON t.tenant_id = a.tenant_id AND t.id = a.transfer_id AND t.reversed_at IS NULL
      LEFT JOIN statement_entries peer ON peer.tenant_id = t.tenant_id
        AND peer.id = CASE WHEN t.debit_entry_id = e.id THEN t.credit_entry_id ELSE t.debit_entry_id END
      WHERE e.tenant_id = ${tenantId}::uuid AND e.account_id = ANY(${accountIds})
        AND e.booking_date BETWEEN ${period.start}::date AND ${period.end}::date
    )
    SELECT month, coalesce(sum(amount) FILTER (WHERE amount > 0 AND NOT excluded), 0)::text AS inflow,
      coalesce(sum(-amount) FILTER (WHERE amount < 0 AND NOT excluded), 0)::text AS outflow,
      count(*) FILTER (WHERE allocation IS NULL)::int AS unmatched,
      count(*) FILTER (WHERE transfer_id IS NULL)::int AS "nonTransfer",
      count(match_id)::int AS matched
    FROM movements GROUP BY month ORDER BY month` : [];

  const byMonth = new Map(aggregates.map((row) => [row.month, row]));
  const monthly: CashFlow['monthly'] = [];
  let inflow = 0n;
  let outflow = 0n;
  for (const cursor = toDateOnly(period.start.slice(0, 7) + '-01'); cursor <= bounds.end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    const month = fromDateOnly(cursor).slice(0, 7);
    const row = byMonth.get(month);
    const credit = BigInt(row?.inflow ?? '0');
    const debit = BigInt(row?.outflow ?? '0');
    inflow += credit;
    outflow += debit;
    monthly.push({ month, inflowKobo: credit.toString(), outflowKobo: debit.toString(), netKobo: (credit - debit).toString() });
  }
  const status = accounts.every((account) => account.coveredDays === 0) ? 'NO_DATA' :
    accounts.every((account) => account.coveredDays === account.totalDays) ? 'COMPLETE' : 'PARTIAL';
  const report: CashFlow = {
    currency: 'NGN', asOf: now.toISOString(), period, status, accounts,
    lastImportAt: accounts.flatMap((account) => account.lastImportAt ? [account.lastImportAt] : []).sort().at(-1) ?? null,
    totals: { inflowKobo: inflow.toString(), outflowKobo: outflow.toString(), netKobo: (inflow - outflow).toString() },
    monthly, unmatchedCount: aggregates.reduce((total, row) => total + row.unmatched, 0),
    nonTransferCount: aggregates.reduce((total, row) => total + row.nonTransfer, 0),
    matchedCount: aggregates.reduce((total, row) => total + row.matched, 0),
  };
  return { report, batchIds: batches.map((batch) => batch.id) };
}

export async function readReceivables(tx: Tx, tenantId: string, now: Date): Promise<Receivables> {
  const asOfDate = lagosDate(now);
  const [amounts] = await tx.$queryRaw<{
    total: string; current: string; overdue: string; days30: string; days60: string; days90: string; days91: string;
  }[]>`
    WITH balances AS (
      SELECT total_kobo - settled_kobo AS amount, ${asOfDate}::date - due_date AS late
      FROM invoices WHERE tenant_id = ${tenantId}::uuid AND status = 'ISSUED' AND total_kobo > settled_kobo
    )
    SELECT coalesce(sum(amount), 0)::text AS total,
      coalesce(sum(amount) FILTER (WHERE late <= 0), 0)::text AS current,
      coalesce(sum(amount) FILTER (WHERE late > 0), 0)::text AS overdue,
      coalesce(sum(amount) FILTER (WHERE late BETWEEN 1 AND 30), 0)::text AS days30,
      coalesce(sum(amount) FILTER (WHERE late BETWEEN 31 AND 60), 0)::text AS days60,
      coalesce(sum(amount) FILTER (WHERE late BETWEEN 61 AND 90), 0)::text AS days90,
      coalesce(sum(amount) FILTER (WHERE late >= 91), 0)::text AS days91
    FROM balances`;
  return {
    currency: 'NGN', asOf: now.toISOString(), asOfDate, totalOpenKobo: amounts.total, currentKobo: amounts.current, overdueKobo: amounts.overdue,
    aging: [
      { label: '1–30', amountKobo: amounts.days30 }, { label: '31–60', amountKobo: amounts.days60 },
      { label: '61–90', amountKobo: amounts.days90 }, { label: '91+', amountKobo: amounts.days91 },
    ],
  };
}

@Controller('workspaces/:wid/reports')
@ApiTags('reports')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get('cash-flow')
  @ApiQuery({ name: 'start', type: String, required: false })
  @ApiQuery({ name: 'end', type: String, required: false })
  @ApiQuery({ name: 'accounts', type: String, required: false, description: 'Comma-separated statement account IDs' })
  @ApiOutput(200, cashFlowSchema)
  cashFlow(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(reportQuery, raw);
    const now = new Date();
    const period = query.start && query.end ? { start: query.start, end: query.end } : completedMonths(now);
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => (await readCashFlow(tx, tenantId, period, now, query.accounts)).report, { isolationLevel: 'RepeatableRead' });
  }

  @Get('receivables')
  @ApiOutput(200, receivablesSchema)
  receivables(@Actor() actor: ActorIdentity, @Param('wid') wid: string) {
    const tenantId = resourceId(wid);
    return this.workspaces.run(actor, tenantId, undefined, (tx) => readReceivables(tx, tenantId, new Date()));
  }
}
