import { ApiBody, ApiResponse, type SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import { Problem } from './problem';

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string[]> = Object.create(null);
  for (const issue of result.error.issues) {
    (fields[issue.path.join('.') || '_form'] ??= []).push(issue.message);
  }
  throw new Problem(422, 'INVALID_INPUT', 'Check the highlighted fields', fields);
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): SchemaObject {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as SchemaObject;
}

export const ApiInput = (schema: z.ZodType) => ApiBody({ schema: jsonSchema(schema, 'input') });
export const ApiOutput = (status: number, schema: z.ZodType) =>
  ApiResponse({ status, schema: jsonSchema(schema, 'output') });

export const uuid = z.uuid();
export const dateTime = z.iso.datetime();
export const role = z.enum(['OWNER', 'OPERATOR', 'VIEWER']);
export const workspaceView = z.object({
  id: uuid,
  slug: z.string(),
  displayName: z.string(),
  sector: z.string().nullable(),
  role,
  version: z.number().int(),
});
export const actorView = z.object({ id: uuid, verifiedEmail: z.email().nullable() });

export function resourceId(value: string) {
  if (!uuid.safeParse(value).success) throw new Problem(404, 'NOT_FOUND', 'Resource unavailable');
  return value;
}

export const version = z.number().int().min(1);
