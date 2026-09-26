import db, { getSetting, setSetting } from './db.js'

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
  forceRefundByPark(
    db.prepare(`SELECT * FROM reservations WHERE scope='ride' AND ride_id=? AND status='booked'
                AND (slot_day>? OR (slot_day=? AND slot_hour>=?))`).all(ride.id, ctx.day(), ctx.day(), ctx.hour()),
    `关联设施「${ride.name}」${ride.status === 'maintenance' ? '检修' : '关闭'}，园方强制退款`,
    { title: `设施故障 · ${ride.name}` }
  )
}

// 园方原因强制全额退款（设备停运 / 超售无法改签）：款全额退回，生成投诉工单
function forceRefundByPark(rows, note, complaintInfo = {}) {
  let n = 0
  for (const rsv of rows) {
    refundReservation(rsv, 'park', note, { skipComplaint: true })
    n += rsv.qty
  }
  if (rows.length && ctx.createComplaint) {
    const anyRide = rows[0].ride_id ? db.prepare('SELECT * FROM rides WHERE id=?').get(rows[0].ride_id) : null
    ctx.createComplaint({
      category: complaintInfo.category || (anyRide ? 'facility' : 'service'),
      severity: complaintInfo.severity || 2,
      title: complaintInfo.title || `预约爽约补偿 · ${anyRide?.name || '园区'}`,
      content: complaintInfo.content || `已预约 ${rows.length} 单被园方取消，虽已全额退款，但行程受影响，游客要求说法。`,
      target: anyRide ? { type: 'ride', id: anyRide.id, name: anyRide.name } : { type: '', id: null, name: '' },
      source: 'guest'
    })
  }
  return n
}

// ---------------- 下单 / 改签 / 退款 ----------------
// 核心一致性：库存增减与预约单状态在同一同步流程内完成；node:sqlite 同步执行天然串行
function bookSlot(slot, { guest_name, guest_phone, qty, amount, scope, rideId, source }) {
  if (slot.status !== 'open') return { ok: false, msg: '该时段已关闭预约' }
  if (slot.remain < qty) {
    return { ok: false, msg: `该时段余量不足，仅剩 ${slot.remain} 个名额${slot.oversell > 0 ? `（含 ${slot.oversell} 超售额度）` : ''}` }
  }
  const result = db.prepare(`INSERT INTO reservations(code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day)
                             VALUES(?,?,?,?,?,?,?,?,?,?,'booked',?,?,?)`)
    .run('', guest_name || '游客', guest_phone || '', scope, rideId, slot.id, slot.day, slot.hour,
         qty, amount, source || 'guest', ctx.tick(), ctx.day())
  const id = Number(result.lastInsertRowid)
  const code = 'YY' + String(id).padStart(4, '0')
  db.prepare('UPDATE reservations SET code=? WHERE id=?').run(code, id)
  db.prepare('UPDATE reservation_slots SET booked_count=booked_count+? WHERE id=?').run(qty, slot.id)
  // 预收款即时入账（现金制：下单即确认收入，核销不重复收费）
  setSetting('cash', Math.round(ctx.cash() + amount))
  ctx.logFinance?.(ctx.day(), scope === 'entry' ? '门票' : '游乐', amount,
    `预约预收 ${code} · ${slot.day}日${slot.hour}:00 ${scope === 'entry' ? '入园' : '设施'} · ${qty} 人`)
  logReservation(id, source === 'auto' ? 'auto_book' : 'create',
    `${scope === 'entry' ? '入园' : '设施'}预约 ${slot.day}日 ${slot.hour}:00 · ${qty} 人 · 预收 ¥${amount}`)
  return { ok: true, id, code }
}

