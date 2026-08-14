import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { OutlineEntity } from '@/db/entities/outline.entity';
import { LlmClient } from '@/llm/llm.client';
import { loadPrompt } from '@/llm/prompt-loader';
import { interpolate } from '@/llm/interpolator';
import { OutlineResponseSchema, type OutlineResponse } from '@/llm/schemas/outline.schema';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 题纲生成（架构 7.2 / PRD 4.6）
//
// 候选人提交后 status=EVALUATING，异步触发生成题纲（与评估 A 并行，互不依赖）。
// 输入：full_log（questionnaire + examiner_dialogue + tool_tasks，无 interview_transcript）
// 输出：3-5 条追问建议，落 outline 表
//
// 黑名单校验：命中任意正则的条目剔除；全失败 → status='blacklist_failed'
//
// 不变量4（LLM 统一出口）；不变量5（题纲输出不参与状态机推进）

interface FullLog {
  candidate: { name: string; position: string | null };
  questionnaire: Record<string, string | string[] | null>;
  examiner_dialogue: Array<{
    stage: string;
    turn: number;
    role: 'examiner' | 'candidate';
    content: string;
    ts: string;
  }>;
  stage_reached: string[];
  tool_tasks: Array<{
    task_id: string;
    turns: Array<{ turn: number; role: 'candidate' | 'assistant'; content: string; ts: string }>;
    total_turns: number;
  }>;
  interview_transcript: null;
}

interface BlacklistFile {
  patterns: string[];
}

@Injectable()
export class OutlineService {
  private readonly logger = new Logger(OutlineService.name);
  private readonly blacklist: RegExp[];

  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
    @InjectRepository(QuestionnaireResultEntity)
    private readonly questionnaireRepo: Repository<QuestionnaireResultEntity>,
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    @InjectRepository(OutlineEntity)
    private readonly outlineRepo: Repository<OutlineEntity>,
    private readonly llmClient: LlmClient,
  ) {
    this.blacklist = loadBlacklist();
  }

  // fire-and-forget：调用方不 await
  triggerAsync(assessmentId: string): void {
    void this.runOutline(assessmentId).catch((e: unknown) => {
      this.logger.error(
        `[outline] unexpected error for ${assessmentId}: ${
          e instanceof Error ? e.stack : String(e)
        }`,
      );
    });
  }

  async runOutline(assessmentId: string): Promise<{ status: string }> {
    const assessment = await this.assessmentRepo.findOne({ where: { id: assessmentId } });
    if (!assessment) {
      throw new Error(`assessment not found: ${assessmentId}`);
    }

    const fullLog = await this.buildFullLog(assessment);

    try {
      const systemPrompt = interpolate(loadPrompt('outline'), {
        full_log: fullLog,
      });

      const result = await this.llmClient.call({
        assessmentId,
        purpose: 'outline',
        systemPrompt,
        userMessages: [
          { role: 'user', content: '请基于上述日志输出 3-5 条追问建议。' },
        ],
        schema: OutlineResponseSchema,
      });
      const response = result.parsed as OutlineResponse;

      // 黑名单过滤：剔除命中条目
      const filteredQuestions = response.questions.filter((q) => {
        const text = `${q.ask} ${q.verify}`;
        return !this.blacklist.some((re) => re.test(text));
      });

      if (filteredQuestions.length === 0) {
        // 全部命中黑名单 → 视为生成失败
        await this.persistOutline(assessmentId, null, 'blacklist_failed');
        return { status: 'blacklist_failed' };
      }

      const filtered: OutlineResponse = {
        questions: filteredQuestions,
        note: response.note ?? '',
      };
      await this.persistOutline(assessmentId, filtered, 'success');
      return { status: 'success' };
    } catch (e) {
      this.logger.warn(
        `[outline] failed for ${assessmentId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      await this.persistOutline(assessmentId, null, 'blacklist_failed');
      return { status: 'blacklist_failed' };
    }
  }

  private async buildFullLog(assessment: AssessmentEntity): Promise<FullLog> {
    const [questionnaire, dialogues] = await Promise.all([
      this.questionnaireRepo.findOne({ where: { assessmentId: assessment.id } }),
      this.dialogueRepo.find({
        where: { assessmentId: assessment.id },
        order: { ts: 'ASC' },
      }),
    ]);

    const examinerDialogue = dialogues
      .filter((d) => d.mode === 'examiner')
      .map((d) => ({
        stage: d.stageOrTask,
        turn: d.turnIndex,
        role: (d.role === 'ai' ? 'examiner' : 'candidate') as 'examiner' | 'candidate',
        content: d.content,
        ts: d.ts.toISOString(),
      }));

    const stageReached = Array.from(new Set(examinerDialogue.map((d) => d.stage)));

    const toolRows = dialogues.filter((d) => d.mode === 'tool');
    const byTask = new Map<string, DialogueLogEntity[]>();
    for (const d of toolRows) {
      const arr = byTask.get(d.stageOrTask) ?? [];
      arr.push(d);
      byTask.set(d.stageOrTask, arr);
    }
    const toolTasks = Array.from(byTask.entries()).map(([taskId, rows]) => ({
      task_id: taskId,
      turns: rows.map((d, idx) => ({
        turn: idx + 1,
        role: (d.role === 'ai' ? 'assistant' : 'candidate') as 'assistant' | 'candidate',
        content: d.content,
        ts: d.ts.toISOString(),
      })),
      total_turns: rows.length,
    }));

    return {
      candidate: { name: assessment.candidateName, position: assessment.position },
      questionnaire: questionnaire
        ? {
            Q1: questionnaire.q1,
            Q2: questionnaire.q2,
            Q3: questionnaire.q3,
            Q4: questionnaire.q4,
            Q5: questionnaire.q5,
          }
        : {},
      examiner_dialogue: examinerDialogue,
      stage_reached: stageReached,
      tool_tasks: toolTasks,
      interview_transcript: null,
    };
  }

  private async persistOutline(
    assessmentId: string,
    result: OutlineResponse | null,
    status: 'success' | 'blacklist_failed',
  ): Promise<void> {
    // upsert：先删后插
    await this.outlineRepo.delete({ assessmentId });
    await this.outlineRepo.save({
      assessmentId,
      resultJson: result,
      status,
    });
  }
}

function loadBlacklist(): RegExp[] {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'config/outline_blacklist.yaml');
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = yaml.load(raw) as BlacklistFile;
      return (parsed.patterns ?? []).map((p) => new RegExp(p));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}
