import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtService } from './jwt.service';
import { AppError } from '@/common/app-error';

// 面试官 JWT 守卫
// api-spec 1.2：Authorization: Bearer {jwt}，有效期 12 小时
// 校验失败统一 401 UNAUTHORIZED

export interface RequestUser {
  interviewerId: string;
  interviewerName: string;
}

// PoC：因 @types/express-serve-static-core 未 hoisted 到 apps/api，
// 用类型断言代替 module augmentation。Controller 中通过 getRequestUser(req) 取值。
export function getRequestUser(req: Request): RequestUser {
  const u = (req as unknown as { user?: RequestUser }).user;
  if (!u) {
    throw new AppError('UNAUTHORIZED', 'no user on request');
  }
  return u;
}

export function getRequestAssessmentId(req: Request): string {
  const id = (req as unknown as { assessmentId?: string }).assessmentId;
  if (!id) {
    throw new AppError('TOKEN_INVALID', 'no assessmentId on request');
  }
  return id;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 'missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    const payload = this.jwt.verify(token);
    (req as unknown as { user: RequestUser }).user = {
      interviewerId: payload.sub,
      interviewerName: payload.name,
    };
    return true;
  }
}
