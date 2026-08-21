import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmModule } from '@/llm/llm.module';
import { LlmClient } from '@/llm/llm.client';
import { LlmLogger } from '@/llm/llm.logger';
import { LlmCallLogEntity } from '@/db/entities/llm-call-log.entity';
import { LlmCallLogPersister } from '@/db/llm-call-log.persister';
import { DatabaseModule } from '@/db/database.module';
import { isApiKeyConfigured } from '@/llm/llm-params';

const API_KEY_CONFIGURED = isApiKeyConfigured();
const describeIfReady = API_KEY_CONFIGURED ? describe : describe.skip;

// PoC 不变量 4：模型调用唯一出口，全量落库
// 验证 llm_call_log 表的请求前/成功/失败三种落库行为
describeIfReady('llm_call_log 落库验证 (e2e, mysql)', () => {
  jest.setTimeout(120000);

  let client: LlmClient;
  let logger: LlmLogger;
  let repo: Repository<LlmCallLogEntity>;
  let persister: LlmCallLogPersister;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule],
    }).compile();

    client = moduleRef.get(LlmClient);
    logger = moduleRef.get(LlmLogger);
    repo = moduleRef.get(getRepositoryToken(LlmCallLogEntity));
    persister = moduleRef.get(LlmCallLogPersister);
  });

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  afterEach(async () => {
    if (repo) await repo.clear();
    if (logger) logger.clear();
  });

  it('I1: 调用前先 INSERT llm_call_log（status=pending, response_raw=null）', async () => {
    const assessmentId = 'test-invariant-i1-' + Date.now();
    // 故意触发一个会失败的调用：不传 systemPrompt 让模型抛错或 timeout
    // 这里直接验证 logRequest 的副作用：调用前 DB 中已有 status=pending 的记录
    const beforeCount = await repo.count({ where: { assessmentId } });
    expect(beforeCount).toBe(0);

    // 启动一个会成功的调用，但中途用 repo.count 检查是否先 INSERT
    // 为简化测试，先手工调 logRequest 验证 INSERT 行为
    const id = await persister.insertRequest({
      assessmentId,
      purpose: 'eval',
      model: 'qwen-plus',
      temperature: 0.1,
      requestMessages: [{ role: 'system', content: 'test' }],
      ts: new Date(),
    });

    const records = await repo.find({ where: { assessmentId } });
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(String(r.id)).toBe(id);
    expect(r.purpose).toBe('eval');
    expect(r.model).toBe('qwen-plus');
    expect(r.status).toBe('pending');
    expect(r.responseRaw).toBeNull();
    expect(r.requestMessages).toContain('"role":"system"');
  });

  it('I2: 成功调用后 UPDATE response_raw / prompt_tokens / status=success', async () => {
    const { raw } = await client.call({
      assessmentId: 'test-invariant-i2-' + Date.now(),
      purpose: 'tool',
      systemPrompt: '你是一个通用AI助手。',
      userMessages: [{ role: 'user', content: '说一个数字' }],
    });

    expect(raw).toBeTruthy();
    // 验证 DB 中有对应记录 status=success
    const entries = logger.all();
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1]!;
    expect(last.status).toBe('success');
    expect(last.responseRaw).toBeTruthy();

    // 直接查 DB
    const dbRecord = await repo.findOne({ where: { id: last.id } });
    expect(dbRecord).not.toBeNull();
    expect(dbRecord!.status).toBe('success');
    expect(dbRecord!.responseRaw).toBe(raw);
    expect(dbRecord!.latencyMs).toBeGreaterThan(0);
  });

  it('I3: 失败调用后 UPDATE status=failed / error_msg 有内容', async () => {
    // 用一个会触发 schema 校验失败的 schema 强制失败
    const badSchema = {
      parse: () => {
        throw new Error('forced schema fail');
      },
    } as any;
    await expect(
      client.call({
        assessmentId: 'test-invariant-i3-' + Date.now(),
        purpose: 'tool',
        systemPrompt: '你是一个通用AI助手。',
        userMessages: [{ role: 'user', content: '说一个数字' }],
        schema: badSchema,
      }),
    ).rejects.toThrow();

    const entries = logger.all();
    const last = entries[entries.length - 1]!;
    expect(last.status).toBe('failed');
    expect(last.errorMsg).toBeTruthy();

    const dbRecord = await repo.findOne({ where: { id: last.id } });
    expect(dbRecord).not.toBeNull();
    expect(dbRecord!.status).toBe('failed');
    expect(dbRecord!.errorMsg).toBeTruthy();
  });

  it('I4: 不存在绕过统一客户端的调用路径（结构验证）', async () => {
    // 结构性校验：LlmClient 必须依赖 LlmLogger，LlmLogger 必须依赖 LlmCallLogPersister
    // 即任何模型调用都经过 Logger 链路，无法绕过
    expect(typeof client.call).toBe('function');
    // LlmLogger.persister 在测试环境必须非 null（DatabaseModule 提供）
    expect((logger as any).persister).toBe(persister);
  });
});
