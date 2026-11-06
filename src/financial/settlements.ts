import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Settlement, SettlementSource } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, dateTime, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { audit, idempotent, mutationKey, requestId, type Tx } from '../platform/transaction';
import { lockInvoice } from './invoices';
import { dateOnly, fromDateOnly, positiveKobo, toDateOnly } from './money';

const fields = { amountKobo: positiveKobo, receiptDate: dateOnly, reference: z.string().trim().min(1).max(120).nullable() };
const createBody = z.object({ ...fields, reference: fields.reference.optional(), version }).strict();
const reverseBody = z.object({ version, reason: z.string().trim().min(1).max(250) }).strict();
const settlementView = z.object({
  ...fields, id: uuid, invoiceId: uuid, currency: z.literal('NGN'), source: z.enum(['MANUAL', 'STATEMENT']),
  version, verified: z.boolean(), reversedAt: dateTime.nullable(), reversalReason: z.string().nullable(),
});
const querySchema = listQuery.omit({ q: true }).refine((query) => !(query.after && query.before), {
  message: 'Use either the next or previous cursor',
});
const view = (row: Settlement & { matches?: { id: string }[] }) => ({
  id: row.id, invoiceId: row.invoiceId, amountKobo: row.amountKobo.toString(), currency: 'NGN' as const,
  source: row.source, receiptDate: fromDateOnly(row.receiptDate), reference: row.reference,
  version: row.version, verified: !!row.matches?.length, reversedAt: row.reversedAt?.toISOString() ?? null, reversalReason: row.reversalReason,
});

export async function addSettlement(
  tx: Tx, tenantId: string, invoiceId: string, invoice: Awaited<ReturnType<typeof lockInvoice>>,
  source: SettlementSource, amountKobo: bigint, receiptDate: Date, reference?: string | null,
) {
  if (invoice.status !== 'ISSUED' || invoice.totalKobo <= invoice.settledKobo) {
    throw new Problem(409, 'INVOICE_NOT_OPEN', 'Only an invoice with an outstanding balance can receive a settlement');
  }
  if (amountKobo > invoice.totalKobo - invoice.settledKobo) {
    throw new Problem(422, 'SETTLEMENT_EXCEEDS_OUTSTANDING', 'Settlement exceeds the outstanding balance', {
      amountKobo: ['Enter an amount up to the outstanding balance'],
    });
  }
  return tx.settlement.create({ data: { tenantId, invoiceId, source, amountKobo, receiptDate, reference } });
}

export async function reverseSettlement(tx: Tx, tenantId: string, id: string, actorId: string, reason: string) {
  return tx.settlement.update({
    where: { tenantId_id: { tenantId, id } },
    data: { reversedAt: new Date(), reversedBy: actorId, reversalId: randomUUID(), reversalReason: reason, version: { increment: 1 } },
  });
}

@Controller('workspaces/:wid')
@ApiTags('settlements')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class SettlementsController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get('invoices/:iid/settlements')
  @ApiListQuery()
  @ApiOutput(200, pageView(settlementView))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('iid') iid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const invoiceId = resourceId(iid);
    const query = parse(querySchema, raw);
    const cursor = query.after ?? query.before;
    const direction = query.before ? 'asc' : 'desc';
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      if (!await tx.invoice.findUnique({ where: { tenantId_id: { tenantId, id: invoiceId } }, select: { id: true } })) {
        throw new Problem(404, 'INVOICE_NOT_FOUND', 'Invoice unavailable');
      }
      const rows = await tx.settlement.findMany({
        where: { tenantId, invoiceId }, include: { matches: { where: { reversedAt: null }, select: { id: true } } }, orderBy: [{ receiptDate: direction }, { id: direction }], take: query.limit + 1,
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
      });
      return pageResult(rows.map(view), query);
    });
  }

  @Post('invoices/:iid/settlements')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(createBody)
  @ApiOutput(201, settlementView)
  record(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('iid') iid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const invoiceId = resourceId(iid);
    const input = parse(createBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'settlement.record', mutationKey(req), { invoiceId, ...input }, async () => {
        const invoice = await lockInvoice(tx, tenantId, invoiceId);
        if (invoice.version !== input.version) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh the invoice before recording a settlement');
        const row = await addSettlement(tx, tenantId, invoiceId, invoice, 'MANUAL',
          BigInt(input.amountKobo), toDateOnly(input.receiptDate), input.reference);
        await audit(tx, tenantId, actor.id, requestId(req), 'settlement_recorded', row.id, row.version, { invoiceId });
        return view(row);
      },
    ));
  }

  @Post('settlements/:sid/reverse')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(reverseBody)
  @ApiOutput(200, settlementView)
  reverse(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('sid') sid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(sid);
    const input = parse(reverseBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'settlement.reverse', mutationKey(req), { id, ...input }, async () => {
        const where = { tenantId_id: { tenantId, id } };
        const existing = await tx.settlement.findUnique({ where, select: { invoiceId: true } });
        if (!existing) throw new Problem(404, 'SETTLEMENT_NOT_FOUND', 'Settlement unavailable');
        await lockInvoice(tx, tenantId, existing.invoiceId);
        const current = await tx.settlement.findUniqueOrThrow({ where });
        if (current.version !== input.version || current.reversedAt) {
          throw new Problem(409, 'SETTLEMENT_CONFLICT', 'Refresh the settlement before reversing it');
        }
        if (current.source !== 'MANUAL') throw new Problem(409, 'REVERSE_MATCH_FIRST', 'Reverse the statement match to correct this settlement');
        if (await tx.reconciliationMatch.findFirst({ where: { tenantId, settlementId: id, reversedAt: null }, select: { id: true } })) {
          throw new Problem(409, 'REVERSE_MATCH_FIRST', 'Reverse the active statement match before correcting this receipt');
        }
        const row = await reverseSettlement(tx, tenantId, id, actor.id, input.reason);
        await audit(tx, tenantId, actor.id, requestId(req), 'settlement_reversed', id, row.version, { reason: input.reason, invoiceId: existing.invoiceId });
        return view(row);
      },
    ));
  }
}
