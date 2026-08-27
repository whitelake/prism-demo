import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { AppError } from '@/common/app-error';
import { OutlineService } from '@/assessment/outline.service';
import { clearTasksCache, loadTasks } from '@/assessment/tasks.config';
import { clearStagesCache, loadStages } from '@/assessment/stages.config';
import { clearDimensionsCache, loadDimensions } from '@/assessment/dimensions.config';
import { clearCardsCache, loadCards } from '@/assessment/cards.config';
import { clearLevelsCache, loadLevels } from '@/assessment/levels.config';
import { clearQuestionnaireCache, loadQuestionnaire } from '@/questionnaire/questionnaire.config';
import { clearLlmParamsCache, loadLlmParams } from '@/llm/llm-params';
import { clearPromptCache, loadPrompt } from '@/llm/prompt-loader';

// 配置热重载（api-spec 5.1 / architecture 9.2）
//
// 失败回滚：先用临时 parse 校验全部文件语法，全部通过后才清缓存并重新加载。
// 任一文件校验失败抛 CONFIG_INVALID，旧缓存保留——避免坏配置让服务挂掉。
//
// 不变量 4 不受影响：本服务只清/重载配置缓存，不改 LlmClient 落库逻辑。

export interface ReloadResult {
  reloaded: string[];   // 实际重载成功的文件相对路径（按 api-spec 5.1 契约）
  warnings: string[];   // 非阻断性提示
  reloadedAt: string;   // ISO 8601 带时区
}

// api-spec 5.1 契约约定的 reloaded 数组顺序
const RELOADED_CONTRACT: readonly string[] = Object.freeze([
  'prompts/examiner.md',
  'prompts/tool.md',
  'prompts/evaluation.md',
  'prompts/outline.md',
  'stages.yaml',
  'tasks.yaml',
  'questionnaire.yaml',
  'levels.yaml',
  'outline_blacklist.yaml',
  'cards.yaml',
]);

// 额外重载但不计入 reloaded 数组（不在 api-spec 5.1 契约列表）
const EXTRA_RELOADED: readonly string[] = Object.freeze(['llm_params.yaml']);

function findConfigDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config/tasks.yaml'))) {
      return path.join(dir, 'config');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../../config');
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly outlineService: OutlineService) {}

  // 临时 parse 全部配置文件，不写缓存，只校验语法
  // .yaml 用 yaml.load 严格校验；.md 只校验可读且非空
  private validateAllFiles(configDir: string): void {
    const allFiles = [...RELOADED_CONTRACT, ...EXTRA_RELOADED];
    for (const rel of allFiles) {
      const fullPath = path.join(configDir, rel);
      if (!fs.existsSync(fullPath)) {
        throw new AppError('CONFIG_INVALID', {
          file: rel,
          message: 'config file not found',
        });
      }
      const raw = fs.readFileSync(fullPath, 'utf8');
      if (rel.endsWith('.md')) {
        if (!raw.trim()) {
          throw new AppError('CONFIG_INVALID', {
            file: rel,
            message: 'prompt file is empty',
          });
        }
        continue;
      }
      try {
        yaml.load(raw);
      } catch (e) {
        const err = e as { message?: string; mark?: { line?: number } };
        throw new AppError('CONFIG_INVALID', {
          file: rel,
          line: err.mark?.line != null ? err.mark.line + 1 : undefined,
          message: err.message ?? String(e),
        });
      }
    }
  }

  reloadAllConfigs(): ReloadResult {
    const configDir = findConfigDir();

    // 阶段 1：临时 parse 全部文件，任一失败抛 CONFIG_INVALID，旧缓存保留
    this.validateAllFiles(configDir);

    // 阶段 2：全部通过后清缓存并重新加载；若加载阶段仍失败（罕见，业务字段映射 bug），
    // 抛 CONFIG_INVALID 并记录 warning。此时缓存为空，下次访问会重新读盘。
    const warnings: string[] = [];
    try {
      clearTasksCache();
      loadTasks();
      clearStagesCache();
      loadStages();
      clearDimensionsCache();
      loadDimensions();
      clearCardsCache();
      loadCards();
      clearLevelsCache();
      loadLevels();
      clearQuestionnaireCache();
      loadQuestionnaire();
      clearLlmParamsCache();
      loadLlmParams();
      clearPromptCache();
      loadPrompt('examiner');
      loadPrompt('tool');
      loadPrompt('evaluation');
      loadPrompt('outline');
      this.outlineService.reloadBlacklist();
    } catch (e) {
      // 加载阶段失败：缓存可能已部分清除，但旧值无法恢复（cached 是模块私有）
      // 旧缓存已被破坏，记录 warning 让运维知道需要回滚文件并重启
      warnings.push(
        `reload stage 2 failed after clearing some caches: ${
          e instanceof Error ? e.message : String(e)
        }; check config files and restart if needed`,
      );
      this.logger.error(
        `[admin] reload-config stage 2 failed: ${
          e instanceof Error ? e.stack : String(e)
        }`,
      );
      throw new AppError('CONFIG_INVALID', {
        message: e instanceof Error ? e.message : String(e),
        stage: 'reload_after_clear',
      });
    }

    return {
      reloaded: [...RELOADED_CONTRACT],
      warnings,
      reloadedAt: new Date().toISOString(),
    };
  }
}
