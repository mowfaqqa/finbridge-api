import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from './contract';

export const listQuery = z.object({
  after: uuid.optional(),
  before: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
});

export function ApiListQuery() {
  return applyDecorators(
    ApiQuery({ name: 'after', required: false, type: String }),
    ApiQuery({ name: 'before', required: false, type: String }),
    ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }),
    ApiQuery({ name: 'q', required: false, type: String }),
  );
}

export function pageView<S extends z.ZodType>(item: S) {
  return z.object({ items: z.array(item), nextCursor: uuid.nullable(), previousCursor: uuid.nullable() });
}

export function pageResult<T extends { id: string }>(rows: T[], query: { after?: string; before?: string; limit: number }) {
  const hasExtra = rows.length > query.limit;
  const items = rows.slice(0, query.limit);
  if (query.before) items.reverse();
  return {
    items,
    nextCursor: (query.before || hasExtra) ? items.at(-1)?.id ?? null : null,
    previousCursor: (query.before ? hasExtra : query.after) ? items[0]?.id ?? null : null,
  };
}
