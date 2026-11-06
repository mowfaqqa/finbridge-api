import { z } from 'zod';

export const MAX_KOBO = 1_000_000_000_000n;
export const kobo = z.string().regex(/^(0|[1-9][0-9]{0,12})$/, 'Enter whole kobo')
  .refine((value) => value.length < 13 || value === '1000000000000', 'Amount exceeds NGN 10 billion');
export const dateOnly = z.iso.date();
export const toDateOnly = (value: string) => new Date(`${value}T00:00:00.000Z`);
export const fromDateOnly = (value: Date) => value.toISOString().slice(0, 10);
const lagos = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const lagosDate = (now = new Date()) => lagos.format(now);
