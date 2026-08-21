import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface TaskDefect {
  level: '低' | '中' | '高';
  desc: string;
}

export interface TaskConfig {
  id: string;
  title: string;
  description: string;
  duration_minutes: number;
  require_min_turns: number;
  /** 内部字段:T1 的待决策点,仅供 A 评估,禁止下发前端 */
  gaps?: string[];
  /** 内部字段:T2 的预埋缺陷,仅供 A 评估,禁止下发前端 */
  defects?: TaskDefect[];
}

interface TaskVariant {
  id: string;
  title: string;
  description: string;
  gaps?: string[];
  defects?: TaskDefect[];
}

interface RawTask extends Partial<TaskVariant> {
  id: string;
  duration_minutes: number;
  require_min_turns: number;
  variants?: TaskVariant[];
}

interface TasksFile {
  tasks: RawTask[];
}

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

const CONFIG_PATH = path.join(findConfigDir(), 'tasks.yaml');

let cached: RawTask[] | null = null;

function loadRaw(): RawTask[] {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as TasksFile;
  cached = parsed.tasks;
  return cached;
}

/** 兼容旧调用:返回各任务的首个题面 */
export function loadTasks(): TaskConfig[] {
  return loadRaw().map((t) => mergeVariant(t, pickVariant(t)));
}

function pickVariant(task: RawTask, assessmentId?: string): TaskVariant | null {
  const list = task.variants;
  if (!list || list.length === 0) return null;      // 旧格式:题面直接写在 task 上
  if (!assessmentId) return list[0] ?? null;        // 无 seed:退化为首套,不报错
  return list[hashIndex(`${assessmentId}:${task.id}`, list.length)] ?? null;
}

function mergeVariant(task: RawTask, v: TaskVariant | null): TaskConfig {
  return {
    id: task.id,
    duration_minutes: task.duration_minutes,
    require_min_turns: task.require_min_turns,
    title: v?.title ?? task.title ?? '',
    description: v?.description ?? task.description ?? '',
    gaps: v?.gaps ?? task.gaps,
    defects: v?.defects ?? task.defects,
  };
}

/**
 * 确定性哈希:同一 assessmentId 永远选中同一套题,无需持久化。
 * seed 用 `${assessmentId}:${taskId}`,避免 T1/T2 下标被绑成同一个
 * (否则只有 3 种组合而非 9 种)。
 */
function hashIndex(seed: string, size: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % size;
}

/**
 * assessmentId 可选:不传时返回首套题面。
 * 仅读 duration_minutes / require_min_turns 的调用点可以不传。
 */
export function getTask(id: string, assessmentId?: string): TaskConfig {
  const task = loadRaw().find((t) => t.id === id);
  if (!task) throw new Error(`task not found: ${id}`);
  return mergeVariant(task, pickVariant(task, assessmentId));
}

/** 下发前端前剥掉内部字段 */
export function toPublicTask(t: TaskConfig): Omit<TaskConfig, 'gaps' | 'defects'> {
  const { gaps, defects, ...pub } = t;
  return pub;
}
