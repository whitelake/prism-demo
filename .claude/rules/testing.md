---
paths:
  - "**/*.spec.ts"
  - "**/*.test.ts"
  - "**/test/**"
  - "apps/api/src/modules/dialogue/**"
  - "apps/api/src/modules/report/**"
  - "apps/api/src/llm/**"
  - "apps/api/src/modules/assessment/**"
---

# 测试规则

以下测试属于实验约束，不得为了让测试通过而削弱断言。

## 必测内容

### 上下文隔离

验证工具模式模型请求不含：

- 候选人姓名
- 问卷内容
- 考官模式历史
- 任务描述中的测评信息
- 其他工具任务历史

### 结论锁定

验证：

- `pending_interview` 不返回A
- B提交后进入 `final_evaluating`，仍不返回A
- C成功并进入 `completed` 后才解锁A/B/C
- 列表接口同样不泄露A

### 模型调用日志

验证：

- 请求在模型调用前已创建日志
- 成功保存原始响应
- 失败保存错误
- 不存在绕过统一客户端的调用路径

### 状态机

验证：

- 模型信号不能直接改变状态
- 最小轮次、最大轮次、超时和覆盖度规则符合PRD
- S1.3触发符合Q3、Q4和mentioned字段规则

## 面试记录长度

少于200字只能提示并要求确认，不得阻断提交。

不要实现“少于100字返回422”，除非PRD正式变更。
