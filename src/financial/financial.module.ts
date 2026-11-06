import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CustomersController } from './customers';
import { InvoicesController } from "./invoices";

@Module({ imports: [IdentityModule], controllers: [CustomersController, InvoicesController] })
export class FinancialModule {}
