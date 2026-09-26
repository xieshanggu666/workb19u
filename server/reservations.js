import db, { getSetting, setSetting, tx } from './db.js'
import { ApiError, assertOk } from './errors.js'

// 分时预约模块：入园时段 9:00~18:00；设施时段 9:00~17:00（末班需留出运行时间）
const OPEN_HOUR = 9
const ENTRY_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
const RIDE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17]
const DEFAULT_ENTRY_CAP = 400
const DEFAULT_RIDE_CAP = 220
const DEFAULT_ENTRY_OVERSELL = 20 // 入园默认 5% 超售额度对冲爽约
const GENERATE_DAYS = 3           // 始终维护今/明/后三天的库存
const CHECKIN_RATE = 0.82         // 模拟客流的自然核销（到场）概率
const LATE_CANCEL_FEE = 0.5       // 当日取消保留 50% 手续费

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 由 index.js 注入共享上下文（时钟、财务、投诉）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  ticket: () => num(getSetting('ticket'), 120),
  logFinance: null,
  createComplaint: null
}
export function initReservationContext(deps) {
  Object.assign(ctx, deps)
}

const SLOT_SELECT = `SELECT s.*,
  (s.capacity + s.oversell - s.booked_count) AS remain,
  (s.booked_count - s.checked_count - s.refund_count) AS pending
  FROM reservation_slots s`

function getSlot(id) {
  return db.prepare(`${SLOT_SELECT} WHERE s.id=?`).get(id)
}
function getReservation(id) {
  return db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
}

// ---- 结构化失败（服务层统一错误码，路由层转 HTTP）----
function fail(code, msg, details = null) {
  return { ok: false, code, msg, details }
}
// 包裹需要事务保证的服务函数：抛 ApiError 时回滚事务并转成 { ok:false,code,msg } 结果，
// 供既有内部调用方（引擎/联动退款）继续以返回值风格消费
function guarded(code, msg, fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, code: e.code, msg: e.message, details: e.details }
    throw e
  }
}
// 路由边界使用：把 { ok:false } 结果以带码异常抛出（软结果码除外，随路由透传）
export function requireOk(result, fallbackMsg) { return assertOk(result, fallbackMsg) }

// ---- 原子库存语句（条件更新本身就是库存校验，杜绝超卖）----
const qOccupy = db.prepare(`UPDATE reservation_slots
  SET booked_count=booked_count+? WHERE id=? AND status='open' AND booked_count+?<=capacity+oversell`)
const qRelease = db.prepare(`UPDATE reservation_slots
  SET booked_count=MAX(0,booked_count-?), refund_count=refund_count+? WHERE id=?`)
const qTransferTo = db.prepare(`UPDATE reservation_slots
  SET booked_count=booked_count+? WHERE id=? AND status='open' AND booked_count+?<=capacity+oversell`)
const qTransferFrom = db.prepare(`UPDATE reservation_slots
  SET booked_count=MAX(0,booked_count-?) WHERE id=?`)
const qCheckedAdd = db.prepare('UPDATE reservation_slots SET checked_count=checked_count+? WHERE id=?')
// 预约单状态机守卫：只有当前状态符合预期才允许迁移，防止重复核销/重复退款/并发双改
function transitionReservation(id, patch, expect) {
  const sets = Object.keys(patch)
  const r = db.prepare(`UPDATE reservations SET ${sets.map(k => `${k}=?`).join(',')}
                        WHERE id=? AND status IN (${expect.map(() => '?').join(',')})`)
    .run(...sets.map(k => patch[k]), id, ...expect)
  return r.changes === 1
}

function logReservation(rid, action, note = '') {
  db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(rid, ctx.tick(), ctx.day(), ctx.hour(), action, note)
}

function entryPrice() { return ctx.ticket() }
function ridePrice(r) { return r?.price ?? 30 }

// ---------------- 库存生成与同步 ----------------
// 确保未来 GENERATE_DAYS 天的入园 / 设施时段库存存在（幂等）
export function ensureSlots() {
  const today = ctx.day()
  const rideIds = db.prepare('SELECT id,status FROM rides').all()
  const insertEntry = db.prepare(`INSERT OR IGNORE INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell)
                                  VALUES('entry',NULL,?,?,?,?)`)
  const insertRide = db.prepare(`INSERT OR IGNORE INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell,status)
                                 VALUES('ride',?,?,?,?,?,?)`)
  for (let d = 0; d < GENERATE_DAYS; d++) {
    const day = today + d
    for (const h of ENTRY_HOURS) insertEntry.run(day, h, DEFAULT_ENTRY_CAP, DEFAULT_ENTRY_OVERSELL)
    for (const r of rideIds) {
      for (const h of RIDE_HOURS) {
        insertRide.run(r.id, day, h, DEFAULT_RIDE_CAP, 0, r.status === 'operating' ? 'open' : 'closed')
      }
    }
  }
}

