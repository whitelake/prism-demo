// 输入超长错误（R3：architecture.md 第10章）
//
// llm.client 在调用模型前估算输入 tokens，超过 purpose 的 max_input_tokens 时抛出。
// 上层（如 final-evaluation.service）可捕获此错误，按 R3 优先级截断后重试。
//
// 不属于 HTTP 错误码总表：终判失败对外仍表现为 EVAL_FAILED，
// INPUT_TOO_LONG 仅用于服务内部决策截断/重试路径。

export class InputTooLongError extends Error {
  public readonly estimatedTokens: number;
  public readonly maxInputTokens: number;
  public readonly purpose: string;

  constructor(opts: {
    purpose: string;
    estimatedTokens: number;
    maxInputTokens: number;
  }) {
    super(
      `[LlmClient] input too long: estimated ${opts.estimatedTokens} tokens > max ${opts.maxInputTokens} (purpose=${opts.purpose})`,
    );
    this.name = 'InputTooLongError';
    this.estimatedTokens = opts.estimatedTokens;
    this.maxInputTokens = opts.maxInputTokens;
    this.purpose = opts.purpose;
  }
}
