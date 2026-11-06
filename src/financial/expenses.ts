import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Expense } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { audit, idempotent, mutationKey, requestId, type Tx } from '../platform/transaction';
import { dateOnly, fromDateOnly, positiveKobo, toDateOnly } from './money';

const category = z.enum(['SUPPLIES', 'RENT_AND_UTILITIES', 'TRANSPORT', 'PAYROLL', 'FEES', 'OTHER']);
const status = z.enum(['ACTIVE', 'VOID']);
const fields = {
  date: dateOnly, payee: z.string().trim().min(1).max(120),
  category, amountKobo: positiveKobo, reference: z.string().trim().min(1).max(120).nullable(),
};
const createBody = z.object({ ...fields, reference: fields.reference.optional() }).strict();
const patchBody = createBody.partial().extend({ version }).refine(({ version: _version, ...changes }) =>
  Object.keys(changes).length > 0, { message: 'Provide an expense field to update' });
const voidBody = z.object({ version, reason: z.string().trim().min(1).max(250) }).strict();
const expenseView = z.object({
  ...fields, id: uuid, version, status, currency: z.literal('NGN'), voidReason: z.string().nullable(), matched: z.boolean(),
});
const expenseQuery = listQuery.extend({
  category: category.optional(), status: status.optional(), sort: z.enum(['asc', 'desc']).default('desc'),
}).refine((input) => !(input.after && input.before), { message: 'Use either the next or previous cursor' });

const notFound = () => new Problem(404, 'EXPENSE_NOT_FOUND', 'Expense unavailable');
const ApiKey = () => ApiHeader({ name: 'Idempotency-Key', required: true });
const activeMatches = { where: { reversedAt: null }, select: { id: true } } as const;
const view = (row: Expense & { matches?: { id: string }[] }) => ({
  id: row.id, payee: row.payee, category: row.category, date: fromDateOnly(row.expenseDate),
  reference: row.reference, amountKobo: row.amountKobo.toString(), currency: 'NGN' as const,
  matched: !!row.matches?.length, status: row.status, voidReason: row.voidReason, version: row.version,
});

async function lockExpense(tx: Tx, tenantId: string, id: string, version: number) {
  const [row] = await tx.$queryRaw<Pick<Expense, 'status' | 'version'>[]>`
    SELECT status::text, version FROM expenses WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound();
  if (row.version !== version) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh the expense before making changes');
  if (await tx.reconciliationMatch.findFirst({ where: { tenantId, expenseId: id, reversedAt: null }, select: { id: true } })) {
    throw new Problem(409, 'EXPENSE_MATCHED', 'Reverse the active statement match before changing this expense');
  }
  if (row.status !== 'ACTIVE') throw new Problem(409, 'EXPENSE_VOID', 'A void expense cannot be changed');
}

@Controller('workspaces/:wid/expenses')
@ApiTags('expenses')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class ExpensesController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get()
  @ApiListQuery()
  @ApiQuery({ name: 'category', enum: category.options, required: false })
  @ApiQuery({ name: 'status', enum: status.options, required: false })
  @ApiQuery({ name: 'sort', enum: ['asc', 'desc'], required: false })
  @ApiOutput(200, pageView(expenseView))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(expenseQuery, raw);
    const cursor = query.after ?? query.before;
    const direction = query.before ? (query.sort === 'asc' ? 'desc' : 'asc') : query.sort;
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const rows = await tx.expense.findMany({
        where: { tenantId, category: query.category, status: query.status, ...(query.q && { OR: [
          { payee: { contains: query.q, mode: 'insensitive' } },
          { reference: { contains: query.q, mode: 'insensitive' } },
        ] }) },
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
        orderBy: [{ expenseDate: direction }, { id: direction }], take: query.limit + 1, include: { matches: activeMatches },
      });
      return pageResult(rows.map(view), query);
    });
  }

  @Get(':eid')
  @ApiOutput(200, expenseView)
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('eid') eid: string) {
    const tenantId = resourceId(wid);
    const id = resourceId(eid);
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const row = await tx.expense.findUnique({ where: { tenantId_id: { tenantId, id } }, include: { matches: activeMatches } });
      if (!row) throw notFound();
      return view(row);
    });
  }

  @Post()
  @ApiKey()
  @ApiInput(createBody)
  @ApiOutput(201, expenseView)
  create(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const input = parse(createBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'expense.create', mutationKey(req), input, async () => {
        const { date, amountKobo, ...fields } = input;
        const row = await tx.expense.create({ data: { tenantId, ...fields, expenseDate: toDateOnly(date), amountKobo: BigInt(amountKobo) } });
        await audit(tx, tenantId, actor.id, requestId(req), 'expense_created', row.id, row.version);
        return view(row);
      },
    ));
  }

  @Patch(':eid')
  @ApiKey()
  @ApiInput(patchBody)
  @ApiOutput(200, expenseView)
  update(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('eid') eid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(eid);
    const input = parse(patchBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'expense.update', mutationKey(req), { id, ...input }, async () => {
        await lockExpense(tx, tenantId, id, input.version);
        const { date, amountKobo, payee, reference, category } = input;
        const row = await tx.expense.update({
          where: { tenantId_id: { tenantId, id } },
          data: {
            payee, reference, category,
            expenseDate: date === undefined ? undefined : toDateOnly(date),
            amountKobo: amountKobo === undefined ? undefined : BigInt(amountKobo),
            version: { increment: 1 },
          },
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'expense_updated', id, row.version);
        return view(row);
      },
    ));
  }

  @Post(':eid/void')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(voidBody)
  @ApiOutput(200, expenseView)
  void(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('eid') eid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(eid);
    const input = parse(voidBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'expense.void', mutationKey(req), { id, ...input }, async () => {
        await lockExpense(tx, tenantId, id, input.version);
        const row = await tx.expense.update({
          where: { tenantId_id: { tenantId, id } },
          data: { status: 'VOID', voidReason: input.reason, voidedAt: new Date(), version: { increment: 1 } },
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'expense_voided', id, row.version, { reason: input.reason });
        return view(row);
      },
    ));
  }
}