// 设备状态变化时联动未来时段：停运则关闭时段并强制退款在途预约；恢复则重新开放
export function syncRideSlots(ride) {
  if (!ride) return
  if (ride.status === 'operating') {
    db.prepare(`UPDATE reservation_slots SET status='open' WHERE scope='ride' AND ride_id=? AND day>=?`)
      .run(ride.id, ctx.day())
    return
  }
  // 关闭/检修：关停全部时段（含历史，恢复运营时再统一开放）；在途预约园方全额退款
  db.prepare(`UPDATE reservation_slots SET status='closed' WHERE scope='ride' AND ride_id=?`)
    .run(ride.id)
  const result = forceRefundByPark(
    db.prepare(`SELECT * FROM reservations WHERE scope='ride' AND ride_id=? AND status='booked'
                AND (slot_day>? OR (slot_day=? AND slot_hour>=?))`).all(ride.id, ctx.day(), ctx.day(), ctx.hour()),
    `关联设施「${ride.name}」${ride.status === 'maintenance' ? '检修' : '关闭'}，园方强制退款`,
    { title: `设施故障 · ${ride.name}` }
  )
  if (result.failures.length) {
    // 单条失败已随事务回滚，库存/款项保持一致；输出追踪明细，运营可在时段对账页复核
    console.error(`[reservations] 设施「${ride.name}」停运联动退款 ${result.failures.length} 单失败：`,
      result.failures.map(f => `${f.code || f.id}:${f.code_type}`).join('，'))
  }
  return result
}

// ---------------- 库存对账与异常恢复 ----------------
// 以预约单为唯一事实来源，重算每个时段的 booked/checked/noshow/refund 计数：
//   booked_count   = 在途(booked) 人数（注：核销后名额不释放，故 booked 含已核销/爽约，退款释放）
//   checked_count  = 已核销人数
//   noshow_count   = 爽约人数
//   refund_count   = 退款人数（refunded/refunded_half）
// 任何漂移（历史半成品事务/异常中断）都在单个事务内修正，并向 reservation_logs 写入修复留痕。
// 返回 { checked, mismatches:[{slot_id,diff}], fixed }
export function reconcileSlots({ fix = true } = {}) {
  const rows = db.prepare(`
    SELECT s.id AS slot_id,
      COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.slot_id=s.id AND r.status='booked'),0)
        + COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.slot_id=s.id AND r.status='checked'),0)
        + COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.slot_id=s.id AND r.status='noshow'),0) AS exp_booked,
      COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.slot_id=s.id AND r.status='checked'),0) AS exp_checked,
      COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.slot_id=s.id AND r.status='noshow'),0) AS exp_noshow,
      COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.slot_id=s.id AND r.status IN ('refunded','refunded_half')),0) AS exp_refund,
      s.booked_count, s.checked_count, s.noshow_count, s.refund_count
    FROM reservation_slots s`).all()

  const mismatches = []
  const upd = db.prepare(`UPDATE reservation_slots SET booked_count=?, checked_count=?, noshow_count=?, refund_count=? WHERE id=?`)
  for (const r of rows) {
    const diff = {
      booked: r.exp_booked - r.booked_count,
      checked: r.exp_checked - r.checked_count,
      noshow: r.exp_noshow - r.noshow_count,
      refund: r.exp_refund - r.refund_count
    }
    if (!diff.booked && !diff.checked && !diff.noshow && !diff.refund) continue
    mismatches.push({ slot_id: r.slot_id, diff,
      before: { booked: r.booked_count, checked: r.checked_count, noshow: r.noshow_count, refund: r.refund_count },
      after: { booked: r.exp_booked, checked: r.exp_checked, noshow: r.exp_noshow, refund: r.exp_refund } })
  }

  if (fix && mismatches.length) {
    tx(() => {
      for (const m of mismatches) {
        upd.run(m.after.booked, m.after.checked, m.after.noshow, m.after.refund, m.slot_id)
        // 修复留痕挂在时段维度：写一条 action=reconcile 的系统日志（reservation_id 用 0 表示系统）
        db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
          .run(0, ctx.tick(), ctx.day(), ctx.hour(), 'reconcile',
            `库存对账修复 #${m.slot_id}：已约 ${m.before.booked}→${m.after.booked}，核销 ${m.before.checked}→${m.after.checked}，爽约 ${m.before.noshow}→${m.after.noshow}，退款 ${m.before.refund}→${m.after.refund}`)
      }
    })
  }
  return { checked: rows.length, mismatches: mismatches.length, fixed: fix ? mismatches.length : 0, details: mismatches }
}

// 园方原因强制全额退款（设备停运 / 超售无法改签）：款全额退回，生成投诉工单
// 单条失败（状态已被其他流程改变）自动跳过并收集，不影响整批回滚/恢复
function forceRefundByPark(rows, note, complaintInfo = {}) {
  let n = 0
  const failures = []
  for (const rsv of rows) {
    const r = refundReservation(rsv, 'park', note, { skipComplaint: true })
    if (r.ok) n += rsv.qty
    else failures.push({ id: rsv.id, code: rsv.code, code_type: r.code || 'RSV_INTERNAL', msg: r.msg })
  }
  const refunded = rows.length - failures.length
  if (refunded && ctx.createComplaint) {
    const anyRide = rows[0].ride_id ? db.prepare('SELECT * FROM rides WHERE id=?').get(rows[0].ride_id) : null
    ctx.createComplaint({
      category: complaintInfo.category || (anyRide ? 'facility' : 'service'),
      severity: complaintInfo.severity || 2,
      title: complaintInfo.title || `预约爽约补偿 · ${anyRide?.name || '园区'}`,
      content: complaintInfo.content || `已预约 ${refunded} 单被园方取消，虽已全额退款，但行程受影响，游客要求说法。`,
      target: anyRide ? { type: 'ride', id: anyRide.id, name: anyRide.name } : { type: '', id: null, name: '' },
      source: 'guest'
    })
  }
  return { ok: failures.length === 0, n, refunded, total: rows.length, failures }
}

