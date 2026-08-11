import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface TaskConfig {
  id: string;
  title: string;
  description: string;
  duration_minutes: number;
  require_min_turns: number;
}

interface TasksFile {
  tasks: TaskConfig[];
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

let cached: TaskConfig[] | null = null;

export function loadTasks(): TaskConfig[] {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as TasksFile;
  cached = parsed.tasks;
  return cached;
}

export function getTask(id: string): TaskConfig {
  const task = loadTasks().find((t) => t.id === id);
  if (!task) throw new Error(`task not found: ${id}`);
  return task;
}
