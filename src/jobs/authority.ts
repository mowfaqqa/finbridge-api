import type { OutboxEvent } from '@prisma/client';
import { lockScope, type Tx } from '../platform/transaction';

export async function hasJobAuthority(tx: Tx, event: OutboxEvent, serialize: boolean) {
  if (serialize) await lockScope(tx, `memberships/${event.tenantId}`);
  return !!await tx.membership.findFirst({
    where: {
      tenantId: event.tenantId, userId: event.actorId, revokedAt: null, role: { in: ['OWNER', 'OPERATOR'] },
      workspace: { deletedAt: null, kind: 'SME' },
    },
    select: { userId: true },
  });
}
