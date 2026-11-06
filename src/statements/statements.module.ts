import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AccountsController } from './accounts';
import { ImportsController } from "./imports";
import { ReconciliationController } from "./reconciliation";

@Module({ imports: [IdentityModule], controllers: [AccountsController, ImportsController, ReconciliationController] })
export class StatementsModule {}
