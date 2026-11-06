import { Global, Module } from '@nestjs/common';
import { Database } from './database';
import { HealthController } from './health';
import { ObjectStorage } from "./storage";

@Global()
@Module({ controllers: [HealthController], providers: [Database, ObjectStorage], exports: [Database, ObjectStorage] })
export class PlatformModule {}
