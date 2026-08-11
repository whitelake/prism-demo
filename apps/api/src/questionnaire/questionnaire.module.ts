import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { QuestionnaireService } from './questionnaire.config';

@Module({
  imports: [TypeOrmModule.forFeature([QuestionnaireResultEntity])],
  providers: [QuestionnaireService],
  exports: [QuestionnaireService],
})
export class QuestionnaireModule {}
