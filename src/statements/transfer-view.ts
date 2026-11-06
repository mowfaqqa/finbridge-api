import type { InternalTransfer } from '@prisma/client';
import { z } from 'zod';
import { dateTime, uuid, version } from '../platform/contract';

export const transferSchema = z.object({
  id: uuid, debitEntryId: uuid, creditEntryId: uuid, version,
  createdAt: dateTime, reversedAt: dateTime.nullable(), reversalReason: z.string().nullable(),
});

export const renderTransfer = (row: InternalTransfer) => ({
  id: row.id, debitEntryId: row.debitEntryId, creditEntryId: row.creditEntryId, version: row.version,
  createdAt: row.createdAt.toISOString(), reversedAt: row.reversedAt?.toISOString() ?? null, reversalReason: row.reversalReason,
});
