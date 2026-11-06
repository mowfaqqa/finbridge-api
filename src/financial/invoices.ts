import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Invoice, InvoiceStatus, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, dateTime, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { audit, idempotent, mutationKey, requestId, type Tx } from '../platform/transaction';
import { dateOnly, fromDateOnly, kobo, lagosDate, MAX_KOBO, toDateOnly } from './money';

const lineInput = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(9_999),
  unitKobo: kobo,
}).strict();
const invoiceInput = z.object({
  customerId: uuid, issueDate: dateOnly, dueDate: dateOnly, lines: z.array(lineInput).min(1).max(50),
}).strict();
const updateInvoice = invoiceInput.extend({ version });
const issueInvoice = z.object({ version }).strict();
const voidInvoice = z.object({ version, reason: z.string().trim().min(1).max(250) }).strict();
const party = z.object({ displayName: z.string(), email: z.email().nullable() });
const status = z.enum(['DRAFT', 'OPEN', 'VOID']);
const summarySchema = z.object({
  id: uuid, customerId: uuid, customer: party, issueDate: dateOnly, dueDate: dateOnly, status,
  totalKobo: kobo, outstandingKobo: kobo.nullable(), currency: z.literal('NGN'), number: z.string().nullable(),
  issuedAt: dateTime.nullable(), voidReason: z.string().nullable(), overdue: z.boolean(), version,
});
const invoiceSchema = summarySchema.extend({
  lines: z.array(lineInput.extend({ position: z.number().int(), totalKobo: kobo })),
});
const filterStatus = z.enum(['DRAFT', 'ISSUED', 'VOID']);
const invoiceQuery = listQuery.extend({
  status: filterStatus.optional(), sort: z.enum(['asc', 'desc']).default('desc'),
}).refine((input) => !(input.after && input.before), { message: 'Use either the next or previous cursor' });
const partySelect = { displayName: true, email: true } as const;
const summaryInclude = { customer: { select: partySelect } } as const;
const detailInclude = {
  ...summaryInclude, lines: { orderBy: { position: 'asc' } },
} satisfies Prisma.InvoiceInclude;
const invoiceMissing = () => new Problem(404, 'INVOICE_NOT_FOUND', 'Invoice unavailable');

function totals(body: z.output<typeof invoiceInput>) {
  if (body.dueDate < body.issueDate) {
    throw new Problem(422, 'DUE_DATE_INVALID', 'Due date must be on or after the issue date', { dueDate: ['Enter a date on or after the issue date'] });
  }
  let totalKobo = 0n;
  const lines = body.lines.map((line, index) => {
    const unitKobo = BigInt(line.unitKobo);
    totalKobo += unitKobo * BigInt(line.quantity);
    return { ...line, unitKobo, position: index + 1 };
  });
  if (totalKobo <= 0n || totalKobo > MAX_KOBO) {
    throw new Problem(422, 'INVOICE_TOTAL_INVALID', 'Invoice total must be positive and at most NGN 10 billion');
  }
  return {
    invoice: { customerId: body.customerId, totalKobo, issueDate: toDateOnly(body.issueDate), dueDate: toDateOnly(body.dueDate) },
    lines,
  };
}

function summary(row: Prisma.InvoiceGetPayload<{ include: typeof summaryInclude }>) {
  const status = row.status === 'ISSUED' ? 'OPEN' : row.status;
  const dueDate = fromDateOnly(row.dueDate);
  return {
    id: row.id, customerId: row.customerId, customer: (row.customerSnapshot as z.output<typeof party> | null) ?? row.customer,
    issueDate: fromDateOnly(row.issueDate), dueDate, status, totalKobo: row.totalKobo.toString(),
    outstandingKobo: row.status === 'ISSUED' ? row.totalKobo.toString() : null, currency: 'NGN' as const,
    number: row.issuedNumber === null ? null : `INV-${row.issuedNumber.toString().padStart(3, '0')}`,
    issuedAt: row.issuedAt?.toISOString() ?? null, voidReason: row.voidReason,
    overdue: row.status === 'ISSUED' && dueDate < lagosDate(), version: row.version,
  };
}

function detail(row: Prisma.InvoiceGetPayload<{ include: typeof detailInclude }>) {
  return {
    ...summary(row),
    lines: row.lines.map(({ position, description, quantity, unitKobo }) => ({
      position, description, quantity, unitKobo: unitKobo.toString(), totalKobo: (unitKobo * BigInt(quantity)).toString(),
    })),
  };
}

