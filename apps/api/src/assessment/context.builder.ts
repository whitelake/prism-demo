import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { loadPrompt } from '@/llm/prompt-loader';
import { interpolate, assertNoVariables } from '@/llm/interpolator';
import { getStageConfig } from './stages.config';
import { loadTasks, getTask } from './tasks.config';

// PoC 不变量 1：工具模式上下文严格隔离
// 详见 docs/architecture.md 4.1、.claude/rules/poc-invariants.md 第1条
//
// 三条强制约束（架构 4.1）：
// 1. 工具模式 System Prompt 是静态常量，不接受任何变量注入
// 2. 任务描述不进模型上下文（由 tasks.yaml 读取，直接由 API 返回前端）
// 3. 请求元数据脱敏（调用百炼时不传 user 字段或传随机UUID，不传 assessmentId）

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DialogueRow {
  mode: string;
  stageOrTask: string;
  role: string; // 'ai' | 'candidate'
  content: string;
}

// 工具模式 System Prompt 是静态常量——loadPrompt 不接受任何参数
// 此处显式 assertNoVariables，任何对 prompts/tool.md 引入 {{...}} 的修改都会在测试和启动时失败
let toolPromptCached: string | null = null;
function getToolPrompt(): string {
  if (toolPromptCached === null) {
    const raw = loadPrompt('tool');
    assertNoVariables(raw);
    toolPromptCached = raw;
  }
  return toolPromptCached;
}

function toMessage(row: DialogueRow): ChatMessage {
  // PRD 5.1 / 架构 4.1：dialogue_log.role = ai | candidate | system_card
  // 映射为 OpenAI 兼容消息：ai → assistant, candidate → user
  // system_card 行只服务于前端展示，不参与模型上下文（不变量 1）
  if (row.role === 'ai') return { role: 'assistant', content: row.content };
  return { role: 'user', content: row.content };
}

function orderRowsByTs(rows: DialogueLogEntity[]): DialogueRow[] {
  return [...rows]
    .sort((a, b) => a.ts.getTime() - b.ts.getTime())
    .filter((r) => r.role === 'ai' || r.role === 'candidate')
    .map((r) => ({
      mode: r.mode,
      stageOrTask: r.stageOrTask,
      role: r.role,
      content: r.content,
    }));
}

@Injectable()
export class ContextBuilder {
  constructor(
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    @InjectRepository(QuestionnaireResultEntity)
    private readonly questionnaireRepo: Repository<QuestionnaireResultEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
  ) {}

  // 考官模式：携带问卷 + 阶段目标 + 考官模式全部历史
  // 关键硬过滤：mode='examiner'（不混入工具模式记录）
  async buildExaminerContext(
    assessmentId: string,
    stageCode: 'S1.1' | 'S1.2' | 'S1.3',
    turnIndex: number,
  ): Promise<ChatMessage[]> {
    const [assessment, questionnaire, historyRows] = await Promise.all([
      this.assessmentRepo.findOne({ where: { id: assessmentId } }),
      this.questionnaireRepo.findOne({ where: { assessmentId } }),
      this.dialogueRepo.find({
        where: { assessmentId, mode: 'examiner' },
        order: { ts: 'ASC' },
      }),
    ]);

    if (!assessment) {
      throw new Error(`assessment not found: ${assessmentId}`);
    }

    const stage = getStageConfig(stageCode);
    const promptTemplate = loadPrompt('examiner');
    const systemContent = interpolate(promptTemplate, {
      candidate_name: assessment.candidateName,
      position: assessment.position ?? '（未填）',
      stage_code: stageCode,
      stage_goal: stage.goal,
      max_turns: stage.max_turns,
      turn_index: turnIndex,
      questionnaire_result: renderQuestionnaire(questionnaire),
    });

    const history = orderRowsByTs(historyRows).map(toMessage);
    return [{ role: 'system', content: systemContent }, ...history];
  }

  // 工具模式：仅含本任务的候选人输入与AI回复
  // 三重硬过滤：assessmentId + mode='tool' + stageOrTask=taskId
  // 不含问卷、不含候选人姓名、不含考官模式历史、不含任务描述
  async buildToolContext(
    assessmentId: string,
    taskId: string,
  ): Promise<ChatMessage[]> {
    const historyRows = await this.dialogueRepo.find({
      where: {
        assessmentId,
        mode: 'tool',
        stageOrTask: taskId,
      },
      order: { ts: 'ASC' },
    });

    const history = orderRowsByTs(historyRows).map(toMessage);
    return [{ role: 'system', content: getToolPrompt() }, ...history];
  }
}

function renderQuestionnaire(q: QuestionnaireResultEntity | null): string {
  if (!q) return '（问卷未提交）';
  return [
    `Q1: ${q.q1 ?? '（空）'}`,
    `Q2: ${JSON.stringify(q.q2 ?? '（空）')}`,
    `Q3: ${q.q3 ?? '（空）'}`,
    `Q4: ${q.q4 ?? '（空）'}`,
    `Q5: ${q.q5 ?? '（空）'}`,
  ].join('\n');
}

export { loadTasks, getTask };
