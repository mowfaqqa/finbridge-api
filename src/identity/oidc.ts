import { Controller, Get, Injectable, Logger, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Configuration } from 'openid-client' with { 'resolution-mode': 'import' };
import { z } from 'zod';
import { readConfig } from '../platform/config';
import { Problem } from '../platform/problem';
import { requestId } from '../platform/transaction';
import { Sessions } from './session';

const callbackPath = '/api/v1/auth/oidc/callback';
const flowDuration = 10 * 60 * 1000;
const returnPath = z.enum(['/onboarding', '/invitations/accept']);
const flow = z.object({
  verifier: z.string().min(43).max(128),
  state: z.string().min(32),
  nonce: z.string().min(32),
  returnTo: returnPath,
  expiresAt: z.number().int(),
});

@Injectable()
export class OidcSignIn {
  private readonly config = readConfig();
  private readonly logger = new Logger(OidcSignIn.name);
  private readonly secure = this.config.WEB_ORIGIN.startsWith('https://');
  private readonly cookie = this.secure ? '__Host-finbridge_oidc' : 'finbridge_oidc';
  private readonly options = { httpOnly: true, secure: this.secure, sameSite: 'lax' as const, path: '/' };
  private connection?: Promise<Configuration>;
  private attempts = { until: 0, count: 0 };

  constructor(private readonly sessions: Sessions) {}

  get enabled() {
    return !!this.config.OIDC_ISSUER;
  }

  async start(response: Response, returnTo: unknown) {
    this.requireEnabled();
    const now = Date.now();
    if (now >= this.attempts.until) this.attempts = { until: now + 60_000, count: 0 };
    if (++this.attempts.count > 60) throw new Problem(429, 'SIGN_IN_LIMIT', 'Try signing in again in a minute');

    const client = await import('openid-client');
    const config = await this.discover();
    const next = returnPath.safeParse(returnTo);
    const attempt = {
      verifier: client.randomPKCECodeVerifier(),
      state: client.randomState(),
      nonce: client.randomNonce(),
      returnTo: next.success ? next.data : '/onboarding',
      expiresAt: now + flowDuration,
    };
    const encoded = Buffer.from(JSON.stringify(attempt)).toString('base64url');
    response.cookie(this.cookie, `${encoded}.${this.sign(encoded).toString('base64url')}`, {
      ...this.options, maxAge: flowDuration,
    });
    const authorization = client.buildAuthorizationUrl(config, {
      redirect_uri: new URL(callbackPath, this.config.WEB_ORIGIN).href,
      scope: 'openid email',
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: await client.calculatePKCECodeChallenge(attempt.verifier),
    });
    response.redirect(303, authorization.href);
  }

  async callback(request: Request, response: Response) {
    this.requireEnabled();
    response.clearCookie(this.cookie, this.options);
    const attempt = this.readFlow(request);
    try {
      if (!attempt) throw new Error('Invalid OIDC flow');
      const client = await import('openid-client');
      const config = await this.discover();
      const url = new URL(callbackPath, this.config.WEB_ORIGIN);
      url.search = new URL(request.originalUrl, this.config.WEB_ORIGIN).search;
      const result = await client.authorizationCodeGrant(config, url, {
        expectedNonce: attempt.nonce,
        expectedState: attempt.state,
        pkceCodeVerifier: attempt.verifier,
        idTokenExpected: true,
      });
      const claims = result.claims();
      if (!claims?.sub) throw new Error('OIDC subject missing');
      const email = z.email().safeParse(claims.email);
      await this.sessions.signIn(request, response, {
        issuer: claims.iss,
        subject: claims.sub,
        verifiedEmail: claims.email_verified === true && email.success ? email.data.toLowerCase() : null,
      });
      response.redirect(303, attempt.returnTo);
    } catch (error) {
      this.logger.warn({ requestId: requestId(request), event: 'oidc_callback_rejected', error: error instanceof Error ? error.name : 'UnknownError' });
      response.redirect(303, '/sign-in-error');
    }
  }

  private requireEnabled() {
    if (!this.enabled) throw new Problem(404, 'NOT_FOUND', 'Not found');
  }

  private sign(encoded: string) {
    return createHmac('sha256', this.config.OIDC_FLOW_SECRET!).update(encoded).digest();
  }

  private readFlow(request: Request) {
    const matches = request.headers.cookie?.split(';').map((item) => item.trim())
      .filter((item) => item.startsWith(`${this.cookie}=`));
    if (matches?.length !== 1) return null;
    const value = matches[0].slice(this.cookie.length + 1);
    if (!/^[A-Za-z0-9_-]{1,900}\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const [encoded, signature] = value.split('.');
    if (!timingSafeEqual(Buffer.from(signature, 'base64url'), this.sign(encoded))) return null;
    try {
      const result = flow.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
      return result.success && result.data.expiresAt > Date.now() ? result.data : null;
    } catch {
      return null;
    }
  }

  private async discover() {
    if (!this.connection) {
      this.connection = (async () => {
        const client = await import('openid-client');
        const issuer = new URL(this.config.OIDC_ISSUER!);
        const execute = [client.enableNonRepudiationChecks];
        if (issuer.protocol === 'http:') execute.push(client.allowInsecureRequests);
        return client.discovery(issuer, this.config.OIDC_CLIENT_ID!, this.config.OIDC_CLIENT_SECRET,
          client.ClientSecretBasic(), { execute, timeout: 8 });
      })().catch(() => {
        this.connection = undefined;
        throw new Problem(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'Sign-in is temporarily unavailable');
      });
    }
    return this.connection;
  }
}

@Controller('auth/oidc')
@ApiExcludeController()
export class OidcController {
  constructor(private readonly oidc: OidcSignIn) {}

  @Get('start')
  start(@Res() response: Response, @Query('returnTo') returnTo: unknown) {
    return this.oidc.start(response, returnTo);
  }

  @Get('callback')
  callback(@Req() request: Request, @Res() response: Response) {
    return this.oidc.callback(request, response);
  }
}
