import * as fs from 'node:fs';
import * as path from 'node:path';

export type PromptName = 'examiner' | 'tool' | 'evaluation' | 'outline';

function findConfigDir(): string {
  // 从 cwd 向上查找 config/prompts/
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'config/prompts');
    if (fs.existsSync(candidate)) return path.join(dir, 'config');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // fallback: 相对当前文件位置（apps/api/src/llm/ → ../../../config）
  return path.resolve(__dirname, '../../../config');
}

const CONFIG_DIR = findConfigDir();
const PROMPTS_DIR = path.join(CONFIG_DIR, 'prompts');

const cache = new Map<PromptName, string>();

export function loadPrompt(name: PromptName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const filename = name === 'evaluation' ? 'evaluation.md' : `${name}.md`;
  const fullPath = path.join(PROMPTS_DIR, filename);
  const content = fs.readFileSync(fullPath, 'utf8');
  cache.set(name, content);
  return content;
}

export function clearPromptCache(): void {
  cache.clear();
}

