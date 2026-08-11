import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { AppError } from '@/common/app-error';

// 候选人 token 守卫
// api-spec 1.2：URL 路径中的 token，32 位随机字符串，与测评一对一
// 校验失败统一 401 TOKEN_INVALID；测评已放弃时 410 ASSESSMENT_ABANDONED
@Injectable()
export class CandidateTokenGuard implements CanActivate {
  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = (req.params as { token?: string }).token;
    if (!token || token.length !== 32) {
      throw new AppError('TOKEN_INVALID', 'token format');
    }
    const assessment = await this.assessmentRepo.findOne({ where: { token } });
    if (!assessment) {
      throw new AppError('TOKEN_INVALID', 'no such assessment');
    }
    if (assessment.status === AssessmentStatus.ABANDONED) {
      throw new AppError('ASSESSMENT_ABANDONED');
    }
    (req as unknown as { assessmentId: string }).assessmentId = assessment.id;
    return true;
  }
}
