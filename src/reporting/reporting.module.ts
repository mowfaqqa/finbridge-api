import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ReportsController } from './reports';
import { EvidenceController } from "./evidence";
import { AuditEventsController } from "./audit-events";

@Module({ imports: [IdentityModule], controllers: [ReportsController, EvidenceController, AuditEventsController] })
export class ReportingModule {}