// ---------------- 下单 / 改签 / 退款 ----------------
// 核心一致性：原子条件占库存（WHERE booked+qty<=cap+oversell，数据库层兜底防超卖），
// 预约单、库存、现金、财务流水在同一事务内提交；任一步失败全部回滚（node:sqlite 同步执行天然串行）
function bookSlot(slot, { guest_name, guest_phone, qty, amount, scope, rideId, source }) {
  return guarded('RSV_INTERNAL', '下单失败', () => {
    if (slot.status !== 'open') throw new ApiError('RSV_SLOT_CLOSED', '该时段已关闭预约')
    if (slot.remain < qty) {
      throw new ApiError('RSV_NO_STOCK',
        `该时段余量不足，仅剩 ${slot.remain} 个名额${slot.oversell > 0 ? `（含 ${slot.oversell} 超售额度）` : ''}`,
        { remain: slot.remain })
    }
    // 原子占用：条件不满足（并发抢光/时段被关）changes=0，事务回滚不建单不收款
    if (qOccupy.run(qty, slot.id, qty).changes === 0) {
      const fresh = getSlot(slot.id)
      if (!fresh || fresh.status !== 'open') throw new ApiError('RSV_SLOT_CLOSED', '该时段已关闭预约')
      throw new ApiError('RSV_NO_STOCK', `下手慢了，该时段名额刚被约满（剩 ${Math.max(0, fresh.remain)}）`, { remain: fresh.remain })
    }
    let id
    try {
      const result = db.prepare(`INSERT INTO reservations(code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day)
                                 VALUES(?,?,?,?,?,?,?,?,?,?,'booked',?,?,?)`)
        .run('', guest_name || '游客', guest_phone || '', scope, rideId, slot.id, slot.day, slot.hour,
             qty, amount, source || 'guest', ctx.tick(), ctx.day())
      id = Number(result.lastInsertRowid)
      const code = 'YY' + String(id).padStart(4, '0')
      db.prepare('UPDATE reservations SET code=? WHERE id=?').run(code, id)
      // 预收款即时入账（现金制：下单即确认收入，核销不重复收费）
      setSetting('cash', Math.round(ctx.cash() + amount))
      ctx.logFinance?.(ctx.day(), scope === 'entry' ? '门票' : '游乐', amount,
        `预约预收 ${code} · ${slot.day}日${slot.hour}:00 ${scope === 'entry' ? '入园' : '设施'} · ${qty} 人`)
      logReservation(id, source === 'auto' ? 'auto_book' : 'create',
        `${scope === 'entry' ? '入园' : '设施'}预约 ${slot.day}日 ${slot.hour}:00 · ${qty} 人 · 预收 ¥${amount}`)
      return { ok: true, id, code }
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError('RSV_INTERNAL', '预约单写入失败，库存与款项已自动回滚')
    }
  })
}

// 统一退款：reason=park/overbook 全额；late 半价（另半价转为爽约手续费）；cascade 表示内部调用
export function refundReservation(rsvOrId, reason = 'guest', note = '', opts = {}) {
  const rsv = typeof rsvOrId === 'object' ? rsvOrId : getReservation(rsvOrId)
  if (!rsv) return fail('RSV_NOT_FOUND', '预约不存在')
  return guarded('RSV_INTERNAL', '退款失败', () => {
    // 事务内重读并以状态条件更新加锁：已被核销/退款/爽约的单不会重复退款
    const cur = getReservation(rsv.id)
    if (!cur) throw new ApiError('RSV_NOT_FOUND', '预约不存在')
    if (cur.status !== 'booked') {
      throw new ApiError('RSV_STATE_CONFLICT', `当前状态（${STATUS_NAMES[cur.status] || cur.status}）不可退款，款项未变动`,
        { status: cur.status })
    }
    const half = reason === 'late'
    const back = half ? Math.round(cur.amount * (1 - LATE_CANCEL_FEE)) : cur.amount
    const fee = cur.amount - back

    if (back > 0) {
      setSetting('cash', Math.round(ctx.cash() - back))
      const label = cur.scope === 'entry' ? '门票' : '游乐'
      ctx.logFinance?.(ctx.day(), label, -back, `预约退款 ${cur.code}${half ? '（当日取消扣 50% 手续费）' : ''}`)
    }
    if (fee > 0) ctx.logFinance?.(ctx.day(), '违约', fee, `预约 ${cur.code} 取消费/爽约没收`)

    const newStatus = half ? 'refunded_half' : 'refunded'
    if (!transitionReservation(cur.id,
      { status: newStatus, reason, closed_tick: ctx.tick(), closed_day: ctx.day() }, ['booked'])) {
      throw new ApiError('RSV_STATE_CONFLICT', '预约单状态刚被其他操作改变，本次退款已回滚，款项未变动')
    }
    // 退款/取消释放可售名额；refund_count 单独留痕，核销容量不回补。
    // 释放使用 MAX(0) 防御性更新，不因历史计数漂移而阻塞退款（漂移由 reconcileSlots 对账修复）
    qRelease.run(cur.qty, cur.qty, cur.slot_id)
    logReservation(cur.id, half ? 'cancel' : 'refund',
      `${note || '退款'}：退回 ¥${back}${fee ? `，手续费 ¥${fee}` : ''}`)

    if (!opts.skipComplaint && reason === 'overbook' && ctx.createComplaint) {
      const ride = cur.ride_id ? db.prepare('SELECT * FROM rides WHERE id=?').get(cur.ride_id) : null
      ctx.createComplaint({
        category: cur.scope === 'entry' ? 'queue' : 'facility',
        severity: 2,
        title: `超售补偿 · ${ride?.name || '分时入园'}`,
        content: `预约 ${cur.code} 到场时名额已满（超售无法改签），已全额退款 ¥${back}，游客不满要求补偿。`,
        target: ride ? { type: 'ride', id: ride.id, name: ride.name } : { type: '', id: null, name: '' },
        source: 'guest'
      })
    }
    return { ok: true, back, fee, code: cur.code }
  })
}

