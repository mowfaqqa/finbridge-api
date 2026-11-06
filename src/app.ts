import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { PlatformModule } from './platform/platform.module';
import { ProblemFilter } from './platform/problem';

@Module({ imports: [PlatformModule] })
export class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Request-Id', randomUUID());
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();

  const openApi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('FinBridge OS API')
      .setVersion('1.0')
      .addCookieAuth('finbridge_session')
      .build(),
  );
  SwaggerModule.setup('api/v1/docs', app, openApi, { ui: false, jsonDocumentUrl: 'api/v1/openapi.json' });
  return app;
}
