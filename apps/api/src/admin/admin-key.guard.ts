import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AppError } from '@/common/app-error';

// 管理 X-Admin-Key 守卫（api-spec 1.2 / 5.1）
// 与 JwtAuthGuard 互斥：admin 端点只挂本守卫，不要求 JWT
// 失败统一 401 ADMIN_KEY_INVALID；不区分"未配置"与"密钥不符"，避免探测

@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = process.env.ADMIN_KEY;
    if (!expected || expected === 'replace-with-strong-admin-key') {
      throw new AppError('ADMIN_KEY_INVALID', 'admin key not configured on server');
    }
    const provided = req.headers['x-admin-key'];
    if (typeof provided !== 'string' || provided !== expected) {
      throw new AppError('ADMIN_KEY_INVALID', 'admin key missing or mismatched');
    }
    return true;
  }
}