// 游客取消：未来时段全额退；当日取消扣 50%；时段已过不允许（走爽约流程）
export function cancelReservation(id) {
  const rsv = getReservation(id)
  if (!rsv) return fail('RSV_NOT_FOUND', '预约不存在')
  if (rsv.status !== 'booked') return fail('RSV_STATE_CONFLICT', '当前状态不可取消')
  if (rsv.slot_day < ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour <= ctx.hour())) {
    return fail('RSV_TOO_LATE', '入园时段已开始/结束，不可取消；未到场将按爽约处理')
  }
  const late = rsv.slot_day === ctx.day()
  return refundReservation(rsv, late ? 'late' : 'guest', late ? '游客当日取消' : '游客提前取消')
}

// 改签：目标时段需有真实容量；库存原子转移（先条件占用新时段成功后再释放原时段），
// 任一步失败事务回滚，两侧库存与预约单始终一致；不加价
export function rescheduleReservation(id, targetSlotId) {
  const rsv = getReservation(id)
  if (!rsv) return fail('RSV_NOT_FOUND', '预约不存在')
  return guarded('RSV_INTERNAL', '改签失败', () => {
    const cur = getReservation(id)
    if (!cur) throw new ApiError('RSV_NOT_FOUND', '预约不存在')
    if (cur.status !== 'booked') {
      throw new ApiError('RSV_STATE_CONFLICT', `当前状态（${STATUS_NAMES[cur.status] || cur.status}）不可改签`)
    }
    if (cur.slot_day < ctx.day() || (cur.slot_day === ctx.day() && cur.slot_hour < ctx.hour())) {
      throw new ApiError('RSV_SLOT_EXPIRED', '原时段已过期，不可改签')
    }
    const target = getSlot(num(targetSlotId))
    if (!target || target.scope !== cur.scope || (cur.scope === 'ride' && target.ride_id !== cur.ride_id)) {
      throw new ApiError('RSV_TARGET_INVALID', '改签目标时段无效')
    }
    if (target.status !== 'open') throw new ApiError('RSV_SLOT_CLOSED', '目标时段已关闭预约')
    if (target.id === cur.slot_id) throw new ApiError('RSV_TARGET_SAME', '目标时段与原时段相同')
    if (target.remain < cur.qty) throw new ApiError('RSV_NO_STOCK', `目标时段余量不足（剩 ${target.remain}）`, { remain: target.remain })

    // 先占用目标时段（条件原子更新：并发抢名额失败则整笔回滚，原时段名额保留）
    if (qTransferTo.run(cur.qty, target.id, cur.qty).changes === 0) {
      const fresh = getSlot(target.id)
      throw new ApiError('RSV_NO_STOCK',
        `目标时段刚被约满${fresh ? `（剩 ${Math.max(0, fresh.remain)}）` : ''}，库存未变动，请改选其他时段`)
    }
    // 再释放原时段（MAX(0) 防御历史漂移）
    qTransferFrom.run(cur.qty, cur.slot_id)
    const n = cur.reschedules + 1
    const upd = db.prepare(`UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=?
                            WHERE id=? AND status='booked'`)
      .run(target.id, target.day, target.hour, n, id)
    if (upd.changes === 0) {
      // 并发状态变化（已被核销/退款/自动改签）：抛出触发回滚，两侧库存恢复
      throw new ApiError('RSV_STATE_CONFLICT', '预约单状态刚变化（可能已被核销或自动改签），本次改签已回滚')
    }
    logReservation(id, 'reschedule', `改签为 ${target.day}日 ${target.hour}:00（第 ${n} 次改签）`)
    return { ok: true, reschedules: n, slot_id: target.id, slot_day: target.day, slot_hour: target.hour }
  })
}

