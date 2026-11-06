import { parse as csvParse } from 'csv-parse';
import { parse as csvHeader } from 'csv-parse/sync';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { dateOnly, MAX_KOBO, toDateOnly } from '../financial/money';
import { digest } from '../platform/transaction';

export const maxBytes = 5 * 1024 * 1024;
export const maxRows = 10_000;
const maxFields = 64;
const column = z.number().int().min(0).max(maxFields - 1);
export const csvMapping = z.object({
  date: column,
  description: column,
  reference: column.optional(),
  sourceId: column.optional(),
  dateFormat: z.enum(['ISO', 'DMY', 'MDY']),
  money: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('signed'), amount: column }).strict(),
    z.object({ mode: z.literal('split'), debit: column, credit: column }).strict(),
  ]),
}).strict();

export type Mapping = z.output<typeof csvMapping>;
export type ParsedRow = Omit<Prisma.ImportRowCreateManyInput, 'tenantId' | 'batchId'>;

export class CsvProblem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const csvOptions = { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true, max_record_size: 8192 };
const utf8 = () => new TextDecoder('utf-8', { fatal: true });

export function readHeaders(file: Buffer): string[] {
  try {
    const parsed = csvHeader(utf8().decode(file), { ...csvOptions, to: 1 }) as string[][];
    const headers = parsed[0];
    if (!headers?.length || headers.length > maxFields || headers.some((header) => !header || header.length > 120)) {
      throw new CsvProblem('CSV_HEADER_INVALID');
    }
    return headers;
  } catch (error) {
    throw error instanceof CsvProblem ? error : new CsvProblem('CSV_HEADER_INVALID');
  }
}

export function validateColumns(mapping: Mapping, headers: string[]) {
  const indexes = [mapping.date, mapping.description, mapping.reference, mapping.sourceId,
    ...(mapping.money.mode === 'signed' ? [mapping.money.amount] : [mapping.money.debit, mapping.money.credit]),
  ].filter((index): index is number => index !== undefined);
  return indexes.every((index) => index < headers.length) && new Set(indexes).size === indexes.length;
}

function bookingDate(raw: string, format: Mapping['dateFormat']) {
  if (format === 'ISO') return dateOnly.safeParse(raw).success ? raw : null;
  const matched = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/.exec(raw);
  if (!matched) return null;
  const [, first, , second, year] = matched;
  const day = format === 'DMY' ? first : second;
  const month = format === 'DMY' ? second : first;
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return dateOnly.safeParse(date).success ? date : null;
}

function decimal(raw: string) {
  const match = /^([+-]?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const value = BigInt(whole + fraction.padEnd(2, '0')) * (sign === '-' ? -1n : 1n);
  return value >= -MAX_KOBO && value <= MAX_KOBO ? value : null;
}

function amount(record: string[], mapping: Mapping['money']) {
  if (mapping.mode === 'signed') return decimal(record[mapping.amount]);
  const debit = record[mapping.debit] ? decimal(record[mapping.debit]) : 0n;
  const credit = record[mapping.credit] ? decimal(record[mapping.credit]) : 0n;
  if (debit === null || credit === null || debit < 0n || credit < 0n || (debit > 0n) === (credit > 0n)) return null;
  return credit - debit;
}

export function normalizeReference(value: string) {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

function parseRecord(record: string[], rowNumber: number, accountId: string, mapping: Mapping, count: number, start: string, end: string): ParsedRow {
  if (record.length !== count) return { rowNumber, error: 'Use the same number of fields as the header.' };
  const date = bookingDate(record[mapping.date], mapping.dateFormat);
  const description = record[mapping.description];
  const reference = mapping.reference === undefined ? null : record[mapping.reference] || null;
  const sourceId = mapping.sourceId === undefined ? null : record[mapping.sourceId] || null;
  const value = amount(record, mapping.money);
  if (!date) return { rowNumber, error: 'Enter a real date in the selected date format.' };
  if (date < start || date > end) return { rowNumber, error: 'Use a date within the confirmed statement coverage.' };
  if (!description || description.length > 512) return { rowNumber, error: 'Enter a description up to 512 characters.' };
  if ((reference?.length ?? 0) > 120 || (sourceId?.length ?? 0) > 120) return { rowNumber, error: 'Keep references and source IDs to 120 characters.' };
  if (value === null || value === 0n) return { rowNumber, error: 'Enter a nonzero decimal amount with at most two decimal places. For split columns, enter one positive side.' };
  const key = [accountId, date, value.toString(), normalizeReference(description), normalizeReference(reference ?? '')];
  return {
    rowNumber, bookingDate: toDateOnly(date), description, reference, sourceId, amountKobo: value,
    fingerprint: digest(JSON.stringify(key)),
    contentHash: digest(JSON.stringify([date, value.toString(), description, reference])),
  };
}

async function* decode(body: Readable) {
  const decoder = utf8();
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new CsvProblem('FILE_TOO_LARGE');
    yield decoder.decode(chunk, { stream: true });
  }
  yield decoder.decode();
}

export async function parseStatement(body: Readable, accountId: string, mapping: Mapping, headers: string[], start: string, end: string) {
  const rows: ParsedRow[] = [];
  const input = Readable.from(decode(body));
  const parser = csvParse(csvOptions);
  input.on('error', (error) => parser.destroy(error));
  input.pipe(parser);
  let row = 0;
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      row += 1;
      if (row === 1) continue;
      if (rows.length === maxRows) throw new CsvProblem('ROW_LIMIT_EXCEEDED');
      rows.push(parseRecord(record, row, accountId, mapping, headers.length, start, end));
    }
    return rows;
  } catch (error) {
    if (error instanceof CsvProblem) throw error;
    if (error instanceof TypeError && 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw new CsvProblem('CSV_ENCODING_INVALID');
    if (error instanceof Error && 'code' in error && String(error.code).startsWith('CSV_')) {
      if (rows.length === maxRows) throw new CsvProblem('ROW_LIMIT_EXCEEDED');
      return [...rows, { rowNumber: row + 1, error: 'Repair this malformed CSV row and upload the corrected file.' }];
    }
    throw error;
  } finally {
    input.destroy();
    body.destroy();
  }
}
