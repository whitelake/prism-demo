import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import OpenAI from 'openai';
import { LlmLogger } from './llm.logger';
import {
  LlmPurpose,
  getPurposeParams,
  getRetryConfig,
  getBaseline,
  getPurposeModel,
  getApiBase,
  getApiKey,
} from './llm-params';
import { parseJsonResponse } from './json-parser';
import { estimateMessagesTokens } from './token-estimator';
import { InputTooLongError } from './input-too-long.error';
import type { ZodSchema } from 'zod';

export interface LlmCallParams<T> {
  assessmentId: string;
  purpose: LlmPurpose;
  systemPrompt: string;
  userMessages: OpenAI.ChatCompletionMessageParam[];
  schema?: ZodSchema<T>;
  // 调用方 override purpose 默认 temperature（如防重复护栏重试时提一档）
  // 不传则用 getPurposeParams(purpose).temperature
  temperatureOverride?: number;
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

// SSE 流式调用产出的事件类型（api-spec 3.6）
//   delta：文本增量，前端追加拼接
//   done：输出完毕，AI 回复已聚合落库
//   错误时由调用方捕获异常后由 controller 转 error 事件
export type StreamChunk =
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      fullText: string;
      logId: string;
      model: string;
      latencyMs: number;
      promptTokens?: number;
      completionTokens?: number;
    };

