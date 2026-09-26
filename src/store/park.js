import { defineStore } from 'pinia'

const BASE = '/api'

// RFC4122 v4 UUID（幂等键）：每次用户点击生成，重试沿用同一键 → 服务端只生效一次
function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

// 网络层归一化：把 HTTP 错误/断网/非 JSON 响应统一成 { ok:false, code, msg, hint, trace_id }
async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  let r
  try {
    r = await fetch(BASE + path, opt)
  } catch (networkErr) {
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      msg: '网络连接中断，操作未送达；请检查网络后点击重试（不会重复扣款）',
      hint: '该请求带有幂等保护，重试安全',
      trace_id: '',
      _network: true
    }
  }
  let data = null
  try { data = await r.json() } catch { /* 非 JSON 响应（网关/代理错误） */ }
  if (!data) {
    return {
      ok: false,
      code: r.ok ? 'BAD_RESPONSE' : `HTTP_${r.status}`,
      msg: r.ok ? '服务返回异常，请刷新后重试' : `服务暂不可用（HTTP ${r.status}），请稍后重试`,
      hint: '若已扣款，系统将在下次请求时自动核对，不会重复收费',
      trace_id: ''
    }
  }
  // 成功响应直接透传（含 ok:false 的软结果，如超售自动改签）
  if (r.ok) return data
  // 4xx/5xx：补全 trace_id（兜底生成，便于前端与服务端日志对账）
  return {
    ok: false,
    code: data.code || `HTTP_${r.status}`,
    msg: data.msg || '操作失败，请稍后重试',
    hint: data.hint || '',
    trace_id: data.trace_id || '',
    details: data.details || null,
    http_status: r.status
  }
}

function emptyReservationStats() {
  return {
    todayCap: 0, todayBooked: 0, todayChecked: 0, todayRefunded: 0, todayFill: 0,
    pendingOrders: 0, pendingQty: 0, noshowToday: 0, refundOrdersToday: 0, refundAmountToday: 0,
    soldAheadQty: 0, soldAheadAmount: 0, oversoldPending: 0, calendar: []
  }
}

