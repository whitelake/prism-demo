import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, getErrorDef } from './error-codes';

// AppError：业务异常，携带稳定错误码。
// 异常过滤器统一捕获并按 api-spec 1.3 序列化为 {error: {code, message, detail}}
export class AppError extends HttpException {
  readonly code: ErrorCode;
  readonly detail: unknown;

  constructor(code: ErrorCode, detail?: unknown, messageOverride?: string) {
    const def = getErrorDef(code);
    super(
      {
        error: {
          code: def.code,
          message: messageOverride ?? def.message,
          detail: detail ?? null,
        },
      },
      def.httpStatus,
    );
    this.code = code;
    this.detail = detail ?? null;
  }

  static notFound(detail?: unknown): AppError {
    return new AppError('NOT_FOUND', detail);
  }

  static forbidden(detail?: unknown): AppError {
    return new AppError('FORBIDDEN', detail);
  }

  static paramInvalid(detail?: unknown): AppError {
    return new AppError('PARAM_INVALID', detail);
  }

  static unauthorized(detail?: unknown): AppError {
    return new AppError('UNAUTHORIZED', detail);
  }

  static notImplemented(detail?: unknown): AppError {
    return new AppError('NOT_IMPLEMENTED', detail);
  }
}
