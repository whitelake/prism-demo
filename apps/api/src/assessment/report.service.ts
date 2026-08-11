import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { OutlineEntity } from '@/db/entities/outline.entity';
import { ConsistencyEntity } from '@/db/entities/consistency.entity';
import { LlmCallLogEntity } from '@/db/entities/llm-call-log.entity';
import {
  filterReport,
  filterListItem,
  buildExportPayload,
  type ReportFilterInput,
  type ReportDto,
  type ListItemDto,
  type ExportPayload,
  type EvaluationSummary,
  type JudgmentSummary,
  type OutlineSummary,
  type AssessmentReportMeta,
  type RawLogDto,
  type DialogueLogDtoItem,
} from './report.filter';
import { AssessmentStatus } from './assessment.state';
import { AppError } from '@/common/app-error';

// 报告服务：组装 ReportFilterInput 并调 filterReport
// 所有 GET /report 调用必须经过此服务（架构 4.2 强制约束1）
@Injectable()
export class ReportService {
  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
    @InjectRepository(QuestionnaireResultEntity)
    private readonly questionnaireRepo: Repository<QuestionnaireResultEntity>,
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    @InjectRepository(EvaluationEntity)
    private readonly evaluationRepo: Repository<EvaluationEntity>,
    @InjectRepository(InterviewerJudgmentEntity)
    private readonly judgmentRepo: Repository<InterviewerJudgmentEntity>,
    @InjectRepository(OutlineEntity)
    private readonly outlineRepo: Repository<OutlineEntity>,
    @InjectRepository(ConsistencyEntity)
    private readonly consistencyRepo: Repository<ConsistencyEntity>,
    @InjectRepository(LlmCallLogEntity)
    private readonly llmCallLogRepo: Repository<LlmCallLogEntity>,
  ) {}

  // GET /assessments/:id/report
  async getReport(
    id: string,
    interviewerId: string,
  ): Promise<ReportDto> {
    const input = await this.buildFilterInput(id, interviewerId);
    return filterReport(input);
  }

  // GET /assessments/:id/export
  async getExport(
    id: string,
    interviewerId: string,
  ): Promise<ExportPayload> {
    const input = await this.buildFilterInput(id, interviewerId);
    const consistency = await this.consistencyRepo.findOne({
      where: { assessmentId: id },
    });
    const llmCallLog = await this.llmCallLogRepo.find({
      where: { assessmentId: id },
      order: { ts: 'ASC' },
    });
    return buildExportPayload(
      input,
      consistency ?? null,
      llmCallLog,
    );
  }

  // 列表项过滤：组装 ListItemDto
  async getListItem(
    a: AssessmentEntity,
    evaluationA: EvaluationEntity | null,
  ): Promise<ListItemDto> {
    return filterListItem(
      toAssessmentReportMeta(a),
      evaluationA ? toEvaluationSummary(evaluationA) : null,
    );
  }

  async buildFilterInput(
    id: string,
    interviewerId: string,
  ): Promise<ReportFilterInput> {
    const a = await this.assessmentRepo.findOne({ where: { id } });
    if (!a) throw new AppError('NOT_FOUND', { id });
    if (a.interviewerId !== interviewerId) {
      throw new AppError('FORBIDDEN', { id, interviewerId });
    }

    const [questionnaire, dialogues, evaluations, judgment, outline] =
      await Promise.all([
        this.questionnaireRepo.findOne({ where: { assessmentId: id } }),
        this.dialogueRepo.find({
          where: { assessmentId: id },
          order: { ts: 'ASC' },
        }),
        this.evaluationRepo.find({ where: { assessmentId: id } }),
        this.judgmentRepo.findOne({ where: { assessmentId: id } }),
        this.outlineRepo.findOne({ where: { assessmentId: id } }),
      ]);

    const evalA =
      evaluations.find((e) => e.type === 'A') ?? null;
    const evalC =
      evaluations.find((e) => e.type === 'C') ?? null;

    const rawLog = toRawLogDto(dialogues, questionnaire);

    return {
      assessment: toAssessmentReportMeta(a),
      evaluationA: evalA ? toEvaluationSummary(evalA) : null,
      evaluationC: evalC ? toEvaluationSummary(evalC) : null,
      judgmentB: judgment ? toJudgmentSummary(judgment) : null,
      outline: outline ? toOutlineSummary(outline) : null,
      rawLog,
      failureInfo: null, // PoC 骨架：失败信息接入留待评估流程实现
    };
  }
}

function toAssessmentReportMeta(a: AssessmentEntity): AssessmentReportMeta {
  return {
    id: a.id,
    candidateName: a.candidateName,
    position: a.position,
    status: a.status as AssessmentStatus,
    submittedAt: a.submittedAt,
    createdAt: a.createdAt,
  };
}

function toEvaluationSummary(e: EvaluationEntity): EvaluationSummary {
  return {
    id: e.id,
    type: e.type as 'A' | 'C',
    level: e.level,
    track: e.track,
    confidence: Number(e.confidence),
    recommendHumanReview: e.recommendHumanReview,
    resultJson: e.resultJson,
    createdAt: e.createdAt,
  };
}

function toJudgmentSummary(j: InterviewerJudgmentEntity): JudgmentSummary {
  return {
    assessmentId: j.assessmentId,
    level: j.level,
    track: j.track,
    reason: j.reason,
    transcript: j.transcript,
    transcriptDraft: j.transcriptDraft,
    submittedAt: j.submittedAt,
  };
}

function toOutlineSummary(o: OutlineEntity): OutlineSummary {
  return {
    assessmentId: o.assessmentId,
    status: o.status,
    resultJson: o.resultJson,
    createdAt: o.createdAt,
  };
}

function toRawLogDto(
  dialogues: DialogueLogEntity[],
  q: QuestionnaireResultEntity | null,
): RawLogDto {
  const examinerDialogue: DialogueLogDtoItem[] = [];
  const toolDialogue: DialogueLogDtoItem[] = [];
  for (const d of dialogues) {
    const item: DialogueLogDtoItem = {
      mode: d.mode as 'examiner' | 'tool',
      stageOrTask: d.stageOrTask,
      turnIndex: d.turnIndex,
      role: d.role as 'ai' | 'candidate',
      content: d.content,
      responseIntervalSec: d.responseIntervalSec,
      ts: d.ts,
      signals: d.signals ?? undefined, // 由 filterReport.stripSignals 在常规接口剥离
    };
    if (d.mode === 'examiner') {
      examinerDialogue.push(item);
    } else {
      toolDialogue.push(item);
    }
  }
  const questionnaire = q
    ? {
        q1: q.q1,
        q2: q.q2,
        q3: q.q3,
        q4: q.q4,
        q5: q.q5,
        submittedAt: q.submittedAt,
      }
    : null;
  return { questionnaire, examinerDialogue, toolDialogue };
}
