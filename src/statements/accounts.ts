import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { audit, idempotent, mutationKey, requestId } from '../platform/transaction';

const label = z.string().trim().min(1, 'Enter an account label').max(80);
const lastFour = z.string().regex(/^[0-9]{4}$/, 'Enter exactly four digits').nullable();
const createBody = z.object({ label, lastFour: lastFour.optional() }).strict();
const patchBody = createBody.partial().extend({ active: z.boolean().optional(), version }).refine((input) =>
  input.label !== undefined || input.lastFour !== undefined || input.active !== undefined, { message: 'Provide an account field to update' });
const view = z.object({ id: uuid, label, lastFour, active: z.boolean(), version });
const querySchema = listQuery.extend({ active: z.enum(['true', 'false']).optional() })
  .refine((query) => !(query.before && query.after), { message: 'Use either the next or previous cursor' });
const select = { id: true, label: true, lastFour: true, active: true, version: true } as const;
const notFound = () => new Problem(404, 'ACCOUNT_NOT_FOUND', 'Statement account unavailable');

@Controller('workspaces/:wid/accounts')
@ApiTags('statement accounts')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class AccountsController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get()
  @ApiListQuery()
  @ApiQuery({ name: 'active', enum: ['true', 'false'], required: false })
  @ApiOutput(200, pageView(view))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(querySchema, raw);
    const direction = query.before ? 'desc' : 'asc';
    const cursor = query.after ?? query.before;
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const rows = await tx.bankAccount.findMany({
        where: {
          tenantId, active: query.active === undefined ? undefined : query.active === 'true',
          ...(query.q && { label: { contains: query.q, mode: 'insensitive' } }),
        },
        orderBy: [{ label: direction }, { id: direction }], take: query.limit + 1, select,
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
      });
      return pageResult(rows, query);
    });
  }

  @Get(':aid')
  @ApiOutput(200, view)
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('aid') aid: string) {
    const tenantId = resourceId(wid);
    const id = resourceId(aid);
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const row = await tx.bankAccount.findUnique({ where: { tenantId_id: { tenantId, id } }, select });
      if (!row) throw notFound();
      return row;
    });
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(createBody)
  @ApiOutput(201, view)
  create(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const input = parse(createBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'account.create', mutationKey(req), input, async () => {
        const row = await tx.bankAccount.create({ data: { tenantId, ...input }, select });
        await audit(tx, tenantId, actor.id, requestId(req), 'account_created', row.id, row.version);
        return row;
      },
    ));
  }

  @Patch(':aid')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(patchBody)
  @ApiOutput(200, view)
  update(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('aid') aid: string, @Body() body: unknown, @Req() req: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(aid);
    const input = parse(patchBody, body);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'account.update', mutationKey(req), { id, ...input }, async () => {
        const [current] = await tx.$queryRaw<{ version: number }[]>`
          SELECT version FROM bank_accounts WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
        if (!current) throw notFound();
        if (current.version !== input.version) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh the account before making changes');
        const row = await tx.bankAccount.update({
          where: { tenantId_id: { tenantId, id } },
          data: { label: input.label, lastFour: input.lastFour, active: input.active, version: { increment: 1 } }, select,
        });
        await audit(tx, tenantId, actor.id, requestId(req), 'account_updated', id, row.version);
        return row;
      },
    ));
  }
}
