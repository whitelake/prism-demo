// R3 截断策略（architecture.md 第10章）
//
// 输入超长时按优先级截断 full_log：
//   优先级1：工具模式 AI 回复（assistant 角色）→ 保留前 500 字 + "...(已截断)"
//   优先级2：考官模式 AI 提问 → 保留全文（不动）
//   优先级3：候选人输入 + 面试记录 → 绝不截断
//
// 截断后返回新对象；若无需截断（无 assistant 回复超 500 字），返回原对象引用，
// 调用方可通过 === 判断是否已应用截断。

export interface FullLogDialogueTurn {
  stage: string;
  turn: number;
  role: 'examiner' | 'candidate';
  content: string;
  ts: string;
  response_interval_sec?: number;
}

export interface FullLogToolTurn {
  turn: number;
  role: 'candidate' | 'assistant';
  content: string;
  ts: string;
  response_interval_sec?: number;
}

export interface FullLogToolTask {
  task_id: string;
  turns: FullLogToolTurn[];
  total_turns: number;
  duration_sec: number | null;
  ended_by: 'manual' | 'timeout' | null;
}

export interface FullLog {
  candidate: { name: string; position: string | null };
  questionnaire: Record<string, string | string[] | null>;
  examiner_dialogue: FullLogDialogueTurn[];
  stage_reached: string[];
  tool_tasks: FullLogToolTask[];
  interview_transcript: string | null;
}

export const TRUNCATE_THRESHOLD = 500;
export const TRUNCATE_SUFFIX = '...(已截断)';

export function truncateFullLog<T extends FullLog>(fullLog: T): T {
  let mutated = false;
  const toolTasks = fullLog.tool_tasks.map((task) => {
    const turns = task.turns.map((turn) => {
      if (
        turn.role === 'assistant' &&
        turn.content.length > TRUNCATE_THRESHOLD
      ) {
        mutated = true;
        return {
          ...turn,
          content: turn.content.slice(0, TRUNCATE_THRESHOLD) + TRUNCATE_SUFFIX,
        };
      }
      return turn;
    });
    return { ...task, turns };
  });
  if (!mutated) return fullLog;
  return { ...fullLog, tool_tasks: toolTasks };
}
