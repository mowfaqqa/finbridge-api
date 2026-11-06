import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CustomersController } from './customers';

@Module({ imports: [IdentityModule], controllers: [CustomersController] })
export class FinancialModule {}
