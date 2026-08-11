import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InterviewerEntity } from '@/db/entities/interviewer.entity';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { JwtService } from './jwt.service';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CandidateTokenGuard } from './candidate-token.guard';

@Module({
  imports: [TypeOrmModule.forFeature([InterviewerEntity, AssessmentEntity])],
  providers: [JwtService, AuthService, JwtAuthGuard, CandidateTokenGuard],
  controllers: [AuthController],
  exports: [JwtService, AuthService, JwtAuthGuard, CandidateTokenGuard],
})
export class AuthModule {}
