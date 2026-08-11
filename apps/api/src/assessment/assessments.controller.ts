import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  HttpStatus,
  Put,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard, getRequestUser } from '@/auth/jwt-auth.guard';
import { AssessmentService } from './assessment.service';
import { ReportService } from './report.service';
import { AppError } from '@/common/app-error';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

interface CreateAssessmentDto {
  candidateName?: string;
  position?: string;
}

interface JudgmentDto {
  level?: string;
  track?: string;
  reason?: string;
  transcript?: string;
  confirm?: boolean;
}

interface TranscriptDto {
  transcriptDraft?: string;
}

// 面试官接口（JWT 鉴权）
@Controller('assessments')
@UseGuards(JwtAuthGuard)
export class AssessmentsController {
  constructor(
    private readonly assessments: AssessmentService,
    private readonly reports: ReportService,
    @InjectRepository(EvaluationEntity)
    private readonly evaluationRepo: Repository<EvaluationEntity>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: Request, @Body() body: CreateAssessmentDto) {
    const user = getRequestUser(req);
    if (!body || typeof body.candidateName !== 'string') {
      throw new AppError('PARAM_INVALID', 'candidateName required');
    }
    const created = await this.assessments.create({
      candidateName: body.candidateName,
      position: typeof body.position === 'string' ? body.position : null,
      interviewerId: user.interviewerId,
    });
    const link = buildLink(req, created.token);
    return {
      id: created.id,
      token: created.token,
      link,
      status: created.status,
      createdAt: created.createdAt,
    };
  }

  @Get()
  async list(
    @Req() req: Request,
    @Query('status') status: string | undefined,
    @Query('keyword') keyword: string | undefined,
    @Query('page') pageQ: string | undefined,
    @Query('pageSize') pageSizeQ: string | undefined,
  ) {
    const user = getRequestUser(req);
    const page = parsePage(pageQ);
    const pageSize = parsePageSize(pageSizeQ);
    const result = await this.assessments.list(user.interviewerId, {
      status,
      keyword,
      page,
      pageSize,
    });
    const items = await Promise.all(
      result.items.map(async (a) => {
        const evalA = await this.evaluationRepo.findOne({
          where: { assessmentId: a.id, type: 'A' },
        });
        // 列表过滤（架构 4.2 强制约束2）
        return this.reports.getListItem(a, evalA);
      }),
    );
    return {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      items,
    };
  }

  @Get(':id/report')
  async getReport(@Req() req: Request, @Param('id') id: string) {
    const user = getRequestUser(req);
    // 报告出口唯一过滤点（架构 4.2 强制约束1）
    return this.reports.getReport(id, user.interviewerId);
  }

  @Get(':id/status')
  async getStatus(@Req() req: Request, @Param('id') id: string) {
    const user = getRequestUser(req);
    return this.assessments.getStatus(id, user.interviewerId);
  }

  @Get(':id/export')
  async getExport(@Req() req: Request, @Param('id') id: string) {
    const user = getRequestUser(req);
    return this.reports.getExport(id, user.interviewerId);
  }

  @Put(':id/transcript')
  async saveTranscriptDraft(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: TranscriptDto,
  ) {
    const user = getRequestUser(req);
    if (!body || typeof body.transcriptDraft !== 'string') {
      throw new AppError('PARAM_INVALID', 'transcriptDraft required');
    }
    return this.assessments.saveTranscriptDraft(
      id,
      user.interviewerId,
      body.transcriptDraft,
    );
  }

  @Post(':id/judgment')
  async submitJudgment(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: JudgmentDto,
  ) {
    const user = getRequestUser(req);
    if (!body || typeof body.level !== 'string') {
      throw new AppError('PARAM_INVALID', 'level required');
    }
    return this.assessments.submitJudgment(id, user.interviewerId, {
      level: body.level,
      track: body.track ?? '',
      reason: body.reason ?? '',
      transcript: body.transcript ?? '',
      confirm: body.confirm,
    });
  }

  // PoC 骨架占位：以下接口尚未实现
  @Post(':id/regenerate-link')
  async regenerateLink(@Param('id') id: string) {
    throw new AppError('NOT_IMPLEMENTED', { id, method: 'regenerate-link' });
  }

  @Post(':id/abandon')
  async abandon(@Req() req: Request, @Param('id') id: string) {
    const user = getRequestUser(req);
    const body = (req.body ?? {}) as { reason?: string };
    const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim().slice(0, 200)
      : '候选人主动退出';
    return this.assessments.abandon(id, user.interviewerId, reason);
  }

  @Post(':id/reevaluate')
  async reevaluate(@Req() req: Request, @Param('id') id: string) {
    const user = getRequestUser(req);
    return this.assessments.reevaluate(id, user.interviewerId);
  }
}

function parsePage(q: string | undefined): number {
  const p = Number(q ?? '1');
  if (!Number.isFinite(p) || p < 1) return 1;
  return Math.floor(p);
}

function parsePageSize(q: string | undefined): number {
  const p = Number(q ?? '20');
  if (!Number.isFinite(p) || p < 1) return 20;
  return Math.min(Math.floor(p), 100);
}

function buildLink(req: Request, token: string): string {
  // 候选人前端路由为 /c/:token（apps/web/src/App.tsx:18）
  // 优先用 WEB_BASE_URL（.env 配置，避免反代后 host/port/proto 丢失）；
  // 未配置时回退到请求 Host 头
  const base = process.env.WEB_BASE_URL;
  if (base) {
    return `${base.replace(/\/+$/, '')}/c/${token}`;
  }
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers['host'] ?? 'localhost';
  return `${proto}://${host}/c/${token}`;
}
