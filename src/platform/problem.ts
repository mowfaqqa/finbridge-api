import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Request, Response } from 'express';

export class Problem extends HttpException {
  constructor(status: number, readonly code: string, readonly title: string, readonly fieldErrors?: Record<string, string[]>) {
    super(title, status);
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = String(response.getHeader('x-request-id') ?? '');
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const problem = exception instanceof Problem ? exception : undefined;
    const code = problem?.code ?? `HTTP_${status}`;
    if (status >= 500) {
      const error = exception instanceof Error ? exception.name : 'UnknownError';
      this.logger.error({ requestId, method: request.method, status, code, error });
    }
    response.status(status).type('application/problem+json').json({
      type: `urn:finbridge:problem:${code.toLowerCase().replaceAll('_', '-')}`,
      title: problem?.title ?? STATUS_CODES[status] ?? 'Request failed',
      status,
      code,
      requestId,
      ...(problem?.fieldErrors && { fieldErrors: problem.fieldErrors }),
    });
  }
}