// 统一退款：reason=park/overbook 全额；late 半价（另半价转为爽约手续费）；cascade 表示内部调用
export function refundReservation(rsvOrId, reason = 'guest', note = '', opts = {}) {
  const rsv = typeof rsvOrId === 'object' ? rsvOrId : getReservation(rsvOrId)
  if (!rsv) return { ok: false, msg: '预约不存在' }
  if (!['booked'].includes(rsv.status)) return { ok: false, msg: '当前状态不可退款' }
  const half = reason === 'late'
  const back = half ? Math.round(rsv.amount * (1 - LATE_CANCEL_FEE)) : rsv.amount
  const fee = rsv.amount - back

  if (back > 0) {
    const cash = ctx.cash() - back
    setSetting('cash', Math.round(cash))
    const label = rsv.scope === 'entry' ? '门票' : '游乐'
    ctx.logFinance?.(ctx.day(), label, -back, `预约退款 ${rsv.code}${half ? '（当日取消扣 50% 手续费）' : ''}`)
  }
  if (fee > 0) ctx.logFinance?.(ctx.day(), '违约', fee, `预约 ${rsv.code} 取消费/爽约没收`)

  db.prepare(`UPDATE reservations SET status=?, reason=?, closed_tick=?, closed_day=? WHERE id=?`)
    .run(half ? 'refunded_half' : 'refunded', reason, ctx.tick(), ctx.day(), rsv.id)
  // 退款/取消释放可售名额；refund_count 单独留痕，核销容量不回补
  db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?), refund_count=refund_count+? WHERE id=?')
    .run(rsv.qty, rsv.qty, rsv.slot_id)
  logReservation(rsv.id, half ? 'cancel' : 'refund',
    `${note || '退款'}：退回 ¥${back}${fee ? `，手续费 ¥${fee}` : ''}`)

  if (!opts.skipComplaint && reason === 'overbook' && ctx.createComplaint) {
    const ride = rsv.ride_id ? db.prepare('SELECT * FROM rides WHERE id=?').get(rsv.ride_id) : null
    ctx.createComplaint({
      category: rsv.scope === 'entry' ? 'queue' : 'facility',
      severity: 2,
      title: `超售补偿 · ${ride?.name || '分时入园'}`,
      content: `预约 ${rsv.code} 到场时名额已满（超售无法改签），已全额退款 ¥${back}，游客不满要求补偿。`,
      target: ride ? { type: 'ride', id: ride.id, name: ride.name } : { type: '', id: null, name: '' },
      source: 'guest'
    })
  }
  return { ok: true, back, fee }
}

// 游客取消：未来时段全额退；当日取消扣 50%；时段已过不允许（走爽约流程）
export function cancelReservation(id) {
  const rsv = getReservation(id)
  if (!rsv) return { ok: false, msg: '预约不存在' }
  if (rsv.status !== 'booked') return { ok: false, msg: '当前状态不可取消' }
  if (rsv.slot_day < ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour <= ctx.hour())) {
    return { ok: false, msg: '入园时段已开始/结束，不可取消；未到场将按爽约处理' }
  }
  const late = rsv.slot_day === ctx.day()
  return refundReservation(rsv, late ? 'late' : 'guest', late ? '游客当日取消' : '游客提前取消')
}

// 改签：目标时段有余量才可改；库存原子转移（原 slot 减 booked，新 slot 加 booked）
export function rescheduleReservation(id, targetSlotId) {
  const rsv = getReservation(id)
  if (!rsv) return { ok: false, msg: '预约不存在' }
  if (rsv.status !== 'booked') return { ok: false, msg: '当前状态不可改签' }
  if (rsv.slot_day < ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour < ctx.hour())) {
    return { ok: false, msg: '原时段已过期，不可改签' }
  }
  const target = getSlot(num(targetSlotId))
  if (!target || target.scope !== rsv.scope || (rsv.scope === 'ride' && target.ride_id !== rsv.ride_id)) {
    return { ok: false, msg: '改签目标时段无效' }
  }
  if (target.status !== 'open') return { ok: false, msg: '目标时段已关闭预约' }
  if (target.id === rsv.slot_id) return { ok: false, msg: '目标时段与原时段相同' }
  if (target.remain < rsv.qty) return { ok: false, msg: `目标时段余量不足（剩 ${target.remain}）` }

  db.prepare('UPDATE reservation_slots SET booked_count=booked_count-? WHERE id=?').run(rsv.qty, rsv.slot_id)
  db.prepare('UPDATE reservation_slots SET booked_count=booked_count+? WHERE id=?').run(rsv.qty, target.id)
  const n = rsv.reschedules + 1
  db.prepare(`UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=? WHERE id=?`)
    .run(target.id, target.day, target.hour, n, id)
  logReservation(id, 'reschedule',
    `改签为 ${target.day}日 ${target.hour}:00（第 ${n} 次改签）`)
  return { ok: true }
}

