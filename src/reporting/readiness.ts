import { z } from 'zod';
import { dateTime, uuid } from '../platform/contract';
import type { Tx } from '../platform/transaction';
import { cashFlowSchema, completedMonths, readCashFlow, readReceivables, receivablesSchema } from './reports';

export const rulesVersion = '1.0';
const check = z.object({
  key: z.string(), label: z.string(), state: z.enum(['COMPLETE', 'NEEDS_ATTENTION', 'NOT_APPLICABLE']),
  numerator: z.number().nullable(), denominator: z.number().nullable(), detail: z.string(), action: z.string().nullable(),
});
export const readinessSchema = z.object({
  workspaceName: z.string(), asOf: dateTime, rulesVersion: z.string(), incomplete: z.boolean(),
  completed: z.number(), applicable: z.number(), checks: z.array(check), cashFlow: cashFlowSchema, receivables: receivablesSchema,
  sourceBatchIds: z.array(uuid),
});
export type Readiness = z.output<typeof readinessSchema>;
type Check = Readiness['checks'][number];

export async function evaluateReadiness(tx: Tx, tenantId: string, now: Date): Promise<Readiness> {
  const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: tenantId }, select: { displayName: true } });
  const { report: cashFlow, batchIds: sourceBatchIds } = await readCashFlow(tx, tenantId, completedMonths(now), now, undefined, 5000);
  const receivables = await readReceivables(tx, tenantId, now);
  const full = cashFlow.accounts.filter((account) => account.coveredDays === account.totalDays).length;
  const accounts = cashFlow.accounts.length;
  const named = !!workspace.displayName.trim();
  const targetMet = cashFlow.matchedCount * 5 >= cashFlow.nonTransferCount * 4;
  const result = (pass: boolean): Check['state'] => pass ? 'COMPLETE' : 'NEEDS_ATTENTION';
  const checks: Check[] = [
    {
      key: 'profile', label: 'Named business profile', state: result(named), numerator: null, denominator: null,
      detail: named ? workspace.displayName : 'Business display name is missing', action: named ? null : 'Enter the business display name.',
    },
    {
      key: 'accounts', label: 'Active statement account', state: result(accounts > 0), numerator: accounts, denominator: null,
      detail: accounts === 1 ? '1 active account' : `${accounts} active accounts`, action: accounts ? null : 'Add a statement account.',
    },
    {
      key: 'coverage', label: 'Full coverage for each account', state: accounts ? result(full === accounts) : 'NOT_APPLICABLE',
      numerator: full, denominator: accounts, detail: accounts ? `${full} of ${accounts} accounts fully covered` : 'No active accounts to review',
      action: accounts && full < accounts ? 'Import statements for the uncovered dates.' : null,
    },
    {
      key: 'matching', label: 'At least 80% reconciled', state: cashFlow.nonTransferCount ? result(targetMet) : 'NOT_APPLICABLE',
      numerator: cashFlow.nonTransferCount ? cashFlow.matchedCount : null, denominator: cashFlow.nonTransferCount || null,
      detail: cashFlow.nonTransferCount
        ? `${cashFlow.matchedCount} of ${cashFlow.nonTransferCount} non-transfer rows reconciled` : 'No transactions to review',
      action: cashFlow.nonTransferCount && !targetMet ? 'Review unmatched statement lines.' : null,
    },
  ];
  return {
    workspaceName: workspace.displayName, asOf: now.toISOString(), rulesVersion,
    incomplete: checks.some((item) => item.state === 'NEEDS_ATTENTION'),
    completed: checks.filter((item) => item.state === 'COMPLETE').length,
    applicable: checks.filter((item) => item.state !== 'NOT_APPLICABLE').length,
    checks, cashFlow, receivables, sourceBatchIds,
  };
}