// ---------------- 核销 ----------------
// 超售自动改签的库存原子转移 + 单据更新（在调用方事务内执行）；失败抛错整体回滚
function applyAutoReschedule(rsv, alt) {
  if (qTransferTo.run(rsv.qty, alt.id, rsv.qty).changes === 0) {
    throw new ApiError('RSV_NO_STOCK', `备选时段 ${alt.day}日 ${alt.hour}:00 刚被约满`)
  }
  qTransferFrom.run(rsv.qty, rsv.slot_id)
  const upd = db.prepare(`UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=reschedules+1
                          WHERE id=? AND status='booked'`)
    .run(alt.id, alt.day, alt.hour, rsv.id)
  if (upd.changes === 0) throw new ApiError('RSV_STATE_CONFLICT', '预约单状态已变化，自动改签中止')
  logReservation(rsv.id, 'auto_reschedule', `本场超售容量已满，自动改签到 ${alt.day}日 ${alt.hour}:00`)
}

// 单个人工核销（运营在闸机/设施口扫码）；状态守卫保证重复扫码不会重复放行
export function checkinReservation(id) {
  const rsv = getReservation(id)
  if (!rsv) return fail('RSV_NOT_FOUND', '预约不存在')
  if (rsv.status === 'checked') return fail('RSV_STATE_CONFLICT', `该预约已核销（核销号 ${rsv.code}），请勿重复扫码`)
  if (rsv.status !== 'booked') return fail('RSV_STATE_CONFLICT', `当前状态（${STATUS_NAMES[rsv.status] || rsv.status}）不可核销`)
  return guarded('RSV_INTERNAL', '核销失败', () => {
    const cur = getReservation(id)
    if (!cur) throw new ApiError('RSV_NOT_FOUND', '预约不存在')
    if (cur.status === 'checked') throw new ApiError('RSV_STATE_CONFLICT', '该预约已核销，请勿重复扫码')
    if (cur.status !== 'booked') throw new ApiError('RSV_STATE_CONFLICT', `当前状态（${STATUS_NAMES[cur.status] || cur.status}）不可核销`)
    // 未到入园时段不可提前核销
    if (cur.slot_day > ctx.day() || (cur.slot_day === ctx.day() && cur.slot_hour > ctx.hour())) {
      throw new ApiError('RSV_NOT_DUE', `未到入园时段（${cur.slot_day}日 ${cur.slot_hour}:00），请按时段核销`)
    }
    // 已过时段 2 小时以上视为爽约窗口已过
    if (cur.slot_day < ctx.day() || (cur.slot_day === ctx.day() && cur.slot_hour < ctx.hour() - 1)) {
      throw new ApiError('RSV_TOO_LATE', '该预约时段已过，未到场将按爽约处理')
    }
    const slot = getSlot(cur.slot_id)
    // 容量内放行；落在超售名额且本场容量已满 → 自动改签，失败则全额退款（返回提示而非放行）
    if (slot && slot.checked_count + cur.qty > slot.capacity) {
      const alt = findAlternativeSlot(cur)
      if (alt) {
        applyAutoReschedule(cur, alt)
        return { ok: false, code: 'RSV_OVERBOOK_RESCHEDULED',
          msg: `本场容量已满，已为您自动改签到 ${alt.day}日 ${alt.hour}:00，请凭新时段核销`,
          rescheduled: { slot_id: alt.id, slot_day: alt.day, slot_hour: alt.hour } }
      }
      const r = refundReservation(cur, 'overbook', '本场超售且无后续时段可改签，全额退款', {})
      if (!r.ok) throw new ApiError(r.code || 'RSV_INTERNAL', r.msg)
      return { ok: false, code: 'RSV_OVERBOOK_REFUNDED',
        msg: `本场容量已满且无可改签时段，已全额退款 ¥${r.back}`, refunded: r.back }
    }
    applyCheckin(cur, slot, 'manual')
    return { ok: true }
  })
}

function applyCheckin(rsv, slot, source) {
  // 状态条件更新兜底：同一预约即使被引擎与人工同时核销，也只会有一次放行
  const upd = db.prepare("UPDATE reservations SET status='checked', checked_tick=? WHERE id=? AND status='booked'")
    .run(ctx.tick(), rsv.id)
  if (upd.changes === 0) throw new ApiError('RSV_STATE_CONFLICT', '该预约已被核销或状态已变化')
  if (slot) qCheckedAdd.run(rsv.qty, slot.id)
  logReservation(rsv.id, 'checkin', `${source === 'manual' ? '闸机扫码' : '到场自动'}核销 ${rsv.qty} 人`)
}

