import * as path from 'node:path';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

// jest 启动时加载 monorepo root 的 .env
function findEnvFile(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envPath = findEnvFile();
if (envPath) {
  dotenv.config({ path: envPath });
}
