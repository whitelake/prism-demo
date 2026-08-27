import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { StageConfig } from './assessment.state';

interface StagesFile {
  [code: string]: Omit<StageConfig, 'code'> & { trigger?: string };
}

function findConfigDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config/stages.yaml'))) {
      return path.join(dir, 'config');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../../config');
}

const CONFIG_PATH = path.join(findConfigDir(), 'stages.yaml');

let cached: Map<string, StageConfig> | null = null;

export function loadStages(): Map<string, StageConfig> {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as StagesFile;
  const map = new Map<string, StageConfig>();
  for (const [code, val] of Object.entries(parsed)) {
    map.set(code, {
      name: val.name,
      goal: val.goal,
      min_turns: val.min_turns,
      max_turns: val.max_turns,
      absolute_max_turns: val.absolute_max_turns,
    });
  }
  cached = map;
  return map;
}

// 热更新：清空模块级缓存，下次 loadStages 重新读盘
// 供 POST /api/v1/admin/reload-config 调用（api-spec 5.1）
export function clearStagesCache(): void {
  cached = null;
}

export function getStageConfig(code: 'S1.1' | 'S1.2' | 'S1.3'): StageConfig {
  const stages = loadStages();
  const cfg = stages.get(code);
  if (!cfg) {
    throw new Error(`stage config not found: ${code}`);
  }
  return cfg;
}
