import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// 与 config/dimensions.yaml v0.1 对齐。
// 注入到 config/prompts/evaluation.md 的 {{dimension_definitions}} 占位符。
// 热更新：调 clearDimensionsCache() 后下次 loadDimensions 重新读盘（api-spec 5.1）。

interface DimensionEntry {
  code: string;
  name: string;
  measures: string;
  why_it_matters: string;
  ladder: Record<string, string>;
  judgment_notes?: string[];
  common_misjudgment?: string;
}

interface DimensionsFile {
  dimensions: DimensionEntry[];
}

function findConfigDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config/dimensions.yaml'))) {
      return path.join(dir, 'config');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../../config');
}

const CONFIG_PATH = path.join(findConfigDir(), 'dimensions.yaml');

let cached: DimensionEntry[] | null = null;

export function loadDimensions(): DimensionEntry[] {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as DimensionsFile;
  cached = parsed.dimensions;
  return cached;
}

// 热更新：清空模块级缓存，下次 loadDimensions 重新读盘
// 供 POST /api/v1/admin/reload-config 调用（api-spec 5.1）
export function clearDimensionsCache(): void {
  cached = null;
}

// 渲染为 evaluation prompt 使用的多行字符串
// 格式：每个维度一段，含 code/name/measures/ladder 档位
export function renderDimensionDefinitions(): string {
  return loadDimensions()
    .map((d) => {
      const ladderLines = Object.entries(d.ladder)
        .map(([k, v]) => `  ${k}: ${v.trim()}`)
        .join('\n');
      return `${d.code}: ${d.name}\n衡量：${d.measures.trim()}\n档位：\n${ladderLines}`;
    })
    .join('\n\n');
}
