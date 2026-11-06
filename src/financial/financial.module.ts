import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CustomersController } from './customers';
import { InvoicesController } from "./invoices";
import { ExpensesController } from "./expenses";
import { SettlementsController } from "./settlements";

@Module({ imports: [IdentityModule], controllers: [CustomersController, InvoicesController, ExpensesController, SettlementsController] })
export class FinancialModule {}