@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);

  constructor(private readonly llmLogger: LlmLogger) {}

  async call<T>(params: LlmCallParams<T>): Promise<LlmCallResult<T>> {
    const purposeParams = getPurposeParams(params.purpose);
    const baseline = getBaseline();
    const model = getPurposeModel(params.purpose);
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

    // R3（architecture.md 第10章）：调用前估算输入 tokens
    // 超过 purpose.max_input_tokens 时抛 InputTooLongError
    // 上层捕获后可按 R3 优先级截断重试；这里不写 llm_call_log
    // （未发起真实调用，落 log 会污染统计；上层失败会落 EVAL_FAILED）
    const maxInput = purposeParams.max_input_tokens ?? null;
    if (maxInput != null) {
      const estimated = estimateMessagesTokens(
        messages as Array<{ role: string; content: string }>,
      );
      if (estimated > maxInput) {
        throw new InputTooLongError({
          purpose: params.purpose,
          estimatedTokens: estimated,
          maxInputTokens: maxInput,
        });
      }
    }

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
      timeout: purposeParams.timeout_ms ?? baseline.timeout_ms,
    });

    const retry = getRetryConfig();
    let lastError: unknown = null;
    let lastRaw: string | undefined;
    let temperature = params.temperatureOverride ?? purposeParams.temperature;
    let jsonAttempt = 0;
    let schemaAttempt = 0;
    let netAttempt = 0;
    // 单次 call 的绝对上限：取两类重试预算的较大者，防止异常情况下死循环
    const hardCap = Math.max(
      retry.json_parse_fail.max_attempts,
      retry.network_timeout.max_attempts,
    );

    // 骨架阶段：流式聚合暂未实现，强制 stream=false 联调
    // SSE 流式分支在实现工具模式/考官模式实时下发时补齐
    const useStream = false;

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    for (let i = 0; i < hardCap; i++) {
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
          // qwen3 系列：DashScope OpenAI 兼容模式直接在 body 顶层传 enable_thinking
          // Node OpenAI SDK 不会自动解包 extra_body（那是 Python SDK 的行为）
          // 不写该字段时默认 true（开启思维链，单次 30-70s）
          ...(purposeParams.enable_thinking === false
            ? { enable_thinking: false }
            : {}),
        } as Parameters<typeof client.chat.completions.create>[0]);

        const raw = this.extractContent(
          completion as OpenAI.Chat.Completions.ChatCompletion,
        );
        lastRaw = raw;
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
        const isSchemaError = e instanceof Error && e.name === 'SchemaValidationError';
        const isEmptyContent = e instanceof Error && e.message === '[LlmClient] empty content in completion';

        // DashScope 在长 prompt + response_format=json_object 下偶发返回空 content，
        // 与 JSON 解析失败同策略重试（temperature 降一档）
        if (isJsonError || isEmptyContent) {
          jsonAttempt += 1;
          if (jsonAttempt < retry.json_parse_fail.max_attempts) {
            temperature = Math.max(0, temperature + retry.json_parse_fail.temperature_step);
            this.logger.warn(
              `[LlmClient] ${isJsonError ? 'JSON parse fail' : 'empty content'} attempt=${jsonAttempt}/${retry.json_parse_fail.max_attempts} retrying at temperature=${temperature}`,
            );
            continue;
          }
          break;
        }

        // schema 校验失败（LLM 返回 JSON 但缺字段或类型不符）：
        // 按 llm_params.retry.schema_validation_fail 重试（temperature 不变，再试一次）
        // 常见原因：qwen3.7-flash 偶发省略 signals 字段或把 question 写成空对象
        if (isSchemaError) {
          schemaAttempt += 1;
          if (schemaAttempt < retry.schema_validation_fail.max_attempts) {
            const step = retry.schema_validation_fail.temperature_step;
            temperature = Math.max(0, temperature + step);
            console.log(`[LlmClient] schema validation fail raw (attempt ${schemaAttempt}/${retry.schema_validation_fail.max_attempts}) =>`, lastRaw);
            this.logger.warn(
              `[LlmClient] schema validation fail attempt=${schemaAttempt}/${retry.schema_validation_fail.max_attempts} retrying at temperature=${temperature}`,
            );
            continue;
          }
          console.log(`[LlmClient] schema validation fail raw (final, giving up) =>`, lastRaw);
          break;
        }

        // 网络/超时类错误：按 llm_params.retry.network_timeout 退避重试
        // （OpenAI SDK 自身 maxRetries=2 已生效，LlmClient 再叠加一层退避，
        //   避免单次评估因瞬时抖动整体失败）
        if (isNetworkError(e)) {
          netAttempt += 1;
          if (netAttempt < retry.network_timeout.max_attempts) {
            const idx = Math.min(netAttempt - 1, retry.network_timeout.backoff_ms.length - 1);
            const backoff = retry.network_timeout.backoff_ms[idx] ?? 0;
            this.logger.warn(
              `[LlmClient] network error attempt=${netAttempt}/${retry.network_timeout.max_attempts} backing off=${backoff}ms err=${e instanceof Error ? e.message : String(e)}`,
            );
            await sleep(backoff);
            continue;
          }
          break;
        }

        // 不可重试：落库并抛出
        break;
      }
    }

    const latencyMs = Date.now() - startedAt;
    await this.llmLogger.logResponse(logId, {
      responseRaw: lastRaw,
      status: 'failed',
      errorMsg: String(lastError),
      latencyMs,
    });
    throw lastError ?? new Error('LlmClient.call failed');
  }

  // 流式调用（SSE / api-spec 3.6）
  // 与 call 共享 logRequest/logResponse 全量落库（不变量 4）
  // 不传 schema：流式仅产出文本增量，schema 解析在调用方完成后做（PoC 中 tool 模式不要求结构化输出）
  // 不重试：流式中断重试会重复输出，按 error 事件让前端整体重发
  async *callStream<T>(
    params: LlmCallParams<T>,
  ): AsyncGenerator<StreamChunk> {
    const purposeParams = getPurposeParams(params.purpose);
    const baseline = getBaseline();
    const model = getPurposeModel(params.purpose);
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

    // R3 输入超长检查（与 call 一致）
    const maxInput = purposeParams.max_input_tokens ?? null;
    if (maxInput != null) {
      const estimated = estimateMessagesTokens(
        messages as Array<{ role: string; content: string }>,
      );
      if (estimated > maxInput) {
        throw new InputTooLongError({
          purpose: params.purpose,
          estimatedTokens: estimated,
          maxInputTokens: maxInput,
        });
      }
    }

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
      timeout: purposeParams.timeout_ms ?? baseline.timeout_ms,
    });

    let fullText = '';
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    try {
      const stream = await client.chat.completions.create({
        model,
        messages,
        temperature: purposeParams.temperature,
        top_p: baseline.top_p,
        max_tokens: purposeParams.max_tokens,
        presence_penalty: baseline.presence_penalty,
        frequency_penalty: baseline.frequency_penalty,
        stream: true,
        stream_options: { include_usage: true },
        response_format: purposeParams.response_format
          ? { type: purposeParams.response_format }
          : undefined,
        ...(purposeParams.enable_thinking === false
          ? { enable_thinking: false }
          : {}),
      } as Parameters<typeof client.chat.completions.create>[0]);

      for await (const chunk of stream as AsyncIterable<
        OpenAI.Chat.Completions.ChatCompletionChunk
      >) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          fullText += delta;
          yield { type: 'delta', text: delta };
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }

      const latencyMs = Date.now() - startedAt;
      await this.llmLogger.logResponse(logId, {
        responseRaw: fullText,
        promptTokens,
        completionTokens,
        latencyMs,
        status: 'success',
      });

      yield {
        type: 'done',
        fullText,
        logId,
        model,
        latencyMs,
        promptTokens,
        completionTokens,
      };
    } catch (e) {
      const latencyMs = Date.now() - startedAt;
      await this.llmLogger.logResponse(logId, {
        responseRaw: fullText,
        latencyMs,
        status: 'failed',
        errorMsg: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
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

// OpenAI SDK 在网络层失败时抛 APIConnectionError / APIConnectionTimeoutError；
// DashScope 偶发 5xx 也按网络错误重试。
// 4xx（如 400/401/404 model_not_found）不在此处重试，直接抛。
function isNetworkError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  const name = (e as { constructor?: { name?: string } }).constructor?.name ?? '';
  if (
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError' ||
    name === 'APIReadTimeoutError'
  ) {
    return true;
  }
  const status = (e as { status?: number }).status;
  if (typeof status === 'number' && status >= 500) return true;
  // 兜底：消息含 "Connection error" / "ECONNRESET" / "ETIMEDOUT" 也按网络错误处理
  const msg = e instanceof Error ? e.message : String(e);
  return /Connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
}
