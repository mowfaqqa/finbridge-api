import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Database } from './database';
import { Problem } from './problem';

@Controller('health')
@ApiTags('health')
export class HealthController {
  constructor(private readonly database: Database) {}

  @Get()
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  async ready() {
    try {
      await this.database.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new Problem(503, 'DATABASE_UNAVAILABLE', 'Database unavailable');
    }
  }
}
