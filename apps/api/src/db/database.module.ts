import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmCallLogEntity } from './entities/llm-call-log.entity';
import { InterviewerEntity } from './entities/interviewer.entity';
import { AssessmentEntity } from './entities/assessment.entity';
import { QuestionnaireResultEntity } from './entities/questionnaire-result.entity';
import { DialogueLogEntity } from './entities/dialogue-log.entity';
import { OutlineEntity } from './entities/outline.entity';
import { EvaluationEntity } from './entities/evaluation.entity';
import { InterviewerJudgmentEntity } from './entities/interviewer-judgment.entity';
import { ConsistencyEntity } from './entities/consistency.entity';
import { LlmCallLogPersister } from './llm-call-log.persister';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql' as const,
        host: config.get<string>('DB_HOST', '127.0.0.1'),
        port: config.get<number>('DB_PORT', 3306),
        username: config.get<string>('DB_USER', 'prism'),
        password: config.get<string>('DB_PASSWORD', 'prism_pass'),
        database: config.get<string>('DB_NAME', 'prism_demo'),
        entities: [__dirname + '/entities/*.{ts,js}'],
        // PoC 阶段直接 synchronize（避免迁移脚手手架），生产需关闭并走 migration
        synchronize: config.get<string>('DB_SYNCHRONIZE', 'true') === 'true',
        timezone: '+08:00',
        charset: 'utf8mb4',
        logging: config.get<string>('DB_LOGGING', 'false') === 'true',
      }),
    }),
    TypeOrmModule.forFeature([
      LlmCallLogEntity,
      InterviewerEntity,
      AssessmentEntity,
      QuestionnaireResultEntity,
      DialogueLogEntity,
      OutlineEntity,
      EvaluationEntity,
      InterviewerJudgmentEntity,
      ConsistencyEntity,
    ]),
  ],
  providers: [
    LlmCallLogPersister,
    {
      // string token 让 LlmLogger 通过 @Optional() @Inject 解耦
      provide: 'LLM_CALL_LOG_PERSISTER',
      useExisting: LlmCallLogPersister,
    },
  ],
  exports: [LlmCallLogPersister, 'LLM_CALL_LOG_PERSISTER'],
})
export class DatabaseModule {}
