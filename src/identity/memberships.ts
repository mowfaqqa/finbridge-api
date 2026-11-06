import { Injectable } from '@nestjs/common';
import type { WorkspaceRole } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { readConfig } from '../platform/config';
import { Database } from '../platform/database';
import { Problem } from '../platform/problem';
import { audit, digest, idempotent, lockScope, setContext } from '../platform/transaction';
import type { ActorIdentity } from './session';
import { Workspaces, workspaceSummary } from './workspaces';

type InviteRole = Exclude<WorkspaceRole, 'OWNER'>;
const owners = ['OWNER'] as const;
const hours72 = 72 * 60 * 60 * 1000;

@Injectable()
export class Memberships {
  private readonly config = readConfig();

  constructor(private readonly database: Database, private readonly workspaces: Workspaces) {}

  get invitationsEnabled() {
    return !!this.config.INVITATION_SECRET && this.config.NODE_ENV !== 'production';
  }

  list(actor: ActorIdentity, tenantId: string) {
    return this.workspaces.run(actor, tenantId, owners, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { tenantId, revokedAt: null }, orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
        include: { user: { select: { verifiedEmail: true } } },
      });
      return rows.map(({ userId, role, version, user }) => ({ userId, role, version, verifiedEmail: user.verifiedEmail }));
    });
  }

  async invite(actor: ActorIdentity, tenantId: string, input: { email: string; role: InviteRole }, key: string, request: string) {
    const secret = this.requireInvitations();
    return this.workspaces.run(actor, tenantId, owners, async (tx) => {
      const result = await idempotent(tx, actor.id, tenantId, 'invitation.create', key, input, async () => {
        const existing = await tx.membership.findFirst({
          where: { tenantId, revokedAt: null, user: { verifiedEmail: input.email } },
          select: { userId: true },
        });
        if (existing) throw new Problem(409, 'ALREADY_MEMBER', 'That identity already belongs to this workspace');
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + hours72);
        await tx.invitation.updateMany({
          where: { tenantId, email: input.email, redeemedAt: null, supersededAt: null },
          data: { supersededAt: new Date() },
        });
        await tx.invitation.create({
          data: { id, tenantId, email: input.email, role: input.role, tokenHash: digest(this.token(id, secret)), expiresAt },
        });
        await audit(tx, tenantId, actor.id, request, 'invitation_created', id);
        return { id, email: input.email, role: input.role, expiresAt: expiresAt.toISOString() };
      });
      return { ...result, token: this.token(result.id, secret) };
    }, { manageMembership: true });
  }

  async accept(actor: ActorIdentity, token: string, key: string, request: string) {
    this.requireInvitations();
    if (!actor.verifiedEmail) throw this.invalidInvitation();
    const email = actor.verifiedEmail;
    const tokenHash = digest(token);
    return this.database.$transaction(async (tx) => {
      await setContext(tx, actor.id);
      await tx.$queryRaw`SELECT set_config('app.verified_email', ${email}, true)`;
      const selector = await tx.invitation.findUnique({ where: { tokenHash }, select: { tenantId: true } });
      if (!selector) throw this.invalidInvitation();
      const { tenantId } = selector;
      await setContext(tx, actor.id, tenantId);
      await lockScope(tx, `memberships/${tenantId}`);
      const workspace = await tx.workspace.findFirst({ where: { id: tenantId, deletedAt: null, kind: 'SME' } });
      if (!workspace) throw this.invalidInvitation();
      await idempotent(tx, actor.id, tenantId, 'invitation.accept', key, { tokenHash }, async () => {
        const invitation = await tx.invitation.findUniqueOrThrow({ where: { tokenHash } });
        if (invitation.email !== email || invitation.supersededAt || invitation.redeemedAt || invitation.expiresAt <= new Date()) {
          throw this.invalidInvitation();
        }
        const where = { tenantId_userId: { tenantId, userId: actor.id } };
        const active = await tx.membership.findUnique({ where });
        if (active && !active.revokedAt) {
          throw new Problem(409, 'ALREADY_MEMBER', 'This identity already belongs to the workspace');
        }
        await tx.membership.upsert({
          where,
          create: { tenantId, userId: actor.id, role: invitation.role },
          update: { role: invitation.role, revokedAt: null, version: { increment: 1 } },
        });
        await tx.invitation.update({ where: { id: invitation.id }, data: { redeemedAt: new Date() } });
        await audit(tx, tenantId, actor.id, request, 'invitation_redeemed', invitation.id);
        return { workspaceId: tenantId };
      });
      const membership = await tx.membership.findFirst({ where: { tenantId, userId: actor.id, revokedAt: null } });
      if (!membership) throw this.invalidInvitation();
      return workspaceSummary(workspace, membership.role);
    });
  }

  update(
    actor: ActorIdentity, tenantId: string, userId: string, version: number,
    change: { role: InviteRole } | { reason: string }, key: string, request: string,
  ) {
    const role = 'role' in change ? change.role : undefined;
    const operation = role ? 'membership.role' : 'membership.revoke';
    return this.workspaces.run(actor, tenantId, owners, (tx) => idempotent(
      tx, actor.id, tenantId, operation, key, { userId, version, ...change }, async () => {
        const where = { tenantId_userId: { tenantId, userId } };
        const member = await tx.membership.findUnique({ where });
        if (!member || member.revokedAt) throw new Problem(404, 'MEMBER_NOT_FOUND', 'Active member unavailable');
        if (member.version !== version) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh the member before making changes');
        if (member.role === 'OWNER') throw new Problem(409, 'OWNER_REQUIRED', 'Transfer ownership before changing the final owner');
        const updated = await tx.membership.update({
          where, data: { ...(role ? { role } : { revokedAt: new Date() }), version: { increment: 1 } },
        });
        await audit(tx, tenantId, actor.id, request, role ? 'membership_role_changed' : 'membership_revoked',
          userId, updated.version, change);
        return { userId, role: updated.role, version: updated.version, active: !updated.revokedAt };
      },
    ), { manageMembership: true });
  }

  transfer(actor: ActorIdentity, tenantId: string, input: { userId: string; version: number }, key: string, request: string) {
    return this.workspaces.run(actor, tenantId, owners, (tx) => idempotent(
      tx, actor.id, tenantId, 'workspace.transfer', key, input, async () => {
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: tenantId } });
        if (workspace.version !== input.version) throw new Problem(409, 'VERSION_CONFLICT', 'Refresh the workspace before transferring ownership');
        const target = await tx.membership.findFirst({ where: { tenantId, userId: input.userId, revokedAt: null } });
        if (!target || target.role === 'OWNER') {
          throw new Problem(422, 'TRANSFER_TARGET_INVALID', 'Choose a member who has accepted their invitation');
        }
        await tx.membership.update({
          where: { tenantId_userId: { tenantId, userId: actor.id } },
          data: { role: 'OPERATOR', version: { increment: 1 } },
        });
        await tx.membership.update({
          where: { tenantId_userId: { tenantId, userId: target.userId } },
          data: { role: 'OWNER', version: { increment: 1 } },
        });
        const updated = await tx.workspace.update({ where: { id: tenantId }, data: { version: { increment: 1 } } });
        await audit(tx, tenantId, actor.id, request, 'workspace_owner_transferred', tenantId, updated.version, { newOwnerId: target.userId });
        return workspaceSummary(updated, 'OPERATOR');
      },
    ), { manageMembership: true });
  }

  private requireInvitations() {
    if (!this.invitationsEnabled) throw new Problem(404, 'INVITATIONS_UNAVAILABLE', 'Invitations are unavailable in this environment');
    return this.config.INVITATION_SECRET!;
  }

  private token(id: string, secret: string) {
    const signature = createHmac('sha256', secret).update(id).digest('base64url');
    return `${id}.${signature}`;
  }

  private invalidInvitation() {
    return new Problem(422, 'INVITATION_UNAVAILABLE', 'This invitation is unavailable. Use the latest link and its intended sign-in identity.');
  }
}