export const useParkStore = defineStore('park', {
  state: () => ({
    data: null,
    loaded: false,
    speed: 1,
    lastTick: 0,
    toasts: [],            // 全局可追踪错误提示 { id, code, msg, hint, trace_id, kind }
    inflight: {}           // 进行中的幂等写请求：key -> Promise，防止双击/短时间重复提交
  }),
  getters: {
    clock: s => s.data?.clock || { day: 1, hour: 9 },
    zones: s => s.data?.zones || [],
    rides: s => s.data?.rides || [],
    vendors: s => s.data?.vendors || [],
    staff: s => s.data?.staff || [],
    events: s => s.data?.events || [],
    finance: s => s.data?.finance || [],
    visitors: s => s.data?.visitors || [],
    loans: s => s.data?.loans || [],
    debt: s => s.data?.debt || { remainPrincipal: 0, arrears: 0, overdueCount: 0 },
    complaints: s => s.data?.complaints || [],
    complaintStats: s => s.data?.complaintStats || { open: 0, overdue: 0, todayClosed: 0, resolved: 0, total: 0, avgRating: 0, compTotal: 0 },
    maintenanceOrders: s => s.data?.maintenanceOrders || [],
    maintenanceStats: s => s.data?.maintenanceStats || { queued: 0, processing: 0, open: 0, doneToday: 0, costToday: 0 },
    openMaintenanceOrders: s => (s.data?.maintenanceOrders || []).filter(o => ['queued', 'processing'].includes(o.status)),
    wordOfMouth: s => s.data?.wordOfMouth ?? 0,
    entrySlots: s => s.data?.entrySlots || [],
    reservations: s => s.data?.reservations || [],
    reservationStats: s => s.data?.reservationStats || emptyReservationStats(),
    openComplaints: s => (s.data?.complaints || []).filter(c => ['open', 'processing', 'ready'].includes(c.status)),
    activeEvents: s => (s.data?.events || []).filter(e => e.status === 'active')
  },
  actions: {
    // 全局错误提示：5xx/网络错误弹 toast；4xx 业务错误由页面内联展示（trace_id 仍可追踪）
    pushToast(err, kind = 'error') {
      const id = Date.now() + Math.random()
      this.toasts.push({
        id, kind,
        code: err?.code || '',
        msg: err?.msg || '操作失败',
        hint: err?.hint || '',
        trace_id: err?.trace_id || ''
      })
      setTimeout(() => this.dismissToast(id), 8000)
    },
    dismissToast(id) { this.toasts = this.toasts.filter(t => t.id !== id) },
    async refresh() {
      this.data = await j('GET', '/state')
      this.loaded = true
      if (this.data) this.lastTick = this.data.clock.tick
    },
    async api(method, path, body) {
      const r = await j(method, path, body)
      await this.refresh()
      return r
    },
    // 预约类写操作统一入口：自动带幂等键 + 进行中同键合并（双击只发一次请求）。
    // 调用方可复用同一个 idemKey 做「失败重试」，服务端保证不会重复扣款/重复核销。
    async rsvAction(path, body, idemKey = null) {
      const key = idemKey || uuid()
      if (this.inflight[key]) return this.inflight[key]
      const payload = { ...(body || {}), idempotency_key: key }
      const p = (async () => {
        try {
          const r = await j('POST', path, payload)
          if (!r.ok && !['RSV_OVERBOOK_RESCHEDULED', 'RSV_OVERBOOK_REFUNDED'].includes(r.code)) {
            // 系统级/网络错误全局提醒；业务校验错误（4xx）仅内联展示
            if (r._network || (r.http_status >= 500) || r.code === 'RSV_INTERNAL' || r.code === 'BAD_RESPONSE') {
              this.pushToast(r)
            }
          }
          await this.refresh()
          return { ...r, idemKey }
        } finally {
          delete this.inflight[key]
        }
      })()
      this.inflight[key] = p
      return p
    },
    buildRide(payload) { return this.api('POST', '/rides', payload) },
    updateRide(id, payload) { return this.api('POST', `/rides/${id}`, payload) },
    delRide(id) { return this.api('DELETE', `/rides/${id}`) },
    buildVendor(payload) { return this.api('POST', '/vendors', payload) },
    updateVendor(id, payload) { return this.api('POST', `/vendors/${id}`, payload) },
    delVendor(id) { return this.api('DELETE', `/vendors/${id}`) },
    hire(payload) { return this.api('POST', '/staff', payload) },
    updateStaff(id, payload) { return this.api('POST', `/staff/${id}`, payload) },
    unlock(zoneId) { return this.api('POST', `/zones/${zoneId}/unlock`, {}) },
    updateZone(zoneId, payload) { return this.api('POST', `/zones/${zoneId}`, payload) },
    setTicket(price) { return this.api('POST', '/ticket', { price }) },
    takeLoan(amount, periods, ratePct) { return this.api('POST', '/loan', { amount, periods, ratePct }) },
    repayLoan(id) { return this.api('POST', `/loans/${id}/repay`, {}) },
    planEvent(payload) { return this.api('POST', '/events', payload) },
    resolveEvent(id) { return this.api('POST', `/events/${id}/resolve`, {}) },
    fileComplaint(payload) { return this.api('POST', '/complaints', payload) },
    assignComplaint(id, staff_id) { return this.api('POST', `/complaints/${id}/assign`, { staff_id }) },
    escalateComplaint(id) { return this.api('POST', `/complaints/${id}/escalate`, {}) },
    resolveComplaint(id, compensation) { return this.api('POST', `/complaints/${id}/resolve`, { compensation }) },
    closeComplaint(id) { return this.api('POST', `/complaints/${id}/close`, {}) },
    async complaintDetail(id) { return j('GET', `/complaints/${id}`) },
    // 分时预约（全部走幂等入口；页面保留 idemKey 以支持失败后安全重试）
    bookReservation(payload, idemKey) { return this.rsvAction('/reservations', payload, idemKey) },
    rescheduleReservation(id, slot_id, idemKey) { return this.rsvAction(`/reservations/${id}/reschedule`, { slot_id }, idemKey) },
    cancelReservation(id, idemKey) { return this.rsvAction(`/reservations/${id}/cancel`, {}, idemKey) },
    checkinReservation(id, idemKey) { return this.rsvAction(`/reservations/${id}/checkin`, {}, idemKey) },
    updateSlot(id, payload) { return this.api('POST', `/reservation-slots/${id}`, payload) },
    async rideSlots(rideId, day) { return j('GET', `/reservation-slots?scope=ride&rideId=${rideId}${day ? `&day=${day}` : ''}`) },
    async reservationDetail(id) { return j('GET', `/reservations/${id}`) },
    // 设施检修工单
    assignMaintenance(id, staff_id) { return this.api('POST', `/maintenance/${id}/assign`, { staff_id }) },
    cancelMaintenance(id) { return this.api('POST', `/maintenance/${id}/cancel`, {}) },
    async maintenanceDetail(id) { return j('GET', `/maintenance/${id}`) }
  }
})
