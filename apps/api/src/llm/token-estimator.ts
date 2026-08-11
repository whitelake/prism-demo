// 输入 token 启发式估算
//
// 用于 R3（architecture.md 第10章）：终判调用前估算 system+user 消息总 tokens，
// 超过 max_input_tokens 时由 llm.client 抛 INPUT_TOO_LONG。
//
// 不引入 tiktoken 等依赖：
//   1. PoC 要求实现简单且可审计（CLAUDE.md "不主动增加通用抽象"）
//   2. qwen 系列使用 BPE 分词，与 OpenAI cl100k_base 不完全一致
//   3. 估算误差 ±10% 在 40K 上限场景下足够（截断后仍有重试兜底）
//
// 启发式：
//   - CJK 统一表意字符：1 token / 字符
//   - 其他字符（含 ASCII、标点、空白）：约 4 字符 / token
//
// 该估算仅用于预检和截断决策，不写入 llm_call_log.prompt_tokens
// （后者由模型返回的 usage.prompt_tokens 真实值填充）。

const CJK_RANGE = /[一-鿿㐀-䶿]/u;

export function estimateTokens(input: string): number {
  if (!input) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of input) {
    if (CJK_RANGE.test(ch)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  // ASCII/其他按 4 字符 ≈ 1 token 估算
  return cjk + Math.ceil(other / 4);
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  // 每条消息约 4 token 的结构开销（role + 控制符），与 OpenAI cookbook 估算一致
  const overhead = 4;
  return messages.reduce(
    (sum, m) => sum + overhead + estimateTokens(m.content ?? ''),
    0,
  );
}
