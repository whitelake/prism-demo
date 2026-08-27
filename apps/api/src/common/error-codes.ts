// 错误码总表（api-spec.md 第6章）
// 对应 HTTP 状态码在 GlobalExceptionFilter 中映射

export type ErrorCode =
  // 通用
  | 'PARAM_INVALID'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  // 候选人端
  | 'TOKEN_INVALID'
  | 'ASSESSMENT_ABANDONED'
  | 'ALREADY_STARTED'
  | 'ALREADY_SUBMITTED'
  | 'QUESTIONNAIRE_INVALID'
  | 'TURN_IN_PROGRESS'
  | 'NO_INTERACTION'
  | 'SKIP_NOT_ALLOWED'
  | 'MODEL_UNAVAILABLE'
  // 面试官端
  | 'CREDENTIAL_INVALID'
  | 'CANNOT_REGENERATE'
  | 'JUDGMENT_ALREADY_SUBMITTED'
  | 'JUDGMENT_SUBMITTED'
  | 'TRANSRIPT_SHORT_CONFIRM'
  | 'ABANDON_NOT_ALLOWED'
  // 管理
  | 'CONFIG_INVALID'
  | 'ADMIN_KEY_INVALID'
  | 'NOT_IMPLEMENTED';

export interface ErrorDef {
  code: ErrorCode;
  httpStatus: number;
  message: string;
}

const ERROR_DEFS: Record<ErrorCode, Omit<ErrorDef, 'code'>> = {
  PARAM_INVALID: { httpStatus: 400, message: '请求参数有误' },
  UNAUTHORIZED: { httpStatus: 401, message: '请先登录' },
  FORBIDDEN: { httpStatus: 403, message: '无权访问该测评' },
  NOT_FOUND: { httpStatus: 404, message: '资源不存在' },
  INTERNAL_ERROR: { httpStatus: 500, message: '服务异常，请稍后重试' },

  TOKEN_INVALID: { httpStatus: 401, message: '测评链接无效或已失效' },
  ASSESSMENT_ABANDONED: { httpStatus: 410, message: '本次测评已结束' },
  ALREADY_STARTED: { httpStatus: 409, message: '测评已开始' },
  ALREADY_SUBMITTED: { httpStatus: 409, message: '测评已提交' },
  QUESTIONNAIRE_INVALID: { httpStatus: 400, message: '请完成所有必答题' },
  TURN_IN_PROGRESS: { httpStatus: 409, message: '上一条还在处理中' },
  NO_INTERACTION: { httpStatus: 422, message: '请至少与AI交流一次' },
  SKIP_NOT_ALLOWED: { httpStatus: 422, message: '尚未达到跳过条件' },
  MODEL_UNAVAILABLE: { httpStatus: 503, message: '模型服务暂时不可用' },

  CREDENTIAL_INVALID: { httpStatus: 401, message: '账号或密码错误' },
  CANNOT_REGENERATE: { httpStatus: 409, message: '已开始的测评不能重新生成链接' },
  JUDGMENT_ALREADY_SUBMITTED: { httpStatus: 409, message: '已提交，不可修改' },
  JUDGMENT_SUBMITTED: { httpStatus: 409, message: '判断已提交，记录不可再编辑' },
  TRANSRIPT_SHORT_CONFIRM: { httpStatus: 200, message: '面试记录较短，请确认' },
  ABANDON_NOT_ALLOWED: { httpStatus: 409, message: '当前状态不可标记放弃' },

  CONFIG_INVALID: { httpStatus: 400, message: '配置文件语法错误' },
  ADMIN_KEY_INVALID: { httpStatus: 401, message: '管理密钥无效或缺失' },
  NOT_IMPLEMENTED: { httpStatus: 501, message: '该接口尚未实现（PoC 骨架）' },
};

export function getErrorDef(code: ErrorCode): ErrorDef {
  const def = ERROR_DEFS[code];
  return { code, ...def };
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_DEFS[code].httpStatus;
}

export function messageFor(code: ErrorCode): string {
  return ERROR_DEFS[code].message;
}
