import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export type LlmPurpose = 'examiner' | 'tool' | 'eval' | 'outline';

export interface PurposeParams {
  temperature: number;
  stream: boolean;
  max_tokens: number;
  response_format?: 'json_object' | null;
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