// 自动核销当前小时到期的预约：容量内放行；超出容量的超售名额先自动改签后段，再不行全额退款+投诉
// 每单独立事务：任何一步异常该单自动回滚（库存/现金/状态不留半成品），并计入 failures 供恢复追踪
// 返回 { entry: 实际入园人数, ride: Map<rideId, 游玩人数>, displaced: 被安置/退款人数, failures }
export function autoCheckin(hour) {
  const day = ctx.day()
  const due = db.prepare("SELECT * FROM reservations WHERE status='booked' AND slot_day=? AND slot_hour=?").all(day, hour)
  const entryArrivals = { qty: 0 }
  const rideArrivals = new Map()
  let displaced = 0
  const failures = []

  for (const base of due) {
    // 模拟到场率：未到场者留给小时末爽约处理
    if (base.source !== 'manual' && Math.random() > CHECKIN_RATE) continue
    try {
      tx(() => {
        const rsv = getReservation(base.id)   // 事务内重读，拿最新状态/库存
        if (!rsv || rsv.status !== 'booked') return
        const slot = getSlot(rsv.slot_id)
        const within = slot && slot.checked_count + rsv.qty <= slot.capacity
        if (within) {
          applyCheckin(rsv, slot, 'auto')
          if (rsv.scope === 'entry') entryArrivals.qty += rsv.qty
          else rideArrivals.set(rsv.ride_id, (rideArrivals.get(rsv.ride_id) || 0) + rsv.qty)
          return
        }
        // 超售：尝试同日后续有空余的时段
        const alt = findAlternativeSlot(rsv)
        if (alt) {
          applyAutoReschedule(rsv, alt)
          displaced += rsv.qty
        } else {
          const r = refundReservation(rsv, 'overbook', '本场超售且无后续时段可改签，全额退款')
          if (!r.ok) throw new ApiError(r.code || 'RSV_INTERNAL', r.msg)
          displaced += rsv.qty
        }
      })
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'RSV_INTERNAL'
      failures.push({ id: base.id, code: base.code, code_type: code, msg: e.message })
      // 内部错误（非预期冲突）需服务端留痕；状态冲突类属正常并发保护，仅记录
      if (!(e instanceof ApiError)) console.error(`[reservations] 自动核销异常 ${base.code}:`, e)
    }
  }
  return { entry: entryArrivals.qty, ride: rideArrivals, displaced, failures }
}

// 为超售预约寻找当前或未来仍开放、真实容量有余（非超售名额）的同类时段
function findAlternativeSlot(rsv) {
  const rows = db.prepare(`${SLOT_SELECT} WHERE s.scope=? AND s.status='open'
    AND (s.day>? OR (s.day=? AND s.hour>?))
    ${rsv.scope === 'ride' ? 'AND s.ride_id=?' : ''}
    ORDER BY s.day, s.hour`).all(rsv.scope, ctx.day(), ctx.day(), ctx.hour(),
      ...(rsv.scope === 'ride' ? [rsv.ride_id] : []))
  // 改签必须落在目标时段真实容量内（含当前已核销占用），且仍有可售名额
  return rows.find(s =>
    s.checked_count + rsv.qty <= s.capacity &&
    s.capacity + s.oversell - s.booked_count >= rsv.qty
  )
}

// 爽约：所有已过时段未核销的预约（含跨天兜底）标记 noshow，预收款没收（记入「违约」）
// 状态守卫避免与核销/退款重复结算；每单独立事务，失败自动回滚并收集
export function expireNoShow(hour) {
  const day = ctx.day()
  const due = db.prepare(`SELECT * FROM reservations WHERE status='booked'
                          AND (slot_day<? OR (slot_day=? AND slot_hour<?))`).all(day, day, hour)
  let qty = 0
  const failures = []
  for (const base of due) {
    try {
      tx(() => {
        const rsv = getReservation(base.id)
        if (!rsv || rsv.status !== 'booked') return  // 已被核销/改签出本时段/退款
        const changed = transitionReservation(rsv.id,
          { status: 'noshow', reason: 'noshow', closed_tick: ctx.tick(), closed_day: day }, ['booked'])
        if (!changed) throw new ApiError('RSV_STATE_CONFLICT', '预约单状态已变化，跳过爽约结算')
        db.prepare('UPDATE reservation_slots SET noshow_count=noshow_count+? WHERE id=?').run(rsv.qty, rsv.slot_id)
        ctx.logFinance?.(day, '违约', rsv.amount, `预约 ${rsv.code} 爽约，预收款没收`)
        logReservation(rsv.id, 'noshow', `未在 ${rsv.slot_hour}:00 时段到场核销，按爽约处理，预收 ¥${rsv.amount} 不退`)
        qty += rsv.qty
      })
    } catch (e) {
      failures.push({ id: base.id, code: base.code, code_type: e instanceof ApiError ? e.code : 'RSV_INTERNAL', msg: e.message })
      if (!(e instanceof ApiError)) console.error(`[reservations] 爽约处理异常 ${base.code}:`, e)
    }
  }
  return { qty, failures }
}

// ---------------- 模拟客流预约（游客端需求侧） ----------------
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '林', '何']
function randomGuestName() {
  return SURNAMES[Math.floor(Math.random() * SURNAMES.length)] + '**'
}

