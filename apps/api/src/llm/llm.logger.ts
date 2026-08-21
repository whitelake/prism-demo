import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { LlmCallLogPersister } from '../db/llm-call-log.persister';

export interface LlmCallLogEntry {
  id: string;
  assessmentId: string;
  purpose: 'examiner' | 'tool' | 'eval' | 'outline';
  model: string;
  temperature: number;
  requestMessages: unknown;
  responseRaw?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  status: 'pending' | 'success' | 'failed';
  errorMsg?: string;
  ts: Date;
}

export interface LlmLogRequest {
  assessmentId: string;
  purpose: LlmCallLogEntry['purpose'];
  requestMessages: unknown;
  model: string;
  temperature: number;
  ts: Date;
}

export interface LlmLogResponse {
  responseRaw?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  status: 'success' | 'failed';
  errorMsg?: string;
}

// PoC 不变量 4：模型调用唯一出口，请求前落库、成功落原始响应、失败落错误信息。
// 生产环境 DatabaseModule 提供 LlmCallLogPersister，真实落库到 llm_call_log 表。
// prompt 联调测试不连 mysql 时，Persister 注入为 null，仅内存镜像——
// 不变量测试（test:invariants）需连真实 mysql 验证落库行为。
@Injectable()
export class LlmLogger {
  private readonly logger = new Logger(LlmLogger.name);
  private readonly mirror: LlmCallLogEntry[] = [];
  private seq = 0;

  // 用 string token + @Optional() 让 LlmLogger 不强依赖 Persister
  // 联调测试不连 mysql 时，token 找不到 → 注入 null → 内存回退
  // 生产 DatabaseModule 提供 token → 真实落库
  constructor(
    @Optional() @Inject('LLM_CALL_LOG_PERSISTER')
    private readonly persister: LlmCallLogPersister | null,
  ) {}

  async logRequest(req: LlmLogRequest): Promise<string> {
    let id: string;
    if (this.persister) {
      id = await this.persister.insertRequest({
        assessmentId: req.assessmentId,
        purpose: req.purpose,
        model: req.model,
        temperature: req.temperature,
        requestMessages: req.requestMessages,
        ts: req.ts,
      });
    } else {
      this.seq += 1;
      id = `mem_${this.seq}_${Date.now()}`;
    }
    const entry: LlmCallLogEntry = {
      id,
      assessmentId: req.assessmentId,
      purpose: req.purpose,
      model: req.model,
      temperature: req.temperature,
      requestMessages: req.requestMessages,
      status: 'pending',
      ts: req.ts,
    };
    this.mirror.push(entry);
    this.logger.log(
      `[LlmLogger] logRequest id=${id} purpose=${req.purpose} model=${req.model} temp=${req.temperature}${this.persister ? '' : ' (memory)'}`,
    );
    return id;
  }

  async logResponse(id: string, res: LlmLogResponse): Promise<void> {
    if (this.persister) {
      await this.persister.updateResponse(id, res);
    }
    const entry = this.mirror.find((e) => e.id === id);
    if (entry) {
      entry.responseRaw = res.responseRaw;
      entry.promptTokens = res.promptTokens;
      entry.completionTokens = res.completionTokens;
      entry.latencyMs = res.latencyMs;
      entry.status = res.status;
      entry.errorMsg = res.errorMsg;
    }
    this.logger.log(
      `[LlmLogger] logResponse id=${id} status=${res.status} latency=${res.latencyMs ?? '-'}ms`,
    );
  }

  all(): LlmCallLogEntry[] {
    return [...this.mirror];
  }

  clear(): void {
    this.mirror.length = 0;
  }
}
