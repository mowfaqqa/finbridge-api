import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { financialWriters, Workspaces } from '../identity/workspaces';
import { ApiInput, ApiOutput, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';
import { Problem } from '../platform/problem';
import { audit, idempotent, mutationKey, requestId } from '../platform/transaction';

const fields = {
  displayName: z.string().trim().min(1, 'Enter a customer display name').max(120),
  email: z.email().max(254).nullable(),
};
const createCustomer = z.object({ ...fields, email: fields.email.optional() }).strict();
const updateCustomer = createCustomer.partial().extend({ version }).refine((body) =>
  body.displayName !== undefined || body.email !== undefined, { message: 'Provide a customer field to update' });
const customerView = z.object({ id: uuid, displayName: z.string(), email: fields.email, version });
const customerQuery = listQuery.extend({ sort: z.enum(['asc', 'desc']).default('asc') }).refine((input) => !(input.after && input.before), {
  message: 'Use either the next or previous cursor',
});
const selection = { id: true, displayName: true, email: true, version: true } as const;
const missing = () => new Problem(404, 'CUSTOMER_NOT_FOUND', 'Customer unavailable');

@Controller('workspaces/:wid/customers')
@ApiTags('customers')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class CustomersController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get()
  @ApiListQuery()
  @ApiQuery({ name: 'sort', enum: ['asc', 'desc'], required: false })
  @ApiOutput(200, pageView(customerView))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() input: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(customerQuery, input);
    const cursor = query.after ?? query.before;
    const direction = query.before ? (query.sort === 'asc' ? 'desc' : 'asc') : query.sort;
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const rows = await tx.customer.findMany({
        where: {
          tenantId,
          ...(query.q && { OR: [
            { displayName: { contains: query.q, mode: 'insensitive' } },
            { email: { contains: query.q, mode: 'insensitive' } },
          ] }),
        },
        ...(cursor && { cursor: { tenantId_id: { tenantId, id: cursor } }, skip: 1 }),
        orderBy: [{ displayName: direction }, { id: direction }],
        take: query.limit + 1,
        select: selection,
      });
      return pageResult(rows, query);
    });
  }

  @Get(':cid')
  @ApiOutput(200, customerView)
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('cid') cid: string) {
    const tenantId = resourceId(wid);
    const id = resourceId(cid);
    return this.workspaces.run(actor, tenantId, undefined, async (tx) => {
      const row = await tx.customer.findUnique({ where: { tenantId_id: { tenantId, id } }, select: selection });
      if (!row) throw missing();
      return row;
    });
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(createCustomer)
  @ApiOutput(201, customerView)
  create(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() request: Request) {
    const tenantId = resourceId(wid);
    const input = parse(createCustomer, body);
    const key = mutationKey(request);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'customer.create', key, input, async () => {
        const row = await tx.customer.create({ data: { tenantId, ...input }, select: selection });
        await audit(tx, tenantId, actor.id, requestId(request), 'customer_created', row.id, row.version);
        return row;
      },
    ));
  }

  @Patch(':cid')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(updateCustomer)
  @ApiOutput(200, customerView)
  update(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('cid') cid: string, @Body() body: unknown, @Req() request: Request) {
    const tenantId = resourceId(wid);
    const id = resourceId(cid);
    const input = parse(updateCustomer, body);
    const key = mutationKey(request);
    return this.workspaces.run(actor, tenantId, financialWriters, (tx) => idempotent(
      tx, actor.id, tenantId, 'customer.update', key, { id, ...input }, async () => {
        const [current] = await tx.$queryRaw<{ version: number }[]>`
          SELECT version FROM customers WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
        if (!current) throw missing();
        if (current.version !== input.version) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh this customer before making changes');
        const row = await tx.customer.update({
          where: { tenantId_id: { tenantId, id } },
          data: { displayName: input.displayName, email: input.email, version: { increment: 1 } },
          select: selection,
        });
        await audit(tx, tenantId, actor.id, requestId(request), 'customer_updated', row.id, row.version);
        return row;
      },
    ));
  }
}
