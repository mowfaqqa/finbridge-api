import { Injectable } from '@nestjs/common';
import type { Workspace, WorkspaceRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Database } from '../platform/database';
import { Problem } from '../platform/problem';
import { audit, idempotent, setContext, type Tx } from '../platform/transaction';
import type { ActorIdentity } from './session';

const summary = (workspace: Workspace, role: WorkspaceRole) => ({
  id: workspace.id, slug: workspace.slug, displayName: workspace.displayName, sector: workspace.sector,
  role, version: workspace.version,
});

@Injectable()
export class Workspaces {
  constructor(private readonly database: Database) {}

  async list(actor: ActorIdentity) {
    return this.database.$transaction(async (tx) => {
      await setContext(tx, actor.id);
      const memberships = await tx.membership.findMany({
        where: { userId: actor.id, revokedAt: null, workspace: { kind: 'SME', deletedAt: null } },
        include: { workspace: true },
        orderBy: [{ workspace: { displayName: 'asc' } }, { tenantId: 'asc' }],
      });
      return memberships.map((membership) => summary(membership.workspace, membership.role));
    });
  }

  async create(actor: ActorIdentity, input: { displayName: string; sector?: string }, key: string, requestId: string) {
    return this.database.$transaction(async (tx) => {
      await setContext(tx, actor.id);
      const outcome = await idempotent(tx, actor.id, null, 'workspace.create', key, input, async () => {
        const id = randomUUID();
        const prefix = input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '').slice(0, 36).replace(/-$/, '') || 'workspace';
        await setContext(tx, actor.id, id);
        const workspace = await tx.workspace.create({
          data: { id, slug: `${prefix}-${id.slice(0, 12)}`, displayName: input.displayName, sector: input.sector },
        });
        await tx.membership.create({ data: { tenantId: id, userId: actor.id, role: 'OWNER' } });
        await audit(tx, id, actor.id, requestId, 'workspace_created', id, 1);
        return summary(workspace, 'OWNER');
      });
      await setContext(tx, actor.id);
      const active = await tx.membership.findFirst({
        where: { tenantId: outcome.id, userId: actor.id, revokedAt: null, workspace: { kind: 'SME', deletedAt: null } },
        select: { role: true },
      });
      if (!active) throw this.invisible();
      return { ...outcome, role: active.role };
    });
  }

  async get(actor: ActorIdentity, tenantId: string) {
    return this.run(actor, tenantId, undefined, async (tx, role) => {
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: tenantId } });
      return summary(workspace, role);
    });
  }

  async run<T>(
    actor: ActorIdentity,
    tenantId: string,
    allowed: readonly WorkspaceRole[] | undefined,
    action: (tx: Tx, role: WorkspaceRole) => Promise<T>,
  ): Promise<T> {
    return this.database.$transaction(async (tx) => {
      await setContext(tx, actor.id);
      const visible = await tx.membership.findFirst({
        where: { tenantId, userId: actor.id, revokedAt: null, workspace: { kind: 'SME', deletedAt: null } },
        select: { tenantId: true },
      });
      if (!visible) throw this.invisible();

      await setContext(tx, actor.id, tenantId);
      const [membership] = await tx.$queryRaw<{ role: WorkspaceRole }[]>`
        SELECT m.role FROM memberships m JOIN workspaces w ON w.id = m.tenant_id
        WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${actor.id}::uuid
          AND m.revoked_at IS NULL AND w.deleted_at IS NULL AND w.kind = 'SME'
        FOR SHARE OF m`;
      if (!membership) throw this.invisible();
      if (allowed && !allowed.includes(membership.role)) {
        throw new Problem(403, 'ACTION_FORBIDDEN', 'Your workspace role cannot perform this action');
      }
      return action(tx, membership.role);
    }, { timeout: 15_000 });
  }

  private invisible() {
    return new Problem(404, 'WORKSPACE_NOT_FOUND', 'Workspace unavailable');
  }
}

export const financialWriters = ['OWNER', 'OPERATOR'] as const;
