import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ReportsController } from './reports';

@Module({ imports: [IdentityModule], controllers: [ReportsController] })
export class ReportingModule {}
