import { z } from 'zod';

const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  INVITATION_SECRET: z.string().min(32).optional(),
  LOCAL_AUTH_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export function readConfig() {
  const config = env.safeParse(process.env);
  if (!config.success) {
    const fields = config.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Invalid configuration: ${fields.join(', ')}`);
  }
  return { ...config.data, WEB_ORIGIN: new URL(config.data.WEB_ORIGIN).origin };
}
