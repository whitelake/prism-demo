import { Injectable, Logger } from '@nestjs/common';

export interface LlmCallLogEntry {
  assessmentId: string;
  purpose: 'examiner' | 'tool' | 'eval' | 'outline';
  model: string;
  temperature: number;
  requestMessages: unknown;
  responseRaw?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  status: 'success' | 'failed';
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

@Injectable()
export class LlmLogger {
  private readonly logger = new Logger(LlmLogger.name);
  private readonly store: LlmCallLogEntry[] = [];

  async logRequest(req: LlmLogRequest): Promise<string> {
    const id = `log_${this.store.length + 1}_${Date.now()}`;
    const entry: LlmCallLogEntry = {
      assessmentId: req.assessmentId,
      purpose: req.purpose,
      model: req.model,
      temperature: req.temperature,
      requestMessages: req.requestMessages,
      status: 'failed',
      ts: req.ts,
    };
    this.store.push(entry);
    this.logger.log(
      `[LlmLogger] logRequest id=${id} purpose=${req.purpose} model=${req.model} temp=${req.temperature}`,
    );
    return id;
  }

  async logResponse(id: string, res: LlmLogResponse): Promise<void> {
    const entry = this.store[Number(id.split('_')[1]) - 1];
    if (!entry) {
      this.logger.warn(`[LlmLogger] logResponse: id=${id} not found`);
      return;
    }
    entry.responseRaw = res.responseRaw;
    entry.promptTokens = res.promptTokens;
    entry.completionTokens = res.completionTokens;
    entry.latencyMs = res.latencyMs;
    entry.status = res.status;
    entry.errorMsg = res.errorMsg;
    this.logger.log(
      `[LlmLogger] logResponse id=${id} status=${res.status} latency=${res.latencyMs ?? '-'}ms`,
    );
  }

  all(): LlmCallLogEntry[] {
    return [...this.store];
  }

  clear(): void {
    this.store.length = 0;
  }
}
