import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { AppError } from './app-error';
import { ErrorCode, getErrorDef } from './error-codes';

// api-spec 1.3 统一错误结构：
// {error: {code, message, detail}}
// 由 GlobalExceptionFilter 统一序列化
interface ErrorBody {
  error: {
    code: string;
    message: string;
    detail: unknown;
  };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest<Request>();

    let status: number;
    let body: ErrorBody;

    if (exception instanceof AppError) {
      status = getErrorDef(exception.code).httpStatus;
      body = {
        error: {
          code: exception.code,
          message: getErrorDef(exception.code).message,
          detail: exception.detail,
        },
      };
    } else if (exception instanceof HttpException) {
      const s = exception.getStatus();
      const payload = exception.getResponse();
      status = s;
      const message =
        typeof payload === 'string'
          ? payload
          : (payload as { message?: string | string[] })?.message?.toString() ??
            exception.message;
      body = {
        error: {
          code: mapHttpStatusToCode(s),
          message: message || getErrorDef(mapHttpStatusToCode(s)).message,
          detail: null,
        },
      };
    } else {
      // 未知异常：500 INTERNAL_ERROR，不向客户端暴露堆栈
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      const def = getErrorDef('INTERNAL_ERROR');
      body = {
        error: {
          code: def.code,
          message: def.message,
          detail: null,
        },
      };
      this.logger.error(
        `unhandled exception: ${req.method} ${req.url} -> ${
          exception instanceof Error ? exception.stack : String(exception)
        }`,
      );
    }

    res.status(status).json(body);
  }
}

function mapHttpStatusToCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'PARAM_INVALID';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'ALREADY_STARTED';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'SKIP_NOT_ALLOWED';
    default:
      return 'INTERNAL_ERROR';
  }
}
