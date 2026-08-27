import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { AdminService } from '@/admin/admin.service';
import { AdminKeyGuard } from '@/admin/admin-key.guard';
import { OutlineService } from '@/assessment/outline.service';
import { AppError } from '@/common/app-error';
import * as tasksConfig from '@/assessment/tasks.config';

// 配置热重载单测（api-spec 5.1）
//
// 不依赖 DB：mock OutlineService 即可绕过 TypeORM decorators
// env 处理：每个用例前备份并设置 ADMIN_KEY，afterAll 还原

describe('admin/reload-config', () => {
  let moduleRef: TestingModule;
  let service: AdminService;
  let mockOutlineService: { reloadBlacklist: jest.Mock };
  let savedAdminKey: string | undefined;

  beforeAll(async () => {
    savedAdminKey = process.env.ADMIN_KEY;
    mockOutlineService = { reloadBlacklist: jest.fn() };
    moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: OutlineService, useValue: mockOutlineService },
      ],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  afterAll(() => {
    if (savedAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = savedAdminKey;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.ADMIN_KEY = 'test-admin-key';
    mockOutlineService.reloadBlacklist.mockClear();
  });

  // 1. 成功路径：返回契约约定的 10 个文件名 + ISO 8601 时间
  it('成功路径：reloaded 含 10 个契约文件、reloadedAt 是 ISO 8601、warnings 为空', () => {
    const result = service.reloadAllConfigs();

    expect(result.reloaded).toEqual([
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
    expect(result.warnings).toEqual([]);
    // ISO 8601 基本格式：YYYY-MM-DDTHH:mm:ss.sssZ 或带时区偏移
    expect(result.reloadedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    );
    expect(mockOutlineService.reloadBlacklist).toHaveBeenCalledTimes(1);
  });

  // 2. 失败回滚：validateAllFiles 抛错时，clearTasksCache 不应被调用（旧缓存保留）
  it('CONFIG_INVALID 回滚：阶段 1 校验失败时 clearTasksCache 不被调用', () => {
    const validateSpy = jest
      .spyOn(service as unknown as { validateAllFiles: (d: string) => void }, 'validateAllFiles')
      .mockImplementation(() => {
        throw new AppError('CONFIG_INVALID', {
          file: 'tasks.yaml',
          message: 'synthetic test failure',
        });
      });
    const clearTasksSpy = jest.spyOn(tasksConfig, 'clearTasksCache');

    expect(() => service.reloadAllConfigs()).toThrow(AppError);
    try {
      service.reloadAllConfigs();
      fail('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CONFIG_INVALID');
    }
    expect(clearTasksSpy).not.toHaveBeenCalled();
    expect(mockOutlineService.reloadBlacklist).not.toHaveBeenCalled();

    validateSpy.mockRestore();
    clearTasksSpy.mockRestore();
  });

  // 3. 真实目录校验：直接调真实 reloadAllConfigs() 不抛错（端到端最小验证）
  it('真实目录校验：加载真实 config/ 文件不抛错', () => {
    expect(() => service.reloadAllConfigs()).not.toThrow();
  });
});

describe('AdminKeyGuard', () => {
  let savedAdminKey: string | undefined;
  let guard: AdminKeyGuard;

  beforeAll(() => {
    savedAdminKey = process.env.ADMIN_KEY;
  });

  afterAll(() => {
    if (savedAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = savedAdminKey;
  });

  beforeEach(() => {
    guard = new AdminKeyGuard();
  });

  const fakeContext = (headers: Record<string, string>): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    }) as unknown as ExecutionContext;

  // 4. env 未设 ADMIN_KEY → 抛 ADMIN_KEY_INVALID
  it('ADMIN_KEY_INVALID：env 未配置 ADMIN_KEY 时拒绝', () => {
    delete process.env.ADMIN_KEY;
    expect(() => guard.canActivate(fakeContext({}))).toThrow(AppError);
    try {
      guard.canActivate(fakeContext({}));
    } catch (e) {
      expect((e as AppError).code).toBe('ADMIN_KEY_INVALID');
    }
  });

  // 5. env 设了但 header 缺失/不匹配 → 抛 ADMIN_KEY_INVALID
  it('ADMIN_KEY_INVALID：header 缺失或与 env 不符时拒绝', () => {
    process.env.ADMIN_KEY = 'test-admin-key';

    // header 缺失
    expect(() => guard.canActivate(fakeContext({}))).toThrow(AppError);
    try {
      guard.canActivate(fakeContext({}));
    } catch (e) {
      expect((e as AppError).code).toBe('ADMIN_KEY_INVALID');
    }

    // header 不匹配
    expect(() =>
      guard.canActivate(fakeContext({ 'x-admin-key': 'wrong-key' })),
    ).toThrow(AppError);
  });

  // 6. env 与 header 匹配 → 返回 true
  it('env 与 header 匹配时放行', () => {
    process.env.ADMIN_KEY = 'test-admin-key';
    const ok = guard.canActivate(
      fakeContext({ 'x-admin-key': 'test-admin-key' }),
    );
    expect(ok).toBe(true);
  });
});
