import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AdminKeyGuard } from './admin-key.guard';
import { AdminService } from './admin.service';

// 管理端点（api-spec 第5章）
// 仅 X-Admin-Key 鉴权，不走 JWT
@Controller('admin')
@UseGuards(AdminKeyGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // api-spec 5.1：重载 config/ 下的 Prompt 与配置文件
  @Post('reload-config')
  @HttpCode(HttpStatus.OK)
  reloadConfig(@Body() _body: unknown) {
    return this.adminService.reloadAllConfigs();
  }
}
