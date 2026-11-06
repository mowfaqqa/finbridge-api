import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { readConfig } from './config';

@Injectable()
export class ObjectStorage implements OnModuleDestroy {
  private readonly config = readConfig();
  private readonly client = new S3Client({
    region: this.config.S3_REGION,
    endpoint: this.config.S3_ENDPOINT,
    forcePathStyle: !!this.config.S3_ENDPOINT,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: this.config.S3_ACCESS_KEY && this.config.S3_SECRET_KEY
      ? { accessKeyId: this.config.S3_ACCESS_KEY, secretAccessKey: this.config.S3_SECRET_KEY }
      : undefined,
    maxAttempts: 2,
  });

  put(key: string, body: Buffer, type: string) {
    return this.client.send(new PutObjectCommand({
      Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentLength: body.length, ContentType: type,
    }), { abortSignal: AbortSignal.timeout(20_000) });
  }

  async open(key: string, range?: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Range: range }), {
      abortSignal: AbortSignal.timeout(20_000),
    });
    if (!result.Body) throw new Error('Object is unavailable');
    return { body: result.Body as Readable, contentLength: result.ContentLength, contentRange: result.ContentRange };
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), {
      abortSignal: AbortSignal.timeout(20_000),
    });
  }

  onModuleDestroy() {
    this.client.destroy();
  }
}
