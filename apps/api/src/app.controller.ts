import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// 健康检查接口（用于 docker healthcheck / nginx 探活）
// GET /api/v1/health → { status: 'ok', db: 'up'|'down', ts }
// 不暴露业务字段，不要求鉴权

@Controller('health')
export class AppController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Get()
  async health(): Promise<{ status: 'ok'; db: 'up' | 'down'; ts: string }> {
    let db: 'up' | 'down' = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }
    return { status: 'ok', db, ts: new Date().toISOString() };
  }
}
