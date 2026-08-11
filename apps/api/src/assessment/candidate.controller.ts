import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CandidateTokenGuard } from '@/auth/candidate-token.guard';
import { getRequestAssessmentId } from '@/auth/jwt-auth.guard';
import { AssessmentService } from './assessment.service';
import { loadQuestionnaire } from '@/questionnaire/questionnaire.config';
import { AppError } from '@/common/app-error';

interface StartDto {
  confirmedName?: string;
}

interface QuestionnaireAnswersDto {
  answers?: Record<string, unknown>;
}

interface MessageDto {
  content?: string;
}

// 候选人接口（token 路径鉴权，无需登录）
// 路由前缀：/c/{token}/...
@Controller('c/:token')
@UseGuards(CandidateTokenGuard)
export class CandidateController {
  constructor(
    private readonly assessments: AssessmentService,
  ) {}

  @Get()
  async entry(@Req() req: Request) {
    const assessmentId = getRequestAssessmentId(req);
    return this.assessments.getEntry(assessmentId);
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(@Req() req: Request, @Body() body: StartDto) {
    if (!body || typeof body.confirmedName !== 'string') {
      throw new AppError('PARAM_INVALID', 'confirmedName required');
    }
    const assessmentId = getRequestAssessmentId(req);
    return this.assessments.start(assessmentId, body.confirmedName);
  }

  @Get('questionnaire')
  async getQuestionnaire() {
    const questions = loadQuestionnaire();
    return {
      questions: questions.map((q) => ({
        code: q.id,
        type: q.id === 'Q2' ? 'multiple' : 'single',
        title: q.text,
        options: q.options.map((o) => ({ value: o.value, label: o.label })),
        required: true,
        ...(q.id === 'Q2' ? { minSelect: 1 } : {}),
      })),
    };
  }

  @Post('questionnaire')
  @HttpCode(HttpStatus.OK)
  async submitQuestionnaire(
    @Req() req: Request,
    @Body() body: QuestionnaireAnswersDto,
  ) {
    const assessmentId = getRequestAssessmentId(req);
    // api-spec 3.4：请求体为 { answers: { Q1: ..., Q2: [...], ... } }
    // 内部 service 仍用 q1..q5 字段名（与 entity 对齐）
    const answers = (body?.answers ?? {}) as Record<string, unknown>;
    const result = await this.assessments.submitQuestionnaireLight(assessmentId, {
      q1: answers['Q1'] as string | undefined,
      q2: answers['Q2'],
      q3: answers['Q3'] as string | undefined,
      q4: answers['Q4'] as string | undefined,
      q5: answers['Q5'] as string | undefined,
    });
    // 对齐 api-spec 3.4：响应体为 StepResponse（含 step='examiner'、messages、timer）
    // 首问异步生成，messages 为空，前端进对话页后轮询 GET /state 拉取
    return result.next;
  }

  @Get('state')
  async getState(@Req() req: Request) {
    const assessmentId = getRequestAssessmentId(req);
    return this.assessments.getState(assessmentId);
  }

  // PoC 步骤 3：考官模式候选人消息
  // PRD 4.2 / api-spec 3.5：返回 newMessages（增量）+ stageAdvanced + timer
  // 不变量 3：响应体不含 signals（仅落库 dialogue_log.signals）
  // 不变量 5：阶段推进由后端状态机决定，模型只提供 signals
  @Post('message')
  @HttpCode(HttpStatus.OK)
  async postMessage(@Req() req: Request, @Body() body: MessageDto) {
    if (!body || typeof body.content !== 'string' || body.content.length < 1 || body.content.length > 5000) {
      throw new AppError('PARAM_INVALID', 'content must be 1–5000 chars');
    }
    const assessmentId = getRequestAssessmentId(req);
    return this.assessments.examiner.handleCandidateMessage(assessmentId, body.content);
  }

  // PoC 步骤 4：工具模式 SSE 流式（api-spec 3.6）
  // PRD 4.3 / api-spec 3.6：accepted → delta* → done
  // 不变量 1：buildToolContext 三重过滤 + 静态 prompt
  // 不变量 3：tool 模式 signals 始终为 null
  // 不变量 4：callStream 走 LlmClient 唯一出口 + 全量落库
  // 重试幂等性（api-spec 3.6）暂不实现，PoC 标注 TODO
  @Post('message/stream')
  async postMessageStream(
    @Req() req: Request,
    @Body() body: MessageDto,
    @Res() res: Response,
  ): Promise<void> {
    if (!body || typeof body.content !== 'string' || body.content.length < 1 || body.content.length > 5000) {
      res.status(400).json({ code: 'PARAM_INVALID', message: 'content must be 1–5000 chars' });
      return;
    }
    const assessmentId = getRequestAssessmentId(req);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx 关闭 buffering
    res.flushHeaders?.();

    try {
      for await (const ev of this.assessments.tool.handleCandidateMessageStream(
        assessmentId,
        body.content,
      )) {
        res.write(`event: ${ev.event}\n`);
        res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.write(`event: error\ndata: ${JSON.stringify({ code: 'INTERNAL_ERROR', message })}\n\n`);
    } finally {
      res.end();
    }
  }

  // PoC 步骤 4：完成当前任务
  // PRD 4.3 / api-spec 3.7：T1→T2 切换 / T2 完成进入 EVALUATING
  @Post('task/complete')
  @HttpCode(HttpStatus.OK)
  async taskComplete(@Req() req: Request) {
    const assessmentId = getRequestAssessmentId(req);
    return this.assessments.tool.completeTask(assessmentId);
  }

  // PoC 步骤 5：超时跳过
  // PRD 4.7 / api-spec 3.8：idle_timeout / task_timeout 触发推进
  // 不变量 5：推进由后端状态机决策
  @Post('skip')
  @HttpCode(HttpStatus.OK)
  async skip(@Req() req: Request) {
    const assessmentId = getRequestAssessmentId(req);
    return this.assessments.skip(assessmentId);
  }
}
