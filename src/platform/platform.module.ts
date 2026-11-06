import { Global, Module } from '@nestjs/common';
import { Database } from './database';
import { HealthController } from './health';

@Global()
@Module({ controllers: [HealthController], providers: [Database], exports: [Database] })
export class PlatformModule {}
