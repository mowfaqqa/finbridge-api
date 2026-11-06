import {
  Body, Controller, Get, HttpCode, Module, Param, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorView, ApiInput, ApiOutput, parse, uuid, workspaceView } from '../platform/contract';
import { readConfig } from '../platform/config';
import { Problem } from '../platform/problem';
import { mutationKey } from '../platform/transaction';
import { Actor, SessionGuard, Sessions, type ActorIdentity } from './session';
import { Workspaces } from './workspaces';

const localPersona = z.object({ persona: z.enum(['owner', 'operator', 'viewer', 'second-owner']) }).strict();
const createWorkspace = z.object({
  displayName: z.string().trim().min(1, 'Enter the business display name').max(120),
  sector: z.string().trim().min(1).max(120).optional(),
}).strict();

@Controller('auth')
@ApiTags('identity')
class SessionController {
  private readonly config = readConfig();
  private localWindow = { until: 0, count: 0 };

  constructor(private readonly sessions: Sessions) {}

  @Get('options')
  @ApiOutput(200, z.object({ localSignIn: z.boolean() }))
  options() {
    return { localSignIn: this.config.NODE_ENV !== 'production' && this.config.LOCAL_AUTH_ENABLED };
  }

  @Post('local-session')
  @ApiInput(localPersona)
  @ApiOutput(201, actorView)
  local(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    if (!this.options().localSignIn) throw new Problem(404, 'NOT_FOUND', 'Not found');
    const now = Date.now();
    if (now >= this.localWindow.until) this.localWindow = { until: now + 60_000, count: 0 };
    if (++this.localWindow.count > 30) throw new Problem(429, 'SIGN_IN_LIMIT', 'Try signing in again in a minute');
    const { persona } = parse(localPersona, body);
    return this.sessions.signIn(request, response, {
      issuer: 'urn:finbridge:local', subject: persona, verifiedEmail: `${persona}@finbridge.test`,
    });
  }

  @Get('session')
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  @ApiOutput(200, actorView)
  session(@Actor() actor: ActorIdentity) {
    return actor;
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOutput(204, z.null())
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.sessions.signOut(request, response);
  }
}

@Controller('workspaces')
@UseGuards(SessionGuard)
@ApiTags('workspaces')
@ApiCookieAuth()
class WorkspacesController {
  constructor(private readonly workspaces: Workspaces) {}

  @Get()
  @ApiOutput(200, z.array(workspaceView))
  list(@Actor() actor: ActorIdentity) {
    return this.workspaces.list(actor);
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiInput(createWorkspace)
  @ApiOutput(201, workspaceView)
  create(@Actor() actor: ActorIdentity, @Body() body: unknown, @Req() request: Request) {
    return this.workspaces.create(actor, parse(createWorkspace, body), mutationKey(request), String(request.res?.getHeader('x-request-id')));
  }

  @Get(':wid')
  @ApiOutput(200, workspaceView)
  get(@Actor() actor: ActorIdentity, @Param('wid') wid: string) {
    if (!uuid.safeParse(wid).success) throw new Problem(404, 'WORKSPACE_NOT_FOUND', 'Workspace unavailable');
    return this.workspaces.get(actor, wid);
  }
}

@Module({
  providers: [Sessions, SessionGuard, Workspaces],
  exports: [Sessions, SessionGuard, Workspaces],
  controllers: [SessionController, WorkspacesController],
})
export class IdentityModule {}
