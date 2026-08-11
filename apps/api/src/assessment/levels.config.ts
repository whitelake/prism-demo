import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

interface LevelEntry {
  level: string;
  name: string;
  definition: string;
  required_evidence?: string[];
  pending_rule?: string;
}

interface LevelsFile {
  levels: LevelEntry[];
}

function findConfigDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config/levels.yaml'))) {
      return path.join(dir, 'config');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../../config');
}

const CONFIG_PATH = path.join(findConfigDir(), 'levels.yaml');

let cached: LevelEntry[] | null = null;

export function loadLevels(): LevelEntry[] {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as LevelsFile;
  cached = parsed.levels;
  return cached;
}

// 渲染为 evaluation prompt 使用的多行字符串
// 格式与 evaluation.spec.ts 测试中保持一致：`Lx: name - definition`
export function renderLevelDefinitions(): string {
  return loadLevels()
    .map((l) => `${l.level}: ${l.name}\n${l.definition.trim()}`)
    .join('\n\n');
}
