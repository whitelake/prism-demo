import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// 系统卡片文案（架构 4.1 / api-spec 3.5/3.6）
// 由产品团队维护；mode_switch 用于考官→工具切换提示，task_brief 的 body 由 tasks.yaml 注入

export interface CardContent {
  title: string;
  body: string;
}

interface CardsFile {
  cards: Record<string, CardContent>;
}

function findConfigDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config/cards.yaml'))) {
      return path.join(dir, 'config');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../../../config');
}

const CONFIG_PATH = path.join(findConfigDir(), 'cards.yaml');

let cached: Record<string, CardContent> | null = null;

export function loadCards(): Record<string, CardContent> {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as CardsFile;
  cached = parsed.cards ?? {};
  return cached;
}

// 热更新：清空模块级缓存，下次 loadCards 重新读盘
// 供 POST /api/v1/admin/reload-config 调用（api-spec 5.1）
export function clearCardsCache(): void {
  cached = null;
}

export function getCard(variant: string): CardContent {
  const cards = loadCards();
  const c = cards[variant];
  if (!c) throw new Error(`card variant not found: ${variant}`);
  return c;
}
