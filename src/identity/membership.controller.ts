import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiInput, ApiOutput, dateTime, parse, role, uuid, workspaceView } from '../platform/contract';
import { Problem } from '../platform/problem';
import { mutationKey, requestId } from '../platform/transaction';
import { Memberships } from './memberships';
import { Actor, SessionGuard, type ActorIdentity } from './session';

const version = z.number().int().min(1);
const inviteRole = z.enum(['OPERATOR', 'VIEWER']);
const invitationBody = z.object({ email: z.email().max(254).toLowerCase(), role: inviteRole }).strict();
const invitationView = z.object({ id: uuid, email: z.email(), role: inviteRole, token: z.string(), expiresAt: dateTime });
const acceptBody = z.object({ token: z.string().regex(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/) }).strict();
const memberView = z.object({ userId: uuid, role, version, verifiedEmail: z.email().nullable() });
const updateBody = z.object({ version, role: inviteRole }).strict();
const revokeBody = z.object({ version, reason: z.string().trim().min(1).max(250) }).strict();
const updateView = z.object({ userId: uuid, role, version, active: z.boolean() });
const transferBody = z.object({ userId: uuid, version }).strict();
const ApiKey = () => ApiHeader({ name: 'Idempotency-Key', required: true });

function selector(value: string) {
  if (!uuid.safeParse(value).success) throw new Problem(404, 'NOT_FOUND', 'Resource unavailable');
  return value;
}

@Controller('workspaces/:wid')
@ApiTags('memberships')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class MembershipController {
  constructor(private readonly memberships: Memberships) {}

  @Get('members')
  @ApiOutput(200, z.array(memberView))
  list(@Actor() actor: ActorIdentity, @Param('wid') wid: string) {
    return this.memberships.list(actor, selector(wid));
  }

  @Post('invitations')
  @ApiKey()
  @ApiInput(invitationBody)
  @ApiOutput(201, invitationView)
  invite(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() request: Request) {
    return this.memberships.invite(actor, selector(wid), parse(invitationBody, body), mutationKey(request), requestId(request));
  }

  @Patch('members/:mid')
  @ApiKey()
  @ApiInput(updateBody)
  @ApiOutput(200, updateView)
  update(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('mid') mid: string, @Body() body: unknown, @Req() request: Request) {
    const input = parse(updateBody, body);
    return this.memberships.update(actor, selector(wid), selector(mid), input.version, { role: input.role }, mutationKey(request), requestId(request));
  }

  @Post('members/:mid/revoke')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(revokeBody)
  @ApiOutput(200, updateView)
  revoke(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Param('mid') mid: string, @Body() body: unknown, @Req() request: Request) {
    const input = parse(revokeBody, body);
    return this.memberships.update(actor, selector(wid), selector(mid), input.version, { reason: input.reason }, mutationKey(request), requestId(request));
  }

  @Post('transfer-ownership')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(transferBody)
  @ApiOutput(200, workspaceView)
  transfer(@Actor() actor: ActorIdentity, @Param('wid') wid: string, @Body() body: unknown, @Req() request: Request) {
    return this.memberships.transfer(actor, selector(wid), parse(transferBody, body), mutationKey(request), requestId(request));
  }
}

@Controller('invitations')
@ApiTags('memberships')
@ApiCookieAuth()
@UseGuards(SessionGuard)
export class InvitationController {
  constructor(private readonly memberships: Memberships) {}

  @Post('accept')
  @HttpCode(200)
  @ApiKey()
  @ApiInput(acceptBody)
  @ApiOutput(200, workspaceView)
  accept(@Actor() actor: ActorIdentity, @Body() body: unknown, @Req() request: Request) {
    return this.memberships.accept(actor, parse(acceptBody, body).token, mutationKey(request), requestId(request));
  }
}
