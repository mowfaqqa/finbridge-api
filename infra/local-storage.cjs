const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const S3rver = require('s3rver');

const directory = resolve(process.env.LOCAL_STORAGE_DIR ?? '.local-storage');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const server = new S3rver({
  address: '127.0.0.1',
  port: Number(process.env.LOCAL_STORAGE_PORT ?? '59000'),
  silent: true,
  directory,
  configureBuckets: [{ name: process.env.S3_BUCKET ?? 'finbridge-local' }],
});
server.run().then(() => {
  console.log('Local private object storage is ready.');
}).catch((error) => {
  console.error('Local object storage could not start:', error.code ?? error.name);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void server.close());