// 每个营业小时为各开放时段补充模拟预约，填充率目标随日期衰减（越临近越满）
export function autoBookDemand(rides, base, priceFactor, repFactor) {
  if (!ENTRY_HOURS.includes(ctx.hour())) return
  const demandMul = priceFactor * repFactor
  const book = (slot, want, price, scope, rideId) => {
    if (want <= 0 || slot.status !== 'open' || slot.remain <= 0) return 0
    const qty = Math.min(slot.remain, want)
    bookSlot(slot, {
      guest_name: randomGuestName(), qty, amount: qty * price,
      scope, rideId, source: 'auto'
    })
    return qty
  }

  // 当日/次日/后日 的目标填充率（需求侧）
  const fillTargets = [0.85, 0.55, 0.3]
  for (let d = 0; d < GENERATE_DAYS; d++) {
    const day = ctx.day() + d
    const entrySlots = db.prepare(`${SLOT_SELECT} WHERE s.scope='entry' AND s.day=? ORDER BY s.hour`).all(day)
    for (const s of entrySlots) {
      // 今日已过时段不再补单
      if (day === ctx.day() && s.hour <= ctx.hour()) continue
      const booked = s.booked_count
      const target = (s.capacity + s.oversell) * fillTargets[d]
      if (booked >= target) continue
      // 每小时补目标缺口的一部分 + 随机波动
      const want = Math.round((target - booked) * (0.10 + Math.random() * 0.12) * demandMul)
      book(s, want, entryPrice(), 'entry', null)
    }
    for (const r of rides.filter(r => r.status === 'operating')) {
      const rideSlots = db.prepare(`${SLOT_SELECT} WHERE s.scope='ride' AND s.ride_id=? AND s.day=? ORDER BY s.hour`).all(r.id, day)
      for (const s of rideSlots) {
        if (day === ctx.day() && s.hour <= ctx.hour()) continue
        const attraction = 0.55 + (r.attr * (r.health / 100)) / 200   // 0.55 ~ ~1.1
        const target = (s.capacity + s.oversell) * fillTargets[d] * attraction
        if (s.booked_count >= target) continue
        const want = Math.round((target - s.booked_count) * (0.10 + Math.random() * 0.12) * demandMul)
        book(s, want, ridePrice(r), 'ride', r.id)
      }
    }
  }
}

// ---------------- 查询与统计 ----------------
function slotRideName(slot, rides) {
  if (slot.scope !== 'ride') return ''
  return rides.find(r => r.id === slot.ride_id)?.name || `设施#${slot.ride_id}`
}

export function listSlots({ scope = 'entry', rideId = null, day = null } = {}) {
  ensureSlots()
  const rides = db.prepare('SELECT id,name,status,price FROM rides').all()
  const conds = ['s.scope=?']
  const vals = [scope]
  if (day) { conds.push('s.day=?'); vals.push(num(day)) }
  if (scope === 'ride') {
    if (rideId) { conds.push('s.ride_id=?'); vals.push(num(rideId)) }
  }
  const rows = db.prepare(`${SLOT_SELECT} WHERE ${conds.join(' AND ')} ORDER BY s.day, s.hour, s.ride_id`).all(...vals)
  return rows.map(s => ({
    ...s,
    ride_name: slotRideName(s, rides),
    ride_status: s.scope === 'ride' ? (rides.find(r => r.id === s.ride_id)?.status || '') : ''
  }))
}

// 运营调度：调容量 / 超售额度 / 开关时段；调减不得低于已预约量
export function updateSlot(id, patch) {
  const s = getSlot(id)
  if (!s) return fail('RSV_SLOT_NOT_FOUND', '时段不存在')
  const sets = []
  const vals = []
  if (patch.capacity !== undefined) {
    const cap = Math.max(0, Math.round(num(patch.capacity)))
    if (cap < s.booked_count) return fail('RSV_NO_STOCK', `容量不可低于已预约人数 ${s.booked_count}`)
    sets.push('capacity=?'); vals.push(cap)
  }
  if (patch.oversell !== undefined) {
    const ov = Math.max(0, Math.min(200, Math.round(num(patch.oversell))))
    sets.push('oversell=?'); vals.push(ov)
  }
  let forceResult = null
  if (patch.status !== undefined) {
    const st = ['open', 'closed'].includes(patch.status) ? patch.status : 'open'
    if (st === 'closed') {
      // 关闭时段：在途预约园方全额退款并生成投诉。逐单事务（forceRefundByPark 内每单独立回滚）；
      // 只要存在退款失败的单就不切换时段状态，避免「时段关了但没退款」的半成品
      const pending = db.prepare("SELECT * FROM reservations WHERE slot_id=? AND status='booked'").all(id)
      if (pending.length) {
        const ride = s.scope === 'ride' ? db.prepare('SELECT * FROM rides WHERE id=?').get(s.ride_id) : null
        forceResult = forceRefundByPark(pending, `运营关闭 ${s.day}日 ${s.hour}:00 时段，园方强制退款`,
          { title: `${ride ? ride.name : '分时入园'} · 时段临时取消`, category: ride ? 'facility' : 'service' })
        if (forceResult.failures.length) {
          return fail('RSV_STATE_CONFLICT',
            `有 ${forceResult.failures.length} 单退款失败，时段未关闭，已保持开放`,
            { failures: forceResult.failures })
        }
      }
    }
    sets.push('status=?'); vals.push(st)
  }
  if (!sets.length) return fail('RSV_INTERNAL', '无更新项')
  vals.push(id)
  db.prepare(`UPDATE reservation_slots SET ${sets.join(',')} WHERE id=?`).run(...vals)
  return { ok: true, refunded: forceResult?.n || 0 }
}

