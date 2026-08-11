import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard, getRequestUser } from './jwt-auth.guard';
import { AppError } from '@/common/app-error';

interface LoginDto {
  account?: string;
  password?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() body: LoginDto) {
    if (
      !body ||
      typeof body.account !== 'string' ||
      typeof body.password !== 'string' ||
      body.account.length < 1 ||
      body.password.length < 1
    ) {
      throw new AppError('CREDENTIAL_INVALID');
    }
    return this.auth.login(body.account, body.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: Request): Promise<{ id: string; name: string }> {
    const user = getRequestUser(req);
    return { id: user.interviewerId, name: user.interviewerName };
  }
}
