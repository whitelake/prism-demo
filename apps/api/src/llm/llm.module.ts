import { Module } from '@nestjs/common';
import { LlmClient } from './llm.client';
import { LlmLogger } from './llm.logger';

// LlmModule 不 imports TypeOrmModule.forFeature，
// LlmLogger 通过 @Optional() 注入 DatabaseModule 提供的 LlmCallLogPersister。
// 这样 prompt 联调测试不连 mysql 时 LlmLogger 仍能工作（仅内存镜像）。
@Module({
  providers: [LlmClient, LlmLogger],
  exports: [LlmClient, LlmLogger],
})
export class LlmModule {}
