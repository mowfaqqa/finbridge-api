import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { PlatformModule } from './platform/platform.module';
import { Problem, ProblemFilter } from "./platform/problem";
import { IdentityModule } from "./identity/identity.module";
import { FinancialModule } from "./financial/financial.module";
import { StatementsModule } from "./statements/statements.module";
import { ReportingModule } from "./reporting/reporting.module";
import { readConfig } from "./platform/config";

@Module({ imports: [PlatformModule, IdentityModule, FinancialModule, StatementsModule, ReportingModule] })
export class AppModule {}

export async function createApp(quiet = false) {
  const app = await NestFactory.create(AppModule, quiet ? { logger: false } : {});
  app.setGlobalPrefix('api/v1');
  const { WEB_ORIGIN, REQUEST_LOG_ENABLED } = readConfig();
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.get('x-request-id');
    const requestId = incoming && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(incoming)
      ? incoming : randomUUID();
    response.setHeader('X-Request-Id', requestId);
    if (REQUEST_LOG_ENABLED) {
      const start = performance.now();
      response.once('finish', () => {
        const route = typeof request.route?.path === 'string' ? request.route.path : 'unmapped';
        process.stdout.write(JSON.stringify({
          event: 'api_request', requestId, time: new Date().toISOString(), method: request.method,
          route, status: response.statusCode, durationMs: Math.round(performance.now() - start),
        }) + '\n');
      });
    }
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method) && request.get("origin") !== WEB_ORIGIN) {
      next(new Problem(403, "ORIGIN_FORBIDDEN", "Request origin is not authorised"));
      return;
    }
    next();
  });
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();

  SwaggerModule.setup('api/v1/docs', app, () => createOpenApi(app), {
    ui: false,
    jsonDocumentUrl: 'api/v1/openapi.json',
  });
  return app;
}

export function createOpenApi(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('FinBridge OS API')
      .setVersion('1.0')
      .addCookieAuth('finbridge_session')
      .build(),
  );
}
