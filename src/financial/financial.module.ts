import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CustomersController } from './customers';
import { InvoicesController } from "./invoices";
import { ExpensesController } from "./expenses";

@Module({ imports: [IdentityModule], controllers: [CustomersController, InvoicesController, ExpensesController] })
export class FinancialModule {}
