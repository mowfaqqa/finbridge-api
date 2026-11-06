import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ReportsController } from './reports';
import { EvidenceController } from "./evidence";

@Module({ imports: [IdentityModule], controllers: [ReportsController, EvidenceController] })
export class ReportingModule {}