export function listReservations({ status = null, scope = null, day = null, limit = 120 } = {}) {
  const rides = allRideLite()
  const conds = []
  const vals = []
  if (status) { conds.push('status=?'); vals.push(status) }
  if (scope) { conds.push('scope=?'); vals.push(scope) }
  if (day) { conds.push('slot_day=?'); vals.push(num(day)) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM reservations ${where} ORDER BY id DESC LIMIT ?`).all(...vals, num(limit, 120))
  return rows.map(r => ({
    ...r,
    ride_name: r.ride_id ? (rides.find(x => x.id === r.ride_id)?.name || `设施#${r.ride_id}`) : '',
    scope_name: r.scope === 'entry' ? '分时入园' : '设施预约',
    status_name: STATUS_NAMES[r.status] || r.status
  }))
}
function allRideLite() { return db.prepare('SELECT id,name,status,price FROM rides').all() }

const STATUS_NAMES = {
  booked: '待核销', checked: '已核销', noshow: '爽约',
  refunded: '已退款', refunded_half: '退50%'
}

export function reservationLogs(id) {
  return db.prepare('SELECT * FROM reservation_logs WHERE reservation_id=? ORDER BY id').all(id)
}

// 游客端下单校验入口
export function createReservation({ scope, rideId, slotId, qty, guest_name, guest_phone, source = 'guest' }) {
  const slot = getSlot(num(slotId))
  if (!slot) return fail('RSV_SLOT_NOT_FOUND', '时段不存在或已被调整，请刷新后重试')
  if (scope !== slot.scope || (scope === 'ride' && slot.ride_id !== num(rideId))) {
    return fail('RSV_SCOPE_MISMATCH', '预约类型与时段不匹配')
  }
  if (slot.day < ctx.day() || (slot.day === ctx.day() && slot.hour < ctx.hour())) {
    return fail('RSV_SLOT_EXPIRED', '不可预约已过期的时段')
  }
  const q = Math.max(1, Math.min(20, Math.round(num(qty, 1))))
  if (!Number.isFinite(num(qty)) || num(qty) < 1) return fail('RSV_BAD_QTY', '预约人数至少为 1 人')
  const ride = scope === 'ride' ? db.prepare('SELECT * FROM rides WHERE id=?').get(slot.ride_id) : null
  if (scope === 'ride' && (!ride || ride.status !== 'operating')) {
    return fail('RSV_RIDE_UNAVAILABLE', '该设施当前不开放预约（可能已停运或检修中）')
  }
  const price = scope === 'entry' ? entryPrice() : ridePrice(ride)
  const amount = q * price
  return bookSlot(slot, { guest_name, guest_phone, qty: q, amount, scope, rideId: slot.ride_id, source })
}

export function reservationStats() {
  const day = ctx.day()
  const one = sql => db.prepare(sql).get(day)
  const todaySlots = db.prepare(`SELECT
      COALESCE(SUM(capacity+oversell),0) AS cap,
      COALESCE(SUM(booked_count),0) AS booked,
      COALESCE(SUM(checked_count),0) AS checked,
      COALESCE(SUM(noshow_count),0) AS noshow,
      COALESCE(SUM(refund_count),0) AS refund
    FROM reservation_slots WHERE day=? AND scope='entry'`).get(day)
  const pending = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM reservations WHERE status='booked' AND slot_day>=?").get(day)
  const noshowToday = one("SELECT COUNT(*) n FROM reservations WHERE status='noshow' AND closed_day=?").n
  const refundToday = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) a FROM reservations WHERE status IN ('refunded','refunded_half') AND closed_day=?")
  const checkedToday = one("SELECT COALESCE(SUM(qty),0) q FROM reservations WHERE status='checked' AND scope='entry' AND slot_day=?").q
  const refundedToday = one("SELECT COALESCE(SUM(qty),0) q FROM reservations WHERE status='refunded' AND slot_day=?").q
  const soldAhead = db.prepare("SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(amount),0) a FROM reservations WHERE status='booked' AND slot_day>?").get(day)
  // 超售待处理：落在超售名额内（预约量超过时段真实容量）的在途预约单数
  const oversoldPending = db.prepare(`SELECT COUNT(*) n FROM reservations r
    JOIN reservation_slots s ON s.id=r.slot_id
    WHERE r.status='booked' AND r.slot_day>=? AND s.booked_count > s.capacity`).get(day).n
  // 未来各日预约概况（容量日历）
  const calendar = db.prepare(`SELECT day, scope,
      COALESCE(SUM(capacity+oversell),0) AS cap,
      COALESCE(SUM(booked_count),0) AS booked,
      COALESCE(SUM(checked_count),0) AS checked
    FROM reservation_slots WHERE day>=? GROUP BY day, scope ORDER BY day`).all(day)
  return {
    todayCap: todaySlots.cap,
    todayBooked: todaySlots.booked,
    todayChecked: checkedToday,
    todayRefunded: refundedToday,
    todayFill: todaySlots.cap ? Math.round(todaySlots.booked / todaySlots.cap * 100) : 0,
    pendingOrders: pending.n,
    pendingQty: pending.q,
    noshowToday,
    refundOrdersToday: refundToday.n,
    refundAmountToday: refundToday.a,
    soldAheadQty: soldAhead.q,
    soldAheadAmount: soldAhead.a,
    oversoldPending,
    calendar
  }
}

export const RESERVATION_CONST = { OPEN_HOUR, ENTRY_HOURS, RIDE_HOURS, GENERATE_DAYS }