export async function lockInvoice(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx.$queryRaw<Pick<Invoice, 'version' | 'status'>[]>`
    SELECT version, status::text FROM invoices WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  if (!row) throw invoiceMissing();
  return row;
}

async function requireCustomer(tx: Tx, tenantId: string, id: string) {
  const customer = await tx.customer.findUnique({ where: { tenantId_id: { tenantId, id } }, select: partySelect });
  if (!customer) throw new Problem(422, 'CUSTOMER_UNAVAILABLE', 'Select a customer in this workspace', { customerId: ['Select an available customer'] });
  return customer;
}

function requireState(row: { version: number; status: InvoiceStatus }, expected: number, state: InvoiceStatus) {
  if (row.version !== expected) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh the invoice before making changes');
  if (row.status !== state) throw new Problem(409, 'INVOICE_STATE_CONFLICT', state === 'DRAFT' ? 'Only a draft invoice can be changed' : 'Only an open invoice can be voided');
}

const ApiKey = () => ApiHeader({ name: 'Idempotency-Key', required: true });

@Controller('workspaces/:wid/invoices')
@ApiTags('invoices')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class InvoicesController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get()
  @ApiListQuery()
  @ApiQuery({ name: 'status', enum: filterStatus.options, required: false })
  @ApiQuery({ name: 'sort', enum: ['asc', 'desc'], required: false })
  @ApiOutput(200, pageView(summarySchema))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(invoiceQuery, raw);
    const cursor = query.after ?? query.before;
    const direction = query.before ? (query.sort === 'asc' ? 'desc' : 'asc') : query.sort;
    const number = /^(?:inv-)?0*([0-9]{1,18})$/i.exec(query.q ?? '')?.[1];
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const rows = await tx.invoice.findMany({
        where: {
          tenantId, status: query.status,
          ...(query.q && { OR: [
            { status: 'DRAFT', customer: { displayName: { contains: query.q, mode: 'insensitive' } } },
            { customerSnapshot: { path: ['displayName'], string_contains: query.q, mode: 'insensitive' } },
            ...(number ? [{ issuedNumber: BigInt(number) }] : []),
          ] }),
        },
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
        orderBy: [{ issueDate: direction }, { id: direction }],
        take: query.limit + 1, include: summaryInclude,
      });
      return pageResult(rows.map(summary), query);
    });
  }

  @Get(':iid')
  @ApiOutput(200, invoiceSchema)
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('iid') iid: string) {
    const tenantId = resourceId(wid);
    const id = resourceId(iid);
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const row = await tx.invoice.findUnique({ where: { tenantId_id: { tenantId, id } }, include: detailInclude });
      if (!row) throw invoiceMissing();
      return detail(row);
    });
  }

  @Post()
  @ApiKey()
  @ApiInput(invoiceInput)
  @ApiOutput(201, invoiceSchema)
  create(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const input = parse(invoiceInput, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'invoice.create', mutationKey(req), input, async () => {
        const data = totals(input);
        await requireCustomer(tx, tenantId, input.customerId);
        const invoice = await tx.invoice.create({
          data: { tenantId, ...data.invoice, lines: { create: data.lines } }, include: detailInclude,
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'invoice_draft_created', invoice.id, 1);
        return detail(invoice);
      },
    ));
  }

  @Patch(':iid')
  @ApiKey()
  @ApiInput(updateInvoice)
  @ApiOutput(200, invoiceSchema)
  update(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('iid') iid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(iid);
    const input = parse(updateInvoice, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'invoice.update', mutationKey(req), { id, ...input }, async () => {
        requireState(await lockInvoice(tx, tenantId, id), input.version, 'DRAFT');
        const data = totals(input);
        await requireCustomer(tx, tenantId, input.customerId);
        await tx.invoiceLine.deleteMany({ where: { tenantId, invoiceId: id } });
        const invoice = await tx.invoice.update({
          where: { tenantId_id: { tenantId, id } },
          data: { ...data.invoice, version: { increment: 1 }, lines: { create: data.lines } },
          include: detailInclude,
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'invoice_draft_updated', id, invoice.version);
        return detail(invoice);
      },
    ));
  }

  @Post(':iid/issue')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(issueInvoice)
  @ApiOutput(200, invoiceSchema)
  issue(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('iid') iid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(iid);
    const input = parse(issueInvoice, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'invoice.issue', mutationKey(req), { id, ...input }, async () => {
        requireState(await lockInvoice(tx, tenantId, id), input.version, 'DRAFT');
        const where = { tenantId_id: { tenantId, id } };
        const draft = await tx.invoice.findUniqueOrThrow({ where, include: summaryInclude });
        const [counter] = await tx.$queryRaw<{ last_number: bigint }[]>`
          INSERT INTO invoice_counters (tenant_id, last_number) VALUES (${tenantId}::uuid, 1)
          ON CONFLICT (tenant_id) DO UPDATE SET last_number = invoice_counters.last_number + 1
          RETURNING last_number`;
        const invoice = await tx.invoice.update({
          where, data: {
            status: 'ISSUED', issuedAt: new Date(), issuedNumber: counter.last_number,
            customerSnapshot: draft.customer, version: { increment: 1 },
          }, include: detailInclude,
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'invoice_issued', id, invoice.version);
        return detail(invoice);
      },
    ));
  }

  @Post(':iid/void')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(voidInvoice)
  @ApiOutput(200, invoiceSchema)
  void(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('iid') iid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(iid);
    const input = parse(voidInvoice, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'invoice.void', mutationKey(req), { id, ...input }, async () => {
        requireState(await lockInvoice(tx, tenantId, id), input.version, 'ISSUED');
        const invoice = await tx.invoice.update({
          where: { tenantId_id: { tenantId, id } },
          data: { status: 'VOID', voidedAt: new Date(), voidReason: input.reason, version: { increment: 1 } },
          include: detailInclude,
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'invoice_voided', id, invoice.version, { reason: input.reason });
        return detail(invoice);
      },
    ));
  }
}
