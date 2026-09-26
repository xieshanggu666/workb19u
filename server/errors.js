// 统一错误模型：所有可预期的业务失败都带稳定错误码 code 与可追踪 trace_id，
// 前端可按 code 做差异化提示/重试，trace_id 便于客服与服务端日志对账。

let _seq = 0

// 生成短追踪号：RSV-<时间基数36>-<自增>，同一次请求内所有失败日志共用
export function newTraceId(prefix = 'RSV') {
  _seq = (_seq + 1) % 0xfffff
  const t = Date.now().toString(36).slice(-6)
  return `${prefix}-${t}-${_seq.toString(36).padStart(3, '0')}`
}

// 错误码 → HTTP 状态 / 用户可读建议
export const ERROR_CODES = {
  RSV_SLOT_NOT_FOUND:       { http: 404, hint: '时段可能已被调整，请刷新库存后重试' },
  RSV_NOT_FOUND:            { http: 404, hint: '预约单不存在或已被删除，请刷新列表' },
  RSV_SLOT_CLOSED:          { http: 409, hint: '该时段已关闭，请改选其他时段' },
  RSV_SLOT_EXPIRED:         { http: 409, hint: '时段已过期，无法操作' },
  RSV_NO_STOCK:             { http: 409, hint: '库存不足，请改选有余量的时段' },
  RSV_RIDE_UNAVAILABLE:     { http: 409, hint: '设施当前不开放预约' },
  RSV_SCOPE_MISMATCH:       { http: 400, hint: '请求参数与时段不匹配' },
  RSV_BAD_QTY:              { http: 400, hint: '请检查预约人数' },
  RSV_STATE_CONFLICT:       { http: 409, hint: '单据状态已变化，请刷新后重试（请勿重复提交）' },
  RSV_TARGET_INVALID:       { http: 400, hint: '改签目标时段无效' },
  RSV_TARGET_SAME:          { http: 409, hint: '目标时段与原时段相同' },
  RSV_NOT_DUE:              { http: 409, hint: '尚未到核销时段，请按时段核销' },
  RSV_TOO_LATE:             { http: 409, hint: '核销窗口已过，将按爽约处理' },
  RSV_CASH_NOT_ENOUGH:      { http: 409, hint: '账户余额异常，请联系工作人员核对预收款项' },
  RSV_IDEMPOTENCY_REQUIRED: { http: 400, hint: '缺少幂等请求标识，请刷新页面后重试' },
  RSV_IDEMPOTENCY_CONFLICT: { http: 409, hint: '相同请求编号对应了不同的操作内容，请重新发起' },
  // 以下为「已处置但非核销放行」的业务结果（HTTP 200 + ok:false 透传提示），非错误
  RSV_OVERBOOK_RESCHEDULED: { http: 200, hint: '本场已满，已自动改签到后续时段' },
  RSV_OVERBOOK_REFUNDED:    { http: 200, hint: '本场已满且无后续时段，已全额退款' },
  RSV_INTERNAL:             { http: 500, hint: '服务繁忙，请稍后重试；款项与库存将自动核对恢复' }
}

// 业务结果码（非异常）：路由层以 200 透传，前端展示其中的处置提示
const SOFT_CODES = new Set(['RSV_OVERBOOK_RESCHEDULED', 'RSV_OVERBOOK_REFUNDED'])

export class ApiError extends Error {
  constructor(code, msg, opts = {}) {
    super(msg || ERROR_CODES[code]?.hint || '操作失败')
    this.name = 'ApiError'
    this.code = ERROR_CODES[code] ? code : 'RSV_INTERNAL'
    this.status = opts.status || ERROR_CODES[this.code]?.http || 500
    this.traceId = opts.traceId || newTraceId()
    this.details = opts.details || null
  }
  toJSON() {
    return {
      ok: false,
      code: this.code,
      msg: this.message,
      hint: ERROR_CODES[this.code]?.hint || '',
      trace_id: this.traceId,
      ...(this.details ? { details: this.details } : {})
    }
  }
}

// 业务结果码（非异常）：路由层以 200 透传，前端展示其中的处置提示
export function isSoftResult(r) {
  return r && r.ok === false && SOFT_CODES.has(r.code)
}

// 把服务层 { ok:false, code?, msg? } 结果转成抛错（路由边界统一使用）
export function assertOk(result, fallbackMsg = '操作失败') {
  if (result && result.ok) return result
  if (isSoftResult(result)) return result
  const code = result?.code && ERROR_CODES[result.code] ? result.code : 'RSV_INTERNAL'
  throw new ApiError(code, result?.msg || fallbackMsg, {
    traceId: result?.trace_id,
    details: result?.details || null
  })
}

// Express 统一错误出口：结构化 JSON + 服务端留痕（trace_id 可与前端提示对账）
export function errorHandler(log = console.error) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const e = err instanceof ApiError ? err : new ApiError('RSV_INTERNAL', err?.message || '服务内部错误')
    if (e.status >= 500) {
      log(`[${e.traceId}] ${req.method} ${req.originalUrl} →`, err?.stack || err)
    } else {
      log(`[${e.traceId}] ${e.code}: ${e.message}`)
    }
    if (!res.headersSent) res.status(e.status).json(e.toJSON())
  }
}
