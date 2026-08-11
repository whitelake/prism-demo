import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { OutlineEntity } from '@/db/entities/outline.entity';
import { ConsistencyEntity } from '@/db/entities/consistency.entity';
import { LlmCallLogEntity } from '@/db/entities/llm-call-log.entity';
import { LlmModule } from '@/llm/llm.module';
import { QuestionnaireModule } from '@/questionnaire/questionnaire.module';
import { AuthModule } from '@/auth/auth.module';
import { ContextBuilder } from './context.builder';
import { AssessmentService } from './assessment.service';
import { ReportService } from './report.service';
import { FinalEvaluationService } from './final-evaluation.service';
import { OutlineService } from './outline.service';
import { ExaminerService } from './examiner.service';
import { ToolService } from './tool.service';
import { InitialEvaluationService } from './initial-evaluation.service';
import { AssessmentsController } from './assessments.controller';
import { CandidateController } from './candidate.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssessmentEntity,
      QuestionnaireResultEntity,
      InterviewerJudgmentEntity,
      DialogueLogEntity,
      EvaluationEntity,
      OutlineEntity,
      ConsistencyEntity,
      LlmCallLogEntity,
    ]),
    LlmModule,
    QuestionnaireModule,
    AuthModule,
  ],
  providers: [
    ContextBuilder,
    AssessmentService,
    ReportService,
    FinalEvaluationService,
    OutlineService,
    ExaminerService,
    ToolService,
    InitialEvaluationService,
  ],
  controllers: [AssessmentsController, CandidateController],
  exports: [
    ContextBuilder,
    AssessmentService,
    ReportService,
    FinalEvaluationService,
    OutlineService,
    ExaminerService,
    ToolService,
    InitialEvaluationService,
  ],
})
export class AssessmentModule {}
