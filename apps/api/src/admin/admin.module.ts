import { Module } from '@nestjs/common';
import { AssessmentModule } from '@/assessment/assessment.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminKeyGuard } from './admin-key.guard';

// AssessmentModule 已 exports OutlineService（assessment.module.ts:57），AdminService 通过 DI 注入
@Module({
  imports: [AssessmentModule],
  controllers: [AdminController],
  providers: [AdminService, AdminKeyGuard],
})
export class AdminModule {}
