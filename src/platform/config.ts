import { z } from 'zod';

const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  WORKER_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  REQUEST_LOG_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:56379'),
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  S3_BUCKET: z.string().min(1).default('finbridge-local'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  UPLOAD_TICKET_SECRET: z.string().min(32).optional(),
  OIDC_ISSUER: z.url({ protocol: /^https?$/ }).optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_FLOW_SECRET: z.string().min(32).optional(),
  INVITATION_SECRET: z.string().min(32).optional(),
  LOCAL_AUTH_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export function readConfig() {
  const config = env.safeParse(process.env);
  if (!config.success) {
    const fields = config.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Invalid configuration: ${fields.join(', ')}`);
  }
  const data = config.data;
  const origin = new URL(data.WEB_ORIGIN);
  if (data.NODE_ENV === 'production') {
    if (origin.protocol !== 'https:') throw new Error('WEB_ORIGIN must use HTTPS in production');
    if (!data.REDIS_URL.startsWith('rediss://')) throw new Error('REDIS_URL must use TLS in production');
    if (data.S3_ENDPOINT && !data.S3_ENDPOINT.startsWith('https://')) throw new Error('S3_ENDPOINT must use HTTPS in production');
  }
  const oidcFields = [data.OIDC_ISSUER, data.OIDC_CLIENT_ID, data.OIDC_CLIENT_SECRET, data.OIDC_FLOW_SECRET];
  if (oidcFields.some(Boolean) && !oidcFields.every(Boolean)) throw new Error('Set all four OIDC configuration values');
  if (Boolean(data.S3_ACCESS_KEY) !== Boolean(data.S3_SECRET_KEY)) throw new Error('Set both S3 credential values');
  const issuer = data.OIDC_ISSUER ? new URL(data.OIDC_ISSUER) : undefined;
  if (issuer && issuer.protocol !== 'https:' && !(data.NODE_ENV === 'test' && issuer.hostname === '127.0.0.1')) {
    throw new Error('OIDC_ISSUER must use HTTPS');
  }
  return { ...data, WEB_ORIGIN: origin.origin };
}