// ---------------- 核销 ----------------
// 单个人工核销（运营在闸机/设施口扫码）
export function checkinReservation(id) {
  const rsv = getReservation(id)
  if (!rsv) return { ok: false, msg: '预约不存在' }
  if (rsv.status === 'checked') return { ok: false, msg: '该预约已核销' }
  if (rsv.status !== 'booked') return { ok: false, msg: '当前状态不可核销' }
  // 未到入园时段不可提前核销
  if (rsv.slot_day > ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour > ctx.hour())) {
    return { ok: false, msg: `未到入园时段（${rsv.slot_day}日 ${rsv.slot_hour}:00），请按时段核销` }
  }
  // 已过时段 2 小时以上视为爽约窗口已过
  if (rsv.slot_day < ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour < ctx.hour() - 1)) {
    return { ok: false, msg: '该预约时段已过，未到场将按爽约处理' }
  }
  const slot = getSlot(rsv.slot_id)
  // 容量内放行；落在超售名额且本场容量已满 → 自动改签，失败则全额退款（返回提示而非放行）
  if (slot && slot.checked_count + rsv.qty > slot.capacity) {
    const alt = findAlternativeSlot(rsv)
    if (alt) {
      db.prepare('UPDATE reservation_slots SET booked_count=booked_count-? WHERE id=?').run(rsv.qty, rsv.slot_id)
      db.prepare('UPDATE reservation_slots SET booked_count=booked_count+? WHERE id=?').run(rsv.qty, alt.id)
      db.prepare(`UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=reschedules+1 WHERE id=?`)
        .run(alt.id, alt.day, alt.hour, rsv.id)
      logReservation(rsv.id, 'auto_reschedule', `本场超售容量已满，自动改签到 ${alt.day}日 ${alt.hour}:00`)
      return { ok: false, msg: `本场容量已满，已为您自动改签到 ${alt.day}日 ${alt.hour}:00` }
    }
    const r = refundReservation(rsv, 'overbook', '本场超售且无后续时段可改签，全额退款')
    return { ok: false, msg: `本场容量已满且无可改签时段，已全额退款 ¥${r.back}` }
  }
  applyCheckin(rsv, slot, 'manual')
  return { ok: true }
}

function applyCheckin(rsv, slot, source) {
  db.prepare("UPDATE reservations SET status='checked', checked_tick=? WHERE id=?").run(ctx.tick(), rsv.id)
  if (slot) db.prepare('UPDATE reservation_slots SET checked_count=checked_count+? WHERE id=?').run(rsv.qty, slot.id)
  logReservation(rsv.id, 'checkin', `${source === 'manual' ? '闸机扫码' : '到场自动'}核销 ${rsv.qty} 人`)
}

