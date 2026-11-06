import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { audit, idempotent, mutationKey, requestId, type Tx } from '../platform/transaction';
import { entryInclude, lineSchema, lockStatement, renderLine, requireUnallocated } from './reconciliation';
import { renderTransfer, transferSchema } from './transfer-view';

const pairBody = z.object({ debitEntryId: uuid, creditEntryId: uuid }).strict().refine(
  (input) => input.debitEntryId !== input.creditEntryId, { message: 'Select two different statement lines' },
);
const reverseBody = z.object({ version, reason: z.string().trim().min(1).max(250) }).strict();
const querySchema = listQuery.omit({ q: true }).refine((input) => !(input.after && input.before), { message: 'Use either the next or previous cursor' });
const window = 3 * 86_400_000;
const unavailable = () => new Problem(404, 'TRANSFER_NOT_FOUND', 'Transfer unavailable');

async function lockPair(tx: Tx, tenantId: string, debitId: string, creditId: string) {
  const [first, second] = [debitId, creditId].sort();
  const firstLine = await lockStatement(tx, tenantId, first);
  const secondLine = await lockStatement(tx, tenantId, second);
  return first === debitId ? [firstLine, secondLine] : [secondLine, firstLine];
}

@Controller('workspaces/:wid')
@ApiTags('internal transfers')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class TransfersController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get('statement-entries/:sid/transfer-candidates')
  @ApiListQuery()
  @ApiOutput(200, pageView(lineSchema))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('sid') sid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const id = resourceId(sid);
    const query = parse(querySchema, raw);
    return this.workspaces.run(actor, tenantId, financialWriters, async (tx) => {
      const line = await tx.statementEntry.findUnique({
        where: { tenantId_id: { tenantId, id } }, include: entryInclude,
      });
      if (!line) throw new Problem(404, 'STATEMENT_LINE_NOT_FOUND', 'Statement line unavailable');
      if (line.allocations.length) return pageResult([], query);
      const direction = query.before ? 'desc' : 'asc';
      const cursor = query.after ?? query.before;
      const time = line.bookingDate.getTime();
      const rows = await tx.statementEntry.findMany({
        where: {
          tenantId, accountId: { not: line.accountId }, amountKobo: -line.amountKobo,
          bookingDate: { gte: new Date(time - window), lte: new Date(time + window) },
          allocations: { none: { releasedAt: null } },
        },
        orderBy: [{ bookingDate: direction }, { id: direction }], take: query.limit + 1, include: entryInclude,
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
      });
      return pageResult(rows.map(renderLine), query);
    });
  }

  @Post('transfers')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(pairBody)
  @ApiOutput(201, transferSchema)
  pair(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const input = parse(pairBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'transfer.pair', mutationKey(req), input, async () => {
        const [debit, credit] = await lockPair(tx, tenantId, input.debitEntryId, input.creditEntryId);
        await requireUnallocated(tx, tenantId, debit.id);
        await requireUnallocated(tx, tenantId, credit.id);
        if (debit.accountId === credit.accountId || debit.amountKobo >= 0n || credit.amountKobo !== -debit.amountKobo
          || Math.abs(debit.bookingDate.getTime() - credit.bookingDate.getTime()) > window) {
          throw new Problem(422, 'TRANSFER_PAIR_INVALID', 'Choose equal opposite movements in different accounts booked within three days');
        }
        const transfer = await tx.internalTransfer.create({ data: { tenantId, ...input, actorId: actor.id } });
        await tx.lineAllocation.createMany({ data: [debit, credit].map((line) => ({ tenantId, entryId: line.id, transferId: transfer.id })) });
        await audit(tx, tenantId, actor.id, requestId(req), 'transfer_paired', transfer.id, transfer.version);
        return renderTransfer(transfer);
      },
    ));
  }

  @Post('transfers/:tid/reverse')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(reverseBody)
  @ApiOutput(200, transferSchema)
  reverse(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('tid') tid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(tid);
    const input = parse(reverseBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'transfer.reverse', mutationKey(req), { id, ...input }, async () => {
        const where = { tenantId_id: { tenantId, id } };
        const selected = await tx.internalTransfer.findUnique({ where });
        if (!selected) throw unavailable();
        await lockPair(tx, tenantId, selected.debitEntryId, selected.creditEntryId);
        const current = await tx.internalTransfer.findUniqueOrThrow({ where });
        if (current.version !== input.version || current.reversedAt) throw new Problem(409, 'TRANSFER_CONFLICT', 'Refresh this transfer before reversing it');
        const reversedAt = new Date();
        const released = await tx.lineAllocation.updateMany({ where: { tenantId, transferId: id, releasedAt: null }, data: { releasedAt: reversedAt } });
        if (released.count !== 2) throw new Problem(409, 'TRANSFER_CONFLICT', 'Transfer legs are no longer available');
        const transfer = await tx.internalTransfer.update({
          where, data: { reversedAt, reversedBy: actor.id, reversalReason: input.reason, version: { increment: 1 } },
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'transfer_reversed', id, transfer.version, { reason: input.reason });
        return renderTransfer(transfer);
      },
    ));
  }
}
