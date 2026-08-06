import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import OpenAI from 'openai';
import { LlmLogger } from './llm.logger';
import {
  LlmPurpose,
  getPurposeParams,
  getRetryConfig,
  getBaseline,
  getModelName,
  getApiBase,
  getApiKey,
} from './llm-params';
import { parseJsonResponse } from './json-parser';
import type { ZodSchema } from 'zod';

export interface LlmCallParams<T> {
  assessmentId: string;
  purpose: LlmPurpose;
  systemPrompt: string;
  userMessages: OpenAI.ChatCompletionMessageParam[];
  schema?: ZodSchema<T>;
}

export interface LlmCallResult<T> {
  raw: string;
  parsed?: T;
  logId: string;
  model: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);

  constructor(private readonly llmLogger: LlmLogger) {}

  async call<T>(params: LlmCallParams<T>): Promise<LlmCallResult<T>> {
    const purposeParams = getPurposeParams(params.purpose);
    const baseline = getBaseline();
    const model = getModelName();
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new BadGatewayException(
        'DASHSCOPE_API_KEY not configured (PoC rule: all model calls go through LlmClient)',
      );
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: params.systemPrompt },
      ...params.userMessages,
    ];

    const startedAt = Date.now();
    const ts = new Date();
    const logId = await this.llmLogger.logRequest({
      assessmentId: params.assessmentId,
      purpose: params.purpose,
      requestMessages: messages,
      model,
      temperature: purposeParams.temperature,
      ts,
    });

    const client = new OpenAI({
      apiKey,
      baseURL: getApiBase(),
      timeout: baseline.timeout_ms,
    });

    const retry = getRetryConfig();
    let attempt = 0;
    let lastError: unknown = null;
    let temperature = purposeParams.temperature;

    // 骨架阶段：流式聚合暂未实现，强制 stream=false 联调
    // SSE 流式分支在实现工具模式/考官模式实时下发时补齐
    const useStream = false;

    while (attempt < retry.json_parse_fail.max_attempts) {
      attempt += 1;
      try {
        const completion = await client.chat.completions.create({
          model,
          messages,
          temperature,
          top_p: baseline.top_p,
          max_tokens: purposeParams.max_tokens,
          presence_penalty: baseline.presence_penalty,
          frequency_penalty: baseline.frequency_penalty,
          stream: useStream,
          response_format: purposeParams.response_format
            ? { type: purposeParams.response_format }
            : undefined,
        });

        const raw = this.extractContent(
          completion as OpenAI.Chat.Completions.ChatCompletion,
        );
        const latencyMs = Date.now() - startedAt;
        const nonStream = completion as OpenAI.Chat.Completions.ChatCompletion;
        const promptTokens = nonStream.usage?.prompt_tokens;
        const completionTokens = nonStream.usage?.completion_tokens;

        await this.llmLogger.logResponse(logId, {
          responseRaw: raw,
          promptTokens,
          completionTokens,
          latencyMs,
          status: 'success',
        });

        let parsed: T | undefined;
        if (params.schema) {
          parsed = parseJsonResponse(raw, params.schema);
        }

        return {
          raw,
          parsed,
          logId,
          model,
          latencyMs,
          promptTokens,
          completionTokens,
        };
      } catch (e) {
        lastError = e;
        const isJsonError = e instanceof Error && e.name === 'JsonParseError';
        const isEmptyContent = e instanceof Error && e.message === '[LlmClient] empty content in completion';
        // DashScope 在长 prompt + response_format=json_object 下偶发返回空 content，
        // 与 JSON 解析失败同策略重试（temperature 降一档）
        if (isJsonError || isEmptyContent) {
          temperature = Math.max(0, temperature + retry.json_parse_fail.temperature_step);
          this.logger.warn(
            `[LlmClient] ${isJsonError ? 'JSON parse fail' : 'empty content'} attempt=${attempt} retrying at temperature=${temperature}`,
          );
          continue;
        }
        // Non-retryable for now: log and break (network retry could be added later)
        break;
      }
    }

    const latencyMs = Date.now() - startedAt;
    await this.llmLogger.logResponse(logId, {
      status: 'failed',
      errorMsg: String(lastError),
      latencyMs,
    });
    throw lastError ?? new Error('LlmClient.call failed');
  }

  private extractContent(
    completion: OpenAI.Chat.Completions.ChatCompletion,
  ): string {
    const choice = completion.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('[LlmClient] empty content in completion');
    }
    return content;
  }
}
