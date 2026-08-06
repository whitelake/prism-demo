import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmCallLogEntity } from './entities/llm-call-log.entity';

export interface LlmLogPersistRequest {
  assessmentId: string;
  purpose: string;
  model: string;
  temperature: number;
  requestMessages: unknown;
  ts: Date;
}

export interface LlmLogPersistResponse {
  responseRaw?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  status: 'success' | 'failed';
  errorMsg?: string;
}

// PoC 不变量 4：模型调用日志落库到 llm_call_log 表
// LlmLogger 通过 @Optional() 注入此 Persister；无 DB 时仅内存镜像（联调测试）
@Injectable()
export class LlmCallLogPersister {
  private readonly logger = new Logger(LlmCallLogPersister.name);

  constructor(
    @InjectRepository(LlmCallLogEntity)
    private readonly repo: Repository<LlmCallLogEntity>,
  ) {}

  async insertRequest(req: LlmLogPersistRequest): Promise<string> {
    const entity = this.repo.create({
      assessmentId: req.assessmentId ?? null,
      purpose: req.purpose,
      model: req.model,
      temperature: req.temperature,
      requestMessages: JSON.stringify(req.requestMessages),
      responseRaw: null,
      promptTokens: null,
      completionTokens: null,
      latencyMs: null,
      status: 'failed',
      errorMsg: null,
      ts: req.ts,
    });
    const saved = await this.repo.save(entity);
    return String(saved.id);
  }

  async updateResponse(id: string, res: LlmLogPersistResponse): Promise<void> {
    await this.repo.update(id, {
      responseRaw: res.responseRaw ?? null,
      promptTokens: res.promptTokens ?? null,
      completionTokens: res.completionTokens ?? null,
      latencyMs: res.latencyMs ?? null,
      status: res.status,
      errorMsg: res.errorMsg ?? null,
    });
  }
}
