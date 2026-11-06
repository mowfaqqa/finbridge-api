import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Database } from '../platform/database';
import { readConfig } from '../platform/config';
import { Problem } from '../platform/problem';
import { digest } from '../platform/transaction';

export interface ActorIdentity {
  id: string;
  verifiedEmail: string | null;
}

type SessionRequest = Request & { actor?: ActorIdentity };
const sessionDuration = 24 * 60 * 60 * 1000;
export const sessionCookie = 'finbridge_session';

function cookieToken(request: Request) {
  const values = request.headers.cookie?.split(';').map((item) => item.trim())
    .filter((item) => item.startsWith(`${sessionCookie}=`));
  const token = values?.length === 1 ? values[0].slice(sessionCookie.length + 1) : undefined;
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

@Injectable()
export class Sessions {
  private readonly secure = readConfig().NODE_ENV === 'production';
  private readonly cookieOptions = {
    httpOnly: true, secure: this.secure, sameSite: 'lax' as const, path: '/',
  };

  constructor(private readonly database: Database) {}

  async authenticate(request: Request) {
    const token = cookieToken(request);
    if (!token) return null;
    const session = await this.database.session.findFirst({
      where: { tokenHash: digest(token), revokedAt: null, expiresAt: { gt: new Date() } },
      select: { user: { select: { id: true, verifiedEmail: true } } },
    });
    return session?.user ?? null;
  }

  async signIn(
    request: Request, response: Response, identity: { issuer: string; subject: string; verifiedEmail: string | null },
  ) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionDuration);
    const previous = cookieToken(request);
    const actor = await this.database.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
        create: identity,
        update: { verifiedEmail: identity.verifiedEmail },
        select: { id: true, verifiedEmail: true },
      });
      if (previous) {
        await tx.session.updateMany({ where: { tokenHash: digest(previous), revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await tx.session.create({ data: { userId: user.id, tokenHash: digest(token), expiresAt } });
      return user;
    });
    response.cookie(sessionCookie, token, { ...this.cookieOptions, expires: expiresAt });
    return actor;
  }

  async signOut(request: Request, response: Response) {
    const token = cookieToken(request);
    if (token) {
      await this.database.session.updateMany({ where: { tokenHash: digest(token), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    response.clearCookie(sessionCookie, this.cookieOptions);
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: Sessions) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const actor = await this.sessions.authenticate(request);
    if (!actor) throw new Problem(401, 'SESSION_REQUIRED', 'Sign in to continue');
    request.actor = actor;
    return true;
  }
}

export const Actor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<SessionRequest>().actor;
});
