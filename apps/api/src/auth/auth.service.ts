import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InterviewerEntity } from '@/db/entities/interviewer.entity';
import { AppError } from '@/common/app-error';
import { JwtService, JWT_TTL_SEC } from './jwt.service';

// PoC 密码 hash：node:crypto scryptSync（不引入 bcrypt 避免新依赖）
// 格式：scrypt$N$r$p$saltHex$hashHex
const SCRYPT_KEYLEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1]!, 10);
  const r = parseInt(parts[2]!, 10);
  const p = parseInt(parts[3]!, 10);
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  const hash = crypto.scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
  });
  // 定时比较防侧信道
  return crypto.timingSafeEqual(hash, expected);
}

export interface AuthResult {
  token: string;
  expiresAt: Date;
  interviewer: { id: string; name: string };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(InterviewerEntity)
    private readonly interviewerRepo: Repository<InterviewerEntity>,
    private readonly jwt: JwtService,
  ) {}

  async login(account: string, password: string): Promise<AuthResult> {
    if (!account || !password) {
      throw new AppError('CREDENTIAL_INVALID');
    }
    const interviewer = await this.interviewerRepo.findOne({
      where: { account },
    });
    // 不区分账号不存在与密码错误
    if (!interviewer || !verifyPassword(password, interviewer.passwordHash)) {
      throw new AppError('CREDENTIAL_INVALID');
    }
    const token = this.jwt.sign(
      { sub: interviewer.id, name: interviewer.name },
      JWT_TTL_SEC,
    );
    const expiresAt = new Date(Date.now() + JWT_TTL_SEC * 1000);
    return {
      token,
      expiresAt,
      interviewer: { id: interviewer.id, name: interviewer.name },
    };
  }

  // 供 seed 脚本使用——创建面试官账号
  // 不暴露在 controller 上
  async createInterviewer(
    id: string,
    name: string,
    account: string,
    password: string,
  ): Promise<InterviewerEntity> {
    const existing = await this.interviewerRepo.findOne({ where: { account } });
    if (existing) {
      throw new Error(`interviewer with account ${account} already exists`);
    }
    const interviewer = this.interviewerRepo.create({
      id,
      name,
      account,
      passwordHash: hashPassword(password),
    });
    return this.interviewerRepo.save(interviewer);
  }
}

// 导出 hashPassword 供 seed 脚本调用（PoC 内部测试用）
export { hashPassword, verifyPassword };
