import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { PlatformModule } from './platform/platform.module';
import { Problem, ProblemFilter } from "./platform/problem";
import { IdentityModule } from "./identity/identity.module";
import { readConfig } from "./platform/config";

@Module({ imports: [PlatformModule, IdentityModule] })
export class AppModule {}

export async function createApp(quiet = false) {
  const app = await NestFactory.create(AppModule, quiet ? { logger: false } : {});
  app.setGlobalPrefix('api/v1');
  const { WEB_ORIGIN } = readConfig();
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Request-Id', randomUUID());
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
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