// 自动核销当前小时到期的预约：容量内放行；超出容量的超售名额先自动改签后段，再不行全额退款+投诉
// 返回 { entry: 实际入园人数, ride: Map<rideId, 游玩人数>, displaced: 被安置/退款人数 }
export function autoCheckin(hour) {
  const day = ctx.day()
  const due = db.prepare("SELECT * FROM reservations WHERE status='booked' AND slot_day=? AND slot_hour=?").all(day, hour)
  const entryArrivals = { qty: 0 }
  const rideArrivals = new Map()
  let displaced = 0

  for (const rsv of due) {
    const slot = getSlot(rsv.slot_id)
    // 模拟到场率：未到场者留给小时末爽约处理
    if (rsv.source !== 'manual' && Math.random() > CHECKIN_RATE) continue

    const within = slot && slot.checked_count + rsv.qty <= slot.capacity
    if (within) {
      applyCheckin(rsv, slot, 'auto')
      if (rsv.scope === 'entry') entryArrivals.qty += rsv.qty
      else rideArrivals.set(rsv.ride_id, (rideArrivals.get(rsv.ride_id) || 0) + rsv.qty)
      continue
    }
    // 超售：尝试同日后续有空余的时段
    const alt = findAlternativeSlot(rsv)
    if (alt) {
      db.prepare('UPDATE reservation_slots SET booked_count=booked_count-? WHERE id=?').run(rsv.qty, rsv.slot_id)
      db.prepare('UPDATE reservation_slots SET booked_count=booked_count+? WHERE id=?').run(rsv.qty, alt.id)
      db.prepare(`UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=reschedules+1 WHERE id=?`)
        .run(alt.id, alt.day, alt.hour, rsv.id)
      logReservation(rsv.id, 'auto_reschedule', `本场超售容量已满，自动改签到 ${alt.day}日 ${alt.hour}:00`)
      displaced += rsv.qty
    } else {
      refundReservation(rsv, 'overbook', '本场超售且无后续时段可改签，全额退款')
      displaced += rsv.qty
    }
  }
  return { entry: entryArrivals.qty, ride: rideArrivals, displaced }
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

// 爽约：所有已过时段未核销的预约（含跨天兜底）标记 noshow，预收款没收（记入「违约」），释放爽约计数
export function expireNoShow(hour) {
  const day = ctx.day()
  const due = db.prepare(`SELECT * FROM reservations WHERE status='booked'
                          AND (slot_day<? OR (slot_day=? AND slot_hour<?))`).all(day, day, hour)
  let qty = 0
  for (const rsv of due) {
    db.prepare("UPDATE reservations SET status='noshow', reason='noshow', closed_tick=?, closed_day=? WHERE id=?")
      .run(ctx.tick(), day, rsv.id)
    db.prepare('UPDATE reservation_slots SET noshow_count=noshow_count+? WHERE id=?').run(rsv.qty, rsv.slot_id)
    ctx.logFinance?.(day, '违约', rsv.amount, `预约 ${rsv.code} 爽约，预收款没收`)
    logReservation(rsv.id, 'noshow', `未在 ${rsv.slot_hour}:00 时段到场核销，按爽约处理，预收 ¥${rsv.amount} 不退`)
    qty += rsv.qty
  }
  return qty
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
  if (!s) return { ok: false, msg: '时段不存在' }
  const sets = []
  const vals = []
  if (patch.capacity !== undefined) {
    const cap = Math.max(0, Math.round(num(patch.capacity)))
    if (cap < s.booked_count) return { ok: false, msg: `容量不可低于已预约人数 ${s.booked_count}` }
    sets.push('capacity=?'); vals.push(cap)
  }
  if (patch.oversell !== undefined) {
    const ov = Math.max(0, Math.min(200, Math.round(num(patch.oversell))))
    sets.push('oversell=?'); vals.push(ov)
  }
  if (patch.status !== undefined) {
    const st = ['open', 'closed'].includes(patch.status) ? patch.status : 'open'
    if (st === 'closed') {
      // 关闭时段：在途预约园方全额退款并生成投诉
      const pending = db.prepare("SELECT * FROM reservations WHERE slot_id=? AND status='booked'").all(id)
      if (pending.length) {
        const ride = s.scope === 'ride' ? db.prepare('SELECT * FROM rides WHERE id=?').get(s.ride_id) : null
        forceRefundByPark(pending, `运营关闭 ${s.day}日 ${s.hour}:00 时段，园方强制退款`,
          { title: `${ride ? ride.name : '分时入园'} · 时段临时取消`, category: ride ? 'facility' : 'service' })
      }
    }
    sets.push('status=?'); vals.push(st)
  }
  if (!sets.length) return { ok: false, msg: '无更新项' }
  vals.push(id)
  db.prepare(`UPDATE reservation_slots SET ${sets.join(',')} WHERE id=?`).run(...vals)
  return { ok: true }
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
  if (!slot) return { ok: false, msg: '时段不存在' }
  if (scope !== slot.scope || (scope === 'ride' && slot.ride_id !== num(rideId))) {
    return { ok: false, msg: '预约类型与时段不匹配' }
  }
  if (slot.day < ctx.day() || (slot.day === ctx.day() && slot.hour < ctx.hour())) {
    return { ok: false, msg: '不可预约已过期的时段' }
  }
  const q = Math.max(1, Math.min(20, Math.round(num(qty, 1))))
  const ride = scope === 'ride' ? db.prepare('SELECT * FROM rides WHERE id=?').get(slot.ride_id) : null
  if (scope === 'ride' && (!ride || ride.status !== 'operating')) return { ok: false, msg: '该设施当前不开放预约' }
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
