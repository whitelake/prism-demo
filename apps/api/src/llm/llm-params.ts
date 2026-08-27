import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export type LlmPurpose = 'examiner' | 'tool' | 'eval' | 'outline';

export interface PurposeParams {
  temperature: number;
  stream: boolean;
  max_tokens: number;
  // R3（architecture.md 第10章）：输入 token 上限。null 表示不检查
  max_input_tokens?: number | null;
  response_format?: 'json_object' | null;
  // qwen3 系列默认开启 thinking 模式，会先生成思维链 token（不计入 max_tokens）
  // false 可关闭 thinking，单次延迟从 30-70s 降到 2-5s
  // examiner/tool 只需短问答或 JSON，关闭合理；eval/outline 需深思，保留默认
  enable_thinking?: boolean;
  // 单 purpose override baseline.timeout_ms；thinking 模式下 eval/outline 可能远超 60s
  timeout_ms?: number;
}

export interface RetryConfig {
  json_parse_fail: { max_attempts: number; temperature_step: number };
  schema_validation_fail: { max_attempts: number; temperature_step: number };
  network_timeout: { max_attempts: number; backoff_ms: number[] };
}

interface LlmParamsFile {
  baseline: {
    timeout_ms: number;
    max_tokens: number;
    max_input_tokens: number | null;
    top_p: number;
    presence_penalty: number;
    frequency_penalty: number;
    stream: boolean;
    response_format: 'json_object' | null;
  };
  retry: RetryConfig;
  purposes: Record<LlmPurpose, PurposeParams>;
}

function findConfigDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config/llm_params.yaml'))) {
      return path.join(dir, 'config');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../../config');
}

const CONFIG_PATH = path.join(findConfigDir(), 'llm_params.yaml');

let cached: LlmParamsFile | null = null;

export function loadLlmParams(): LlmParamsFile {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  cached = yaml.load(raw) as LlmParamsFile;
  return cached;
}

// 热更新：清空模块级缓存，下次 loadLlmParams 重新读盘
// 供 POST /api/v1/admin/reload-config 调用（api-spec 5.1）
export function clearLlmParamsCache(): void {
  cached = null;
}

export function getPurposeParams(purpose: LlmPurpose): PurposeParams {
  return loadLlmParams().purposes[purpose];
}

export function getRetryConfig(): RetryConfig {
  return loadLlmParams().retry;
}

export function getBaseline() {
  return loadLlmParams().baseline;
}

export function getModelName(): string {
  return process.env.LLM_MODEL ?? 'qwen-plus';
}

// 按用途选模型：对话/任务速度优先（qwen3.8-27b），评估/题纲能力优先（qwen3.8-max）
// 从 .env 配置：LLM_MODEL_DIALOG、LLM_MODEL_EVAL，回退到 LLM_MODEL
export function getPurposeModel(purpose: LlmPurpose): string {
  if (purpose === 'examiner' || purpose === 'tool') {
    return process.env.LLM_MODEL_DIALOG ?? process.env.LLM_MODEL ?? 'qwen-plus';
  }
  return process.env.LLM_MODEL_EVAL ?? process.env.LLM_MODEL ?? 'qwen-plus';
}

export function getApiBase(): string {
  return (
    process.env.DASHSCOPE_BASE_URL ??
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  );
}

export function getApiKey(): string | undefined {
  return process.env.DASHSCOPE_API_KEY;
}

export function isApiKeyConfigured(): boolean {
  const key = getApiKey();
  return !!key && key !== 'replace-with-real-key';
}
