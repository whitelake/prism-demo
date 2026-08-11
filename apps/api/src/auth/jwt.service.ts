import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '@/common/app-error';

// PoC JWT 实现（HS256）
// 不引入 jsonwebtoken / @nestjs/jwt，避免新增依赖触发 pnpm 全量重装
//
// 候选人通过 token 路径鉴权，不走 JWT；
// 面试官走 JWT，有效期 12 小时（api-spec 1.2）。

interface JwtPayload {
  sub: string; // interviewer id
  name: string;
  iat: number;
  exp: number;
}

const HEADER = { alg: 'HS256', typ: 'JWT' };

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      'JWT_SECRET 未配置或长度不足（要求 ≥ 16 字符，PoC 阶段请用随机字符串）',
    );
  }
  return s as string;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(data: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return b64url(sig);
}

@Injectable()
export class JwtService {
  sign(payload: { sub: string; name: string }, ttlSec: number): string {
    const now = Math.floor(Date.now() / 1000);
    const full: JwtPayload = {
      ...payload,
      iat: now,
      exp: now + ttlSec,
    };
    const encHeader = b64url(JSON.stringify(HEADER));
    const encPayload = b64url(JSON.stringify(full));
    const data = `${encHeader}.${encPayload}`;
    const sig = sign(data, getSecret());
    return `${data}.${sig}`;
  }

  verify(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new AppError('UNAUTHORIZED', 'malformed token');
    }
    const [encHeader, encPayload, encSig] = parts as [
      string,
      string,
      string,
    ];
    const expectedSig = sign(`${encHeader}.${encPayload}`, getSecret());
    if (expectedSig !== encSig) {
      throw new AppError('UNAUTHORIZED', 'bad signature');
    }
    let payload: JwtPayload;
    try {
      payload = JSON.parse(b64urlDecode(encPayload).toString('utf8'));
    } catch {
      throw new AppError('UNAUTHORIZED', 'bad payload');
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      throw new AppError('UNAUTHORIZED', 'token expired');
    }
    return payload;
  }
}

// 12 小时（秒）—— api-spec 1.2
export const JWT_TTL_SEC = 12 * 60 * 60;
