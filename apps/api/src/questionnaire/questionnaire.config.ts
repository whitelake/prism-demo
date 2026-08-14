import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { AppError } from '@/common/app-error';

// 与 config/questionnaire.yaml v0.1 对齐。
// 问卷不参与定级（evaluation.md R2：问卷属 E1 证据），
// 仅产出 claimed_level 锚点 / 路由 / 一致性比对 三个用途。

export interface QuestionnaireOption {
  value: string;
  label: string;
  // 路由档位：D1/D2 的选项可标注，供 examiner 决定追问重点
  routing_level?: string;
  // 选项对应的 probe 文案（路由用，非必填）
  probe?: string;
  // 选项声称档位：参与 claimed_level 推导的选项需标注
  claim_level?: string;
  // 该选项声称触发的门槛（合取条件）
  claims_gate?: string[];
}

export interface QuestionDef {
  id: string; // 'Q1'..'Q5'
  dimension?: string; // 'D1'..'D4'
  facet?: string;
  // 关联门槛（如 d2_decomposition / d3_verification / d4_personal_asset / d4_spillover）
  gate?: string | string[];
  // 是否参与 claimed_level 推导
  counts_toward_claim?: boolean;
  // 是否参与 floor_gate（前置闸门）
  participates_in_floor_gate?: boolean;
  text: string;
  options: QuestionnaireOption[];
}

interface QuestionnaireFile {
  version?: string;
  presentation?: Record<string, unknown>;
  questions: QuestionDef[];
  derivation?: Record<string, unknown>;
  routing_rules?: unknown[];
  consistency_checks?: unknown[];
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
// v0.1：所有题目均为单选（含 Q2 场景广度，原多选已改为单选枚举）
@Injectable()
export class QuestionnaireService {
  constructor(
    @InjectRepository(QuestionnaireResultEntity)
    private readonly repo: Repository<QuestionnaireResultEntity>,
  ) {}

  async submit(
    assessmentId: string,
    answers: { q1?: string; q2?: string; q3?: string; q4?: string; q5?: string },
  ): Promise<{ submittedAt: Date }> {
    const questions = loadQuestionnaire();
    const byCode: Record<string, string> = {};
    for (const q of questions) {
      const code = q.id;
      const key = code.toLowerCase();
      const ans = (answers as Record<string, unknown>)[key];
      if (ans === undefined || ans === null || ans === '') {
        throw new AppError('QUESTIONNAIRE_INVALID', { code });
      }
      if (typeof ans !== 'string') {
        throw new AppError('QUESTIONNAIRE_INVALID', { code, reason: 'must be string' });
      }
      const validValues = new Set(q.options.map((o) => o.value));
      if (!validValues.has(ans)) {
        throw new AppError('QUESTIONNAIRE_INVALID', { code, value: ans });
      }
      byCode[code] = ans;
    }

    const existing = await this.repo.findOne({ where: { assessmentId } });
    if (existing) {
      throw new AppError('ALREADY_SUBMITTED', { assessmentId });
    }
    const now = new Date();
    const row = this.repo.create({
      assessmentId,
      q1: byCode['Q1'] ?? null,
      q2: byCode['Q2'] ?? null,
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
