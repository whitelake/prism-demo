import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { AppError } from '@/common/app-error';

export interface QuestionnaireOption {
  value: string;
  label: string;
}

export interface QuestionDef {
  id: string; // 'Q1'..'Q5'
  text: string;
  options: QuestionnaireOption[];
}

interface QuestionnaireFile {
  questions: QuestionDef[];
}

function findConfigDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config/questionnaire.yaml'))) {
      return path.join(dir, 'config');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../../config');
}

const CONFIG_PATH = path.join(findConfigDir(), 'questionnaire.yaml');

let cached: QuestionDef[] | null = null;

export function loadQuestionnaire(): QuestionDef[] {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as QuestionnaireFile;
  cached = parsed.questions;
  return cached;
}

export function clearQuestionnaireCache(): void {
  cached = null;
}

// 提交问卷：校验 + 落库
// 返回 question_code → answer_value 的映射（落库 entity 用 q1..q5 字段名）
@Injectable()
export class QuestionnaireService {
  constructor(
    @InjectRepository(QuestionnaireResultEntity)
    private readonly repo: Repository<QuestionnaireResultEntity>,
  ) {}

  async submit(
    assessmentId: string,
    answers: { q1?: string; q2?: unknown; q3?: string; q4?: string; q5?: string },
  ): Promise<{ submittedAt: Date }> {
    const questions = loadQuestionnaire();
    // 校验：每个 question 必答，answer 必须在 options.value 中
    const byCode: Record<string, string> = {};
    for (const q of questions) {
      const code = q.id; // 'Q1'..'Q5'
      const key = code.toLowerCase(); // 'q1'..'q5'
      const ans = (answers as Record<string, unknown>)[key];
      if (ans === undefined || ans === null || ans === '') {
        throw new AppError('QUESTIONNAIRE_INVALID', { code });
      }
      if (code === 'Q2') {
        // 多选：ans 应为数组，每个值在 options 中
        if (!Array.isArray(ans) || ans.length < 1) {
          throw new AppError('QUESTIONNAIRE_INVALID', { code, reason: 'q2 must be array' });
        }
        const validValues = new Set(q.options.map((o) => o.value));
        for (const v of ans) {
          if (!validValues.has(String(v))) {
            throw new AppError('QUESTIONNAIRE_INVALID', { code, value: v });
          }
        }
        byCode[code] = (ans as string[]).join(',');
      } else {
        if (typeof ans !== 'string') {
          throw new AppError('QUESTIONNAIRE_INVALID', { code, reason: 'must be string' });
        }
        const validValues = new Set(q.options.map((o) => o.value));
        if (!validValues.has(ans)) {
          throw new AppError('QUESTIONNAIRE_INVALID', { code, value: ans });
        }
        byCode[code] = ans;
      }
    }

    const existing = await this.repo.findOne({ where: { assessmentId } });
    if (existing) {
      throw new AppError('ALREADY_SUBMITTED', { assessmentId });
    }
    const now = new Date();
    const row = this.repo.create({
      assessmentId,
      q1: byCode['Q1'] ?? null,
      q2: answers.q2 ?? null,
      q3: byCode['Q3'] ?? null,
      q4: byCode['Q4'] ?? null,
      q5: byCode['Q5'] ?? null,
      submittedAt: now,
    });
    await this.repo.save(row);
    return { submittedAt: now };
  }

  async getSubmitted(assessmentId: string): Promise<QuestionnaireResultEntity | null> {
    return this.repo.findOne({ where: { assessmentId } });
  }
}

// 旧 API 名兼容（candidate.controller 直接调用模块函数）
export async function saveQuestionnaireResult(
  _assessmentId: string,
  _answers: unknown,
): Promise<never> {
  throw new Error('saveQuestionnaireResult is deprecated; use QuestionnaireService.submit');
}
