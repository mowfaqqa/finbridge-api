import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AccountsController } from './accounts';

@Module({ imports: [IdentityModule], controllers: [AccountsController] })
export class StatementsModule {}
