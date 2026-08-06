import { Module } from '@nestjs/common';
import { LlmClient } from './llm.client';
import { LlmLogger } from './llm.logger';

@Module({
  providers: [LlmClient, LlmLogger],
  exports: [LlmClient, LlmLogger],
})
export class LlmModule {}
