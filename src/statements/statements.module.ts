import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AccountsController } from './accounts';
import { ImportsController } from "./imports";

@Module({ imports: [IdentityModule], controllers: [AccountsController, ImportsController] })
export class StatementsModule {}
