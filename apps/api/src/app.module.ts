import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { LlmModule } from './llm/llm.module';
import { AssessmentModule } from './assessment/assessment.module';
import { AuthModule } from './auth/auth.module';
import { QuestionnaireModule } from './questionnaire/questionnaire.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    DatabaseModule,
    LlmModule,
    QuestionnaireModule,
    AuthModule,
    AssessmentModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
