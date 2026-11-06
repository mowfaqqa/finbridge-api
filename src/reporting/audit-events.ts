import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Actor, SessionGuard, type ActorIdentity } from '../identity/session';
import { Workspaces } from '../identity/workspaces';
import { ApiOutput, dateTime, parse, resourceId, uuid, version } from '../platform/contract';
import { ApiListQuery, listQuery, pageResult, pageView } from '../platform/pagination';

const querySchema = listQuery.refine((query) => !(query.after && query.before), { message: 'Use either the next or previous cursor' });
const eventSchema = z.object({
  id: uuid, actorId: uuid, action: z.string(), resourceId: uuid, version: version.nullable(), requestId: uuid,
  reason: z.string().nullable(), createdAt: dateTime,
});

@Controller('workspaces/:wid/audit-events')
@ApiTags('audit')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class AuditEventsController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get()
  @ApiListQuery()
  @ApiOutput(200, pageView(eventSchema))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Query() raw: unknown) {
    const tenantId = resourceId(wid);
    const query = parse(querySchema, raw);
    const direction = query.before ? 'asc' : 'desc';
    const cursor = query.after ?? query.before;
    return this.workspaces.run(actor, tenantId, ['OWNER'], async (tx) => {
      const rows = await tx.auditEvent.findMany({
        where: { tenantId, ...(query.q && { action: { contains: query.q, mode: 'insensitive' } }) },
        orderBy: [{ createdAt: direction }, { id: direction }], take: query.limit + 1,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      });
      return pageResult(rows.map(({ tenantId: _, createdAt, metadata, ...row }) => ({
        ...row, createdAt: createdAt.toISOString(),
        reason: metadata && typeof metadata === 'object' && !Array.isArray(metadata) && typeof metadata.reason === 'string'
          ? metadata.reason : null,
      })), query);
    });
  }
}
