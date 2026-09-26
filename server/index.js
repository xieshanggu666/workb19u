import express from 'express'
import db, { getSetting, setSetting } from './db.js'
import {
  initReservationContext, ensureSlots, syncRideSlots,
  autoCheckin, expireNoShow, autoBookDemand,
  createReservation, cancelReservation, rescheduleReservation, checkinReservation,
  listSlots, listReservations, reservationLogs, updateSlot, reservationStats,
  refundReservation
} from './reservations.js'
import {
  initMaintenanceContext, backfillMaintenanceOrders, processMaintenance,
  createMaintenanceOrder, assignMaintenanceOrder, cancelMaintenanceOrder,
  cancelOrdersByRide, releaseStaffOrders, listMaintenanceOrders,
  maintenanceOrderDetail, maintenanceStats, staffLoad
} from './maintenance.js'

const app = express()
app.use(express.json())

const PORT = 4150
const HOURS_PER_DAY = 10   // 9:00 ~ 18:00
const OPEN_HOUR = 9
const TICK_MS = 2000

// 分期贷款参数：每 1 个游戏日 = 1 期
const LOAN_PERIOD_CHOICES = [5, 10, 20, 30]   // 可选期数(天)
const LOAN_RATE_CHOICES = [0.005, 0.01, 0.02] // 可选每期利率
const LOAN_MIN = 1000
const LOAN_MAX = 5000000
const OVERDUE_PENALTY = 0.02                  // 逾期挂账每日罚息 2%

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// ---------------- 工具 ----------------
const state = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  reputation: () => num(getSetting('reputation'), 70),
  ticket: () => num(getSetting('ticket'), 120),
  guestBase: () => num(getSetting('guestBase'), 600),
  wordOfMouth: () => num(getSetting('wordOfMouth'), 0)   // 投诉补救口碑 -10 ~ +10
}

const allZones = () => db.prepare('SELECT * FROM zones ORDER BY id').all()
const openZones = () => db.prepare('SELECT * FROM zones WHERE open=1').all()
const allRides = () => db.prepare('SELECT * FROM rides ORDER BY id').all()
const operatingRides = () => db.prepare("SELECT * FROM rides WHERE status='operating'").all()
const allVendors = () => db.prepare('SELECT * FROM vendors ORDER BY id').all()
const allStaff = () => db.prepare('SELECT * FROM staff ORDER BY id').all()

function logFinance(day, label, amount, detail) {
  db.prepare('INSERT INTO finance(tick,day,label,amount,detail) VALUES(?,?,?,?,?)')
    .run(state.tick(), day, label, Math.round(amount), detail || '')
}

// 分时预约模块共享：时钟 / 现金 / 财务流水 / 投诉建单
initReservationContext({
  logFinance,
  createComplaint: (payload) => createComplaint(payload)
})

// 检修工单模块共享：时钟 / 现金 / 财务流水 / 停运时段联动 / 完工联动设施类投诉
initMaintenanceContext({
  logFinance,
  syncRideSlots: (ride) => syncRideSlots(ride),
  linkComplaintsToRide: (rideId, staffId) => linkComplaintsToRide(rideId, staffId)
})

// ---------------- 分期贷款 ----------------
const activeLoans = () => db.prepare("SELECT * FROM loans WHERE status='active' ORDER BY id").all()

// 未偿本金合计（剩余本金，不含利息）
function loanDebt() {
  return activeLoans().reduce((s, l) => s + l.remain_principal, 0)
}

// 贷款汇总：剩余本金、挂账(逾期)金额、逾期贷款数
function debtSummary() {
  const ls = activeLoans()
  return {
    remainPrincipal: ls.reduce((s, l) => s + l.remain_principal, 0),
    arrears: ls.reduce((s, l) => s + l.arrears_p + l.arrears_i, 0),
    overdueCount: ls.filter(l => l.arrears_p + l.arrears_i > 0).length
  }
}

// 等额本息每期应还（末期靠尾款兜底，保证正好还清）
function calcInstallment(principal, rate, periods) {
  if (!rate) return Math.round(principal / periods)
  const pay = principal * rate * Math.pow(1 + rate, periods) / (Math.pow(1 + rate, periods) - 1)
  return Math.round(pay)
}

// 日结扣款（每天 1 期）；cash 为入参形式，返回 { cash, overdueHits, overdueIds }
function settleLoans(cash, day) {
  let overdueHits = 0
  const overdueIds = []
  for (const l of activeLoans()) {
    let dueP = 0, dueI = 0
    if (l.arrears_p + l.arrears_i > 0) {
      // 有逾期挂账：按挂账总额每日加罚息，先清欠账，不顺延新一期
      const penalty = Math.round((l.arrears_p + l.arrears_i) * OVERDUE_PENALTY)
      dueP = l.arrears_p
      dueI = l.arrears_i + penalty
    } else if (l.paid_periods < l.periods) {
      // 正常到期：末期收剩余本金 + 当期利息
      dueI = Math.round(l.remain_principal * l.rate)
      dueP = l.paid_periods + 1 >= l.periods
        ? l.remain_principal
        : Math.min(l.installment - dueI, l.remain_principal)
    } else continue

    const due = dueP + dueI
    const wasOverdue = (l.arrears_p + l.arrears_i) > 0
    if (cash >= due) {
      // 足额还款
      cash -= due
      if (dueI > 0) logFinance(day, '利息', -dueI, `贷款 #${l.id} 第${l.paid_periods + 1}期利息${wasOverdue ? '(含罚息)' : ''}`)
      if (dueP > 0) logFinance(day, '贷款', -dueP, `偿还贷款 #${l.id} 第${l.paid_periods + 1}期本金`)
      const remainPrincipal = Math.max(0, l.remain_principal - dueP)
      const paidPeriods = wasOverdue ? l.paid_periods : l.paid_periods + 1
      // 逾期补缴可能使本金先于期数归零，本金还清即结清
      const finished = remainPrincipal <= 0
      const upd = finished
        ? db.prepare("UPDATE loans SET remain_principal=?, paid_periods=?, arrears_p=0, arrears_i=0, status='done' WHERE id=?")
        : db.prepare('UPDATE loans SET remain_principal=?, paid_periods=?, arrears_p=0, arrears_i=0 WHERE id=?')
      upd.run(remainPrincipal, paidPeriods, l.id)
    } else {
      // 现金不足：按 利息(含罚息) → 本金 的顺序部分偿还，余额挂账并转逾期
      let avail = Math.max(0, cash)
      const payI = Math.min(dueI, avail)
      avail -= payI
      const payP = Math.min(dueP, avail)
      avail -= payP
      cash -= payI + payP
      if (payI > 0) logFinance(day, '利息', -Math.round(payI), `贷款 #${l.id} 部分付息(现金不足)`)
      if (payP > 0) logFinance(day, '贷款', -Math.round(payP), `贷款 #${l.id} 部分还本(现金不足)`)
      const leftI = dueI - payI
      const leftP = dueP - payP
      db.prepare('UPDATE loans SET remain_principal=?, arrears_p=?, arrears_i=?, overdue_days=overdue_days+1 WHERE id=?')
        .run(Math.max(0, l.remain_principal - payP), Math.round(leftP), Math.round(leftI), l.id)
      overdueHits += 1
      overdueIds.push(l.id)
    }
  }
  return { cash, overdueHits, overdueIds }
}

// ---------------- 游客投诉与服务补救 ----------------
// 投诉处置时限（游戏小时）：一般 8h / 严重 5h / 紧急 3h；升级后按新等级重置时限
const SEV_SLA = { 1: 8, 2: 5, 3: 3 }
const SEV_NAMES = { 1: '一般', 2: '严重', 3: '紧急' }
const OPEN_COMPLAINT_STATUSES = ['open', 'processing', 'ready']

const COMPLAINT_CATS = {
  queue:    { name: '排队秩序', icon: '⏳', roles: ['保安', '安保'] },
  hygiene:  { name: '环境卫生', icon: '🧹', roles: ['保洁'] },
  facility: { name: '设施故障', icon: '🛠️', roles: ['维修'] },
  safety:   { name: '安全隐患', icon: '🚨', roles: ['保安', '安保'] },
  food:     { name: '餐饮质量', icon: '🍔', roles: ['保洁'] },
  service:  { name: '服务态度', icon: '💁', roles: [] },      // 无专属岗位，任何员工均可受理
  pricing:  { name: '价格争议', icon: '💰', roles: [] },
  missing:  { name: '物品遗失', icon: '🎒', roles: ['保安', '安保'] }
}

const COMPLAINT_TPL = {
  queue: ['排队两小时游玩五分钟，队伍完全没人疏导！', '快速通道和普通队混在一起，秩序混乱。', '大热天排队区没有遮阳和饮水，太遭罪了。'],
  hygiene: ['卫生间又脏又臭，垃圾桶都溢出来了。', '休息区长椅上全是食物残渣，没人打扫。', '地面黏糊糊的，孩子差点滑倒。'],
  facility: ['设施运行时异响很大，坐着心里发慌。', '排到了却临时停运，白等一个多小时。', '安全压杠松动，工作人员也不仔细检查。'],
  safety: ['人流挤在一起没有保安疏导，感觉要出踩踏事故。', '护栏间隙太大，小孩能钻过去，太危险。', '夜间照明不足，台阶处差点摔倒。'],
  food: ['餐食是凉的，而且吃出异物，要求给个说法！', '饮料淡得像白水，价格还贵得离谱。', '吃完园内餐食后肚子不舒服。'],
  service: ['工作人员态度恶劣，问个路都不耐烦。', '检票员当众呵斥游客，体验极差。', '咨询台没人值守，等了半天没人理。'],
  pricing: ['园内物价是外面三倍，标价也不醒目。', '买了联票却多项设施另收费，涉嫌误导。', '纪念品结账价格和标签不一致。'],
  missing: ['孩子在园区走失半小时，广播寻人不及时。', '随身包在寄存处丢失，园方互相推诿。', '手机落在设施上，工作人员不配合查找。']
}

// 补偿方案：score 决定游客满意度，ticket 成本随当日票价浮动
const COMP_OPTIONS = {
  apology:  { name: '真诚道歉', cost: 0,    score: 6 },
  ticket:   { name: '赠门票',   cost: 0,    score: 14 },
  fastpass: { name: '快速通行券', cost: 150, score: 20 },
  voucher:  { name: '消费券',   cost: 300,  score: 26 },
  cash:     { name: '现金补偿', cost: 600,  score: 34 }
}

function logComplaint(cid, action, note, staffId = null) {
  db.prepare('INSERT INTO complaint_logs(complaint_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(cid, state.tick(), state.day(), state.hour(), action, note || '', staffId)
}

function createComplaint({ category, severity, title, content, target, source }) {
  const cat = COMPLAINT_CATS[category] ? category : 'service'
  const sev = Math.max(1, Math.min(3, Math.round(severity || 1)))
  const r = db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source)
                        VALUES(?,?,?,?,?,?,?,?,?,'open',?,?)`)
    .run('', state.tick(), state.day(), cat, sev, title, content || '', target?.type || '', target?.id ?? null, state.tick() + SEV_SLA[sev], source || 'guest')
  const id = Number(r.lastInsertRowid)
  const code = 'TS' + String(id).padStart(4, '0')
  db.prepare('UPDATE complaints SET code=? WHERE id=?').run(code, id)
  logComplaint(id, 'submit', source === 'manual' ? '前台登记游客反馈' : '游客通过客服热线提交投诉')
  return { id, code }
}

function pickComplaintTarget(cat, rides, vendors, zones) {
  const none = { type: '', id: null, name: '' }
  const pick = arr => arr[Math.floor(Math.random() * arr.length)]
  const openZoneIds = new Set(zones.filter(z => z.unlocked && z.open).map(z => z.id))
  if (cat === 'queue' || cat === 'facility') {
    const inPark = rides.filter(r => openZoneIds.has(r.zone_id))
    const pool = cat === 'queue'
      ? inPark.filter(r => r.queue > r.capacity * 2)
      : inPark.filter(r => r.health < 60)
    const r = pick(pool.length ? pool : inPark)
    return r ? { type: 'ride', id: r.id, name: r.name } : none
  }
  if (cat === 'hygiene') {
    const openZones = zones.filter(z => z.unlocked && z.open)
    const dirty = openZones.filter(z => z.cleanliness < 60)
    const z = pick(dirty.length ? dirty : openZones)
    return z ? { type: 'zone', id: z.id, name: z.name } : none
  }
  if (cat === 'food' || cat === 'pricing') {
    const inPark = vendors.filter(v => openZoneIds.has(v.zone_id))
    const pool = cat === 'food' ? inPark.filter(v => v.type !== '纪念品') : inPark
    const v = pick(pool.length ? pool : inPark)
    return v ? { type: 'vendor', id: v.id, name: v.name } : none
  }
  return none
}

// 每小时根据园区运营状况随机生成投诉（游客反馈入口）
function maybeSpawnComplaints(entering, satisfaction) {
  const openCount = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN ('open','processing','ready')").get().n
  if (openCount >= 15) return
  const rides = allRides()
  const ops = operatingRides()
  const zones = allZones()
  const longQueue = ops.filter(r => r.queue > r.capacity * 4).length
  const broken = rides.filter(r => r.status === 'maintenance').length
  const avgClean = zones.length ? zones.reduce((s, z) => s + z.cleanliness, 0) / zones.length : 70
  const protest = allEvents.actives().some(e => e.type === 'protest')
  const staffCount = allStaff().filter(s => s.active).length
  const chance = 0.10
    + longQueue * 0.05
    + broken * 0.05
    + Math.max(0, 60 - avgClean) * 0.004
    + Math.min(0.12, entering / 6000)
    + (protest ? 0.18 : 0)
    + (staffCount < 3 ? 0.06 : 0)
    + (satisfaction < 55 ? 0.06 : 0)
  if (Math.random() >= chance) return

  // 按当前园区状况加权选择投诉类别
  const weights = [
    ['queue', 1 + longQueue * 2.5],
    ['hygiene', 1 + Math.max(0, 60 - avgClean) / 6],
    ['facility', 1 + broken * 2.5],
    ['safety', protest ? 3 : 0.6],
    ['food', 1],
    ['service', staffCount < 4 ? 2.2 : 1],
    ['pricing', state.ticket() > 160 ? 2 : 0.8],
    ['missing', 0.5]
  ]
  const totalW = weights.reduce((s, w) => s + w[1], 0)
  let roll = Math.random() * totalW, category = 'service'
  for (const [k, w] of weights) { roll -= w; if (roll <= 0) { category = k; break } }

  // 严重度：安全类更可能升级
  const sr = Math.random()
  const severity = category === 'safety'
    ? (sr < 0.18 ? 3 : sr < 0.55 ? 2 : 1)
    : (sr < 0.07 ? 3 : sr < 0.30 ? 2 : 1)

  const target = pickComplaintTarget(category, rides, allVendors(), zones)
  const tpls = COMPLAINT_TPL[category]
  const content = tpls[Math.floor(Math.random() * tpls.length)]
  const title = `${COMPLAINT_CATS[category].name}投诉 · ${target.name || '园区整体'}`
  createComplaint({ category, severity, title, content, target, source: 'guest' })
}

// 紧急投诉超时未处置：游客公开差评，声誉/口碑受损
function timeoutCloseComplaint(c) {
  db.prepare(`UPDATE complaints SET status='closed_timeout', close_reason='限时内未处置，游客愤而离场并公开差评', closed_tick=?, closed_day=? WHERE id=?`)
    .run(state.tick(), state.day(), c.id)
  logComplaint(c.id, 'timeout', '紧急投诉超时未处置，游客公开差评')
  const wom = Math.max(-10, state.wordOfMouth() - 2)
  setSetting('wordOfMouth', Math.round(wom * 10) / 10)
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), state.day(), 'complaint', '投诉超时引发差评', `「${c.title}」未在限时内处置，游客在社交平台公开差评，口碑受损。`, -2, 'active')
  return 6
}

// 投诉处置主循环：受理中推进进度；超时自动升级或结案；待确认补偿久置自动致歉结案。返回本时段声誉扣分
function processComplaints() {
  const tick = state.tick()
  let repPenalty = 0
  const open = db.prepare("SELECT * FROM complaints WHERE status IN ('open','processing','ready')").all()
  const upd = db.prepare('UPDATE complaints SET status=?, progress=?, deadline_tick=?, severity=?, escalated=?, escalations=?, resolved_tick=? WHERE id=?')
  for (const c of open) {
    if (c.status === 'ready') {
      if (tick - (c.resolved_tick || c.tick) >= 6) {
        doResolveComplaint(c.id, 'apology', true)
      }
      continue
    }
    if (tick > c.deadline_tick) {
      if (c.severity < 3) {
        // 限时未处置：自动升级一级，时限重置，声誉受损
        const sev = c.severity + 1
        upd.run(c.status, c.progress, tick + SEV_SLA[sev], sev, 1, c.escalations + 1, c.resolved_tick, c.id)
        logComplaint(c.id, 'auto_escalate', `超过限时未处置，自动升级为「${SEV_NAMES[sev]}」`)
        repPenalty += sev * 1.2
      } else {
        repPenalty += timeoutCloseComplaint(c)
      }
      continue
    }
    if (c.status === 'processing') {
      const st = c.assignee_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(c.assignee_id) : null
      if (!st || !st.active) {
        upd.run('open', c.progress, c.deadline_tick, c.severity, c.escalated, c.escalations, c.resolved_tick, c.id)
        logComplaint(c.id, 'unassign', '受理员工离岗，投诉退回待受理')
        continue
      }
      const meta = COMPLAINT_CATS[c.category] || COMPLAINT_CATS.service
      const match = !meta.roles.length || meta.roles.includes(st.role)
      const rate = (8 + st.skill * 5 + st.morale / 12) * (match ? 1.5 : 1)
      const progress = c.progress + rate
      if (progress >= 100) {
        upd.run('ready', 100, c.deadline_tick, c.severity, c.escalated, c.escalations, tick, c.id)
        logComplaint(c.id, 'ready', `${st.name} 完成现场处置，等待补偿确认`, st.id)
      } else {
        upd.run('processing', Math.round(progress * 10) / 10, c.deadline_tick, c.severity, c.escalated, c.escalations, c.resolved_tick, c.id)
      }
    }
  }
  return repPenalty
}

// 补偿结案：依据处置质量、补偿档次、等待时长与升级记录计算游客评价，回流声誉/口碑/员工满意度
function doResolveComplaint(id, compKey, auto = false) {
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c) return { ok: false, msg: '投诉不存在' }
  if (c.status !== 'ready') return { ok: false, msg: '需先指派员工完成现场处置' }
  const opt = COMP_OPTIONS[compKey] || COMP_OPTIONS.apology
  const cost = compKey === 'ticket' ? state.ticket() : opt.cost
  let cash = state.cash()
  if (cash < cost) return { ok: false, msg: `资金不足，该补偿方案需 ¥${cost.toLocaleString()}` }

  const st = c.assignee_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(c.assignee_id) : null
  const meta = COMPLAINT_CATS[c.category] || COMPLAINT_CATS.service
  const match = st && (!meta.roles.length || meta.roles.includes(st.role))
  const quality = st ? Math.min(100, st.skill * 18 + st.morale * 0.4 + (match ? 15 : 0)) : 30
  const waited = Math.max(0, state.tick() - c.tick)
  let rating = 1.6 + quality / 30 + opt.score / 12 - (waited > 24 ? 0.6 : waited > 12 ? 0.3 : 0) - (c.escalated ? 0.3 : 0)
  rating = Math.max(1, Math.min(5, Math.round(rating)))

  cash -= cost
  setSetting('cash', Math.round(cash))
  const repGain = 1.2 + rating * 0.8 + c.severity * 0.4
  setSetting('reputation', Math.round(Math.max(5, Math.min(100, state.reputation() + repGain)) * 10) / 10)
  const wom = Math.max(-10, Math.min(10, state.wordOfMouth() + (rating - 3) * 0.8))
  setSetting('wordOfMouth', Math.round(wom * 10) / 10)
  if (st) db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.max(20, Math.min(100, st.morale + (rating >= 4 ? 4 : rating === 3 ? 1 : -3))), st.id)
  if (cost > 0) logFinance(state.day(), '补偿', -cost, `投诉 ${c.code}「${opt.name}」`)

  db.prepare(`UPDATE complaints SET status='closed_resolved', compensation=?, comp_cost=?, rating=?, close_reason=?, closed_tick=?, closed_day=? WHERE id=?`)
    .run(compKey, cost, rating, auto ? '超时未确认补偿，系统自动以真诚道歉结案' : '补偿方案确认，游客满意离园', state.tick(), state.day(), id)
  logComplaint(id, 'resolve', `${auto ? '系统自动' : '确认'}补偿「${opt.name}」${cost ? `，支出 ¥${cost}` : ''}，游客评价 ${rating} 星`, st?.id ?? null)
  return { ok: true, rating, cost }
}

// 不予补偿直接结案：游客不满，声誉与口碑受损
function forceCloseComplaint(id) {
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c || !OPEN_COMPLAINT_STATUSES.includes(c.status)) return { ok: false, msg: '投诉不存在或已结案' }
  db.prepare(`UPDATE complaints SET status='closed_force', close_reason='园方未予补偿，游客不满离去', closed_tick=?, closed_day=? WHERE id=?`)
    .run(state.tick(), state.day(), id)
  logComplaint(id, 'force', '园方未予补偿直接结案，游客不满')
  setSetting('reputation', Math.round(Math.max(5, state.reputation() - (2 + c.severity)) * 10) / 10)
  const wom = Math.max(-10, state.wordOfMouth() - 1)
  setSetting('wordOfMouth', Math.round(wom * 10) / 10)
  return { ok: true }
}

// 检修完工联动：维修工在现场可一并处置针对该设施的「设施故障」投诉
// 待受理的同设施设施类投诉由其接手并记 40% 处置进度；已由其本人推进的直接完成现场处置待补偿
function linkComplaintsToRide(rideId, staffId) {
  if (!staffId) return
  const st = db.prepare('SELECT * FROM staff WHERE id=?').get(staffId)
  if (!st || !st.active) return
  const rows = db.prepare(`SELECT * FROM complaints WHERE category='facility' AND target_type='ride' AND target_id=?
                           AND status IN ('open','processing')`).all(rideId)
  for (const c of rows) {
    if (c.status === 'processing' && c.assignee_id === staffId) {
      db.prepare('UPDATE complaints SET status=?, progress=100, resolved_tick=? WHERE id=?')
        .run('ready', state.tick(), c.id)
      logComplaint(c.id, 'ready', `${st.name} 随设施检修完工一并完成现场处置，等待补偿确认`, staffId)
    } else if (c.status === 'open') {
      db.prepare("UPDATE complaints SET status='processing', assignee_id=?, progress=40 WHERE id=?").run(staffId, c.id)
      logComplaint(c.id, 'assign', `设施检修完工，${st.name} 现场接手处置该故障投诉`, staffId)
    }
  }
}

function enrichComplaints(rows) {
  const tick = state.tick()
  const rides = allRides(), vendors = allVendors(), zones = allZones()
  return rows.map(c => {
    const st = c.assignee_id ? db.prepare('SELECT id,name,role,skill,morale FROM staff WHERE id=?').get(c.assignee_id) : null
    const target = c.target_type === 'ride' ? rides.find(r => r.id === c.target_id)
      : c.target_type === 'vendor' ? vendors.find(v => v.id === c.target_id)
      : c.target_type === 'zone' ? zones.find(z => z.id === c.target_id) : null
    const meta = COMPLAINT_CATS[c.category] || COMPLAINT_CATS.service
    const active = ['open', 'processing'].includes(c.status)
    return {
      ...c,
      category_name: meta.name,
      category_icon: meta.icon,
      severity_name: SEV_NAMES[c.severity],
      remain_ticks: active ? c.deadline_tick - tick : 0,
      overdue: active && tick > c.deadline_tick,
      assignee_name: st?.name || '',
      assignee_role: st?.role || '',
      role_match: st ? (!meta.roles.length || meta.roles.includes(st.role)) : false,
      target_name: target?.name || ''
    }
  })
}

function complaintStats() {
  const open = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN ('open','processing','ready')").get().n
  const overdue = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN ('open','processing') AND deadline_tick < ?").get(state.tick()).n
  const todayClosed = db.prepare('SELECT COUNT(*) n FROM complaints WHERE closed_day=?').get(state.day()).n
  const resolved = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status='closed_resolved'").get().n
  const total = db.prepare('SELECT COUNT(*) n FROM complaints').get().n
  const avgRating = db.prepare("SELECT AVG(rating) a FROM complaints WHERE status='closed_resolved' AND rating>0").get().a || 0
  const compTotal = db.prepare("SELECT COALESCE(SUM(comp_cost),0) s FROM complaints WHERE status='closed_resolved'").get().s || 0
  return { open, overdue, todayClosed, resolved, total, avgRating: Math.round(avgRating * 10) / 10, compTotal }
}

// ---------------- 游戏主循环 ----------------
function tick() {
  let day = state.day()
  let hour = state.hour() + 1
  let cash = state.cash()
  let rep = state.reputation()
  const ticket = state.ticket()
  const base = state.guestBase()

  let tickCount = state.tick() + 1
  setSetting('tick', tickCount)

  // 跨天结算
  let overdueHits = 0
  let overdueIds = []
  if (hour > OPEN_HOUR + HOURS_PER_DAY - 1) {
    hour = OPEN_HOUR
    // 日结工资
    const wage = allStaff().filter(s => s.active).reduce((s, st) => s + st.wage, 0)
    cash -= wage
    logFinance(day, '工资', -wage, '当日员工工资')
    // 日结租金
    const rent = allVendors().reduce((s, v) => s + v.rent, 0)
    cash -= rent
    logFinance(day, '租金', -rent, '当日商铺租金')
    // 日结分期贷款：同步扣款；现金不足时按 利息→本金 部分偿还并转逾期挂账
    const settled = settleLoans(cash, day)
    cash = settled.cash
    overdueHits = settled.overdueHits
    overdueIds = settled.overdueIds
    day += 1
    setSetting('day', day)
  }
  setSetting('hour', hour)

  // ---- 分时预约闭环 ----
  ensureSlots()                       // 维护未来三天的入园/设施时段库存
  expireNoShow(hour)                  // 过时段未核销 → 爽约，预收款没收
  // 入园时段（9~18点）核销当前时段预约：容量内放行，超售自动改签/退款
  let reservedEntry = 0
  const reservedRiders = new Map()
  if (hour >= OPEN_HOUR && hour <= OPEN_HOUR + HOURS_PER_DAY - 1) {
    const arrival = autoCheckin(hour)
    reservedEntry = arrival.entry
    arrival.ride.forEach((qty, rid) => reservedRiders.set(rid, qty))
  }

  // 入园人数模型（散客侧：预约到场已计入实际客流，不再重复收取门票）
  const retail = hour <= 6 ? 0.5 : hour >= 16 ? 0.6 : 1   // 早晚人少
  const priceFactor = Math.max(0.2, 2.0 - ticket / 100)     // 价越高人越少
  const repFactor = 0.4 + rep / 100
  const zoneFactor = 1
  // 投诉补救口碑回流：每点口碑约影响 ±1.2% 客流
  const complaintFactor = Math.max(0.7, 1 + state.wordOfMouth() * 0.012)
  // 分时预约已锁定部分客流：散客 = 自然需求；总入园 = 散客 + 预约核销到场
  const walkIn = Math.round(base * retail * priceFactor * repFactor * zoneFactor * complaintFactor * (0.85 + Math.random() * 0.3))
  const entering = walkIn + reservedEntry
  const satisfaction = computeSatisfaction(reservedEntry, entering)
  // 游客反馈：运营状况驱动随机投诉
  maybeSpawnComplaints(entering, satisfaction)
  const avgSpend = 40 + satisfaction / 5 + Math.random() * 15
  const spend = Math.round(entering * (avgSpend * 0.15 + ticket * 0.5)) // 门票为主的收入模型

  // 门票收入：仅散客现场购票；预约门票已在下单时预收
  const ticketRev = Math.round(walkIn * ticket)
  cash += ticketRev
  if (ticketRev > 0) logFinance(day, '门票', ticketRev, `散客入园 ${walkIn} 人·当日票`)

  const zones = allZones()
  // 游客在各开放的游玩区域分配
  const ops = operatingRides()
  const totalAttr = ops.reduce((s, r) => s + r.attr * (r.health / 100), 1)
  let rideIncome = 0
  const rideStmt = db.prepare('UPDATE rides SET queue=?, play_count=play_count+?, rev=rev+?, health=? WHERE id=?')
  const newRides = ops.map(r => {
    const share = (r.attr * (r.health / 100)) / totalAttr
    // 设施预约核销游客走快速通道：直接游玩、不排队，费用已在预约时预收
    const reserved = reservedRiders.get(r.id) || 0
    const organic = Math.max(0, Math.min(Math.round(walkIn * 1.6 * share), r.capacity * 6) - reserved)
    const riders = organic + reserved
    const income = Math.round(organic * r.price)
    rideIncome += income
    cash += income
    // 健康度随时间小幅衰减
    const decay = r.thrill > 80 ? 1.8 : r.thrill > 50 ? 1.1 : 0.7
    const health = Math.max(0, r.health - decay)
    const queue = Math.max(0, organic - r.capacity * 2) * 0.6
    rideStmt.run(Math.round(queue), riders, income, Math.round(health * 10) / 10, r.id)
    return { ...r, riders, income }
  }).filter(Boolean)
  if (rideIncome > 0) logFinance(day, '游乐', rideIncome, '散客游乐设施营收（预约已预收）')

  // 设施运行成本
  let runCost = 0
  ops.forEach(r => {
    if (r.status === 'operating') { runCost += r.run_cost; cash -= r.run_cost }
  })
  if (runCost > 0) logFinance(day, '运营', -runCost, '设施运行成本')

  // 清扫/安保维护 = 保洁保安数量相关；干净度随时间降低
  const cleaters = allStaff().filter(s => s.role === '保洁' && s.active).length
  const guards = allStaff().filter(s => s.role === '保安' && s.active).length
  for (const z of zones) {
    let c = z.cleanliness
    c -= 2.5
    if (cleaters > 0) c += 3.5 * Math.min(cleaters, 3)
    c = Math.max(5, Math.min(100, c))
    const scenery = z.scenery + (z.scenery < 60 ? 0.2 : 0)
    db.prepare('UPDATE zones SET cleanliness=? WHERE id=?').run(Math.round(c), z.id)
  }

  // 商铺营收
  const activeZoneIds = zones.filter(z => z.open).map(z => z.id)
  const vendors = allVendors().filter(v => activeZoneIds.includes(v.zone_id))
  const vStmt = db.prepare('UPDATE vendors SET sold=sold+?, rev=rev+? WHERE id=?')
  let vendorIncome = 0
  for (const v of vendors) {
    const zone = zones.find(z => z.id === v.zone_id)
    const zFlow = (zone ? zone.capacity : 150) * (satisfaction / 100)
    const sold = Math.round(Math.min(zFlow / 8, entering / 6) * (0.8 + Math.random() * 0.4))
    const income = Math.round(sold * v.price * v.margin)
    vendorIncome += income
    cash += income
    vStmt.run(sold, income, v.id)
  }
  if (vendorIncome > 0) logFinance(day, '商业', vendorIncome, '商铺营收')

  // 需求侧：模拟游客为未来三天的入园/设施时段下单预约（预收款即入账）
  autoBookDemand(allRides(), base, priceFactor, repFactor * complaintFactor)

  // 员工满意度
  const sm = db.prepare('UPDATE staff SET morale=? WHERE id=?')
  allStaff().forEach(s => {
    if (!s.active) return
    let m = s.morale + (s.wage > 360 ? 1.2 : -0.3) + (Math.random() * 1 - 0.5)
    m = Math.max(20, Math.min(100, m))
    sm.run(Math.round(m), s.id)
  })

  // 事件影响
  const es = allEvents.actives()
  let eventRepShift = 0
  for (const e of es) {
    if (e.impact && e.status === 'active') eventRepShift += (e.impact > 0 ? 0.8 : -1.6)
  }

  // 投诉处置：推进受理进度，超时自动升级 / 公开差评，返回本时段声誉扣分
  const complaintPenalty = processComplaints()

  // 设施检修工单：维修员工接单后按游戏时间推进，离岗退回排队，完工恢复运营并结算费用
  processMaintenance()

  // 声誉演化：满意度+事件+预算健康度+超时投诉
  const budgetHealth = cash > 0 ? Math.min(1, cash / 200000) : -0.4
  rep = Math.max(5, Math.min(100, rep + (satisfaction - 70) * 0.15 + budgetHealth * 2 + eventRepShift - complaintPenalty))

  // 贷款逾期：信用受损（本次日结新产生的逾期，每条 -1.5 声誉）
  if (overdueHits > 0) {
    rep = Math.max(5, rep - 1.5 * overdueHits)
    const ids = overdueIds.join('、#')
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(tickCount, day, 'overdue', '贷款还款逾期', `日结时现金不足以偿还分期贷款 #${ids}，欠款已挂账并按日计 2% 罚息，后续日结将优先补扣。`, -2, 'active')
  }

  // 满意度驱动消费
  const eatSpend = Math.round(entering * avgSpend * 0.3)
  cash += eatSpend
  if (eatSpend > 0) logFinance(day, '消费', eatSpend, '园内消费')

  db.prepare('INSERT INTO visitors(tick,day,hour,count,satisfaction,eat,total_spend) VALUES(?,?,?,?,?,?,?)')
    .run(tickCount, day, hour, entering, Math.round(satisfaction * 10) / 10, Math.round(avgSpend * 10) / 10, Math.round(spend * 10) / 10)

  // 服务口碑自然回落，避免一次补偿永久加成
  const womNow = state.wordOfMouth()
  if (womNow !== 0) setSetting('wordOfMouth', Math.round(womNow * 0.98 * 100) / 100)

  setSetting('cash', Math.round(cash))
  setSetting('reputation', Math.round(rep * 10) / 10)

  // 随机事件
  maybeSpawnEvent(day)

  checkBrokenDown(day)
}

function computeSatisfaction(reserved = 0, total = 0) {
  const zones = allZones()
  const avgClean = zones.length ? zones.reduce((s, z) => s + z.cleanliness, 0) / zones.length : 70
  const ops = operatingRides()
  const openRatio = (allRides().length ? ops.length / allRides().length : 1)
  let sat = 50
  sat += (avgClean - 60) * 0.5
  sat += openRatio * 35
  const longQueue = ops.filter(r => r.queue > r.capacity * 4).length
  sat -= longQueue * 3
  // 未结投诉持续拉低满意度（按严重度，上限 15），服务口碑小幅回流
  const drag = db.prepare("SELECT COALESCE(SUM(severity),0) s FROM complaints WHERE status IN ('open','processing','ready')").get().s
  sat -= Math.min(15, drag * 0.8)
  sat += Math.max(-10, Math.min(10, state.wordOfMouth())) * 0.5
  sat += state.reputation() * 0.2
  // 分时预约核销占比越高，入园/排队越有序，满意度小幅加成（上限 +4）
  if (total > 0) sat += Math.min(4, (reserved / total) * 8)
  return Math.max(10, Math.min(100, sat))
}

// ---------------- 事件系统 ----------------
const allEvents = {
  actives: () => db.prepare("SELECT * FROM events WHERE status='active'").all()
}

const EVENT_POOL = [
  { type: 'weather', title: '午后阵雨', desc: '降雨影响游客体验，入园客流下降，清洁压力增大。', impact: -1 },
  { type: 'crowd', title: '客流高峰', desc: '游客激增，设施队列变长，需增派保洁缓解拥挤。', impact: 1 },
  { type: 'fault', title: '设备故障隐患', desc: '一台高刺激设施发出异响，建议立即停运检修。', impact: -2 },
  { type: 'celebrity', title: '明星到访', desc: '知名艺人入园引发关注，声望提升，周边商铺客流大增。', impact: 2 },
  { type: 'protest', title: '排队投诉潮', desc: '游客因排队时间过长集中投诉。', impact: -2 },
  { type: 'fever', title: '节令热潮', desc: '季节主题推动消费，游客日均消费上升。', impact: 1 }
]

function maybeSpawnEvent(day) {
  if (Math.random() > 0.12) return
  const ev = EVENT_POOL[Math.floor(Math.random() * EVENT_POOL.length)]
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), day, ev.type, ev.title, ev.desc, ev.impact, 'active')
}

function checkBrokenDown(day) {
  // 健康度跌破红线：自动停运并生成检修工单（进入排队，待维修员工接单）
  // 停运联动在工单创建时完成（关停时段、在途预约园方全额退款、生成投诉）
  const bad = db.prepare("SELECT * FROM rides WHERE health<25 AND status='operating'").all()
  for (const r of bad) {
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(state.tick(), day, 'fault', '设备突发故障', `「${r.name}」健康度过低已自动停运，检修工单已进入维修队列，请尽快安排维修工接单。`, -1, 'active')
    createMaintenanceOrder(r.id, 'auto')
  }
}

// 兼容既有检修状态：为已停运检修但无在途工单的设施补建排队工单
backfillMaintenanceOrders()

// 启动循环
tick()
setInterval(tick, TICK_MS)

// ---------------- API ----------------
app.get('/api/state', (req, res) => {
  const rides = allRides().map(r => {
    const mo = db.prepare(`SELECT * FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing') ORDER BY id DESC LIMIT 1`).get(r.id)
    return mo ? { ...r, maint_order_id: mo.id, maint_status: mo.status } : r
  })
  const loadMap = staffLoad()
  const visitors = db.prepare('SELECT * FROM visitors ORDER BY id DESC LIMIT 60').all().reverse()
  const fin = db.prepare('SELECT * FROM finance ORDER BY id DESC LIMIT 80').all().reverse()
  const loans = activeLoans().map(l => {
    const arrears = l.arrears_p + l.arrears_i
    const nextI = l.paid_periods < l.periods ? Math.round(l.remain_principal * l.rate) : 0
    const nextP = l.paid_periods + 1 >= l.periods ? l.remain_principal : Math.min(l.installment - nextI, l.remain_principal)
    return {
      ...l,
      ratePct: Math.round(l.rate * 1000) / 10,
      arrears,
      nextDue: l.paid_periods < l.periods ? nextP + nextI : 0,
      nextPrincipal: nextP,
      nextInterest: nextI,
      over: arrears > 0
    }
  })
  return res.json({
    clock: { day: state.day(), hour: state.hour(), tick: state.tick() },
    cash: state.cash(),
    reputation: state.reputation(),
    ticket: state.ticket(),
    loan: loanDebt(),
    loans,
    debt: debtSummary(),
    loanChoices: { periods: LOAN_PERIOD_CHOICES, rates: LOAN_RATE_CHOICES.map(r => Math.round(r * 1000) / 10) },
    visitorToday: visitors.filter(v => v.day === state.day()).reduce((s, v) => s + v.count, 0),
    visitors,
    zones: allZones(),
    rides,
    vendors: allVendors(),
    staff: allStaff().map(s => ({ ...s, maint_load: loadMap.get(s.id) || 0 })),
    maintenanceOrders: listMaintenanceOrders({ limit: 100 }),
    maintenanceStats: maintenanceStats(),
    events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 40').all(),
    complaints: enrichComplaints(db.prepare('SELECT * FROM complaints ORDER BY id DESC LIMIT 60').all()),
    complaintStats: complaintStats(),
    wordOfMouth: state.wordOfMouth(),
    reservationStats: reservationStats(),
    entrySlots: listSlots({ scope: 'entry' }),
    reservations: listReservations({ limit: 100 }),
    finance: fin,
    avgs: {
      satisfaction: computeSatisfaction(),
      openRatio: rides.length ? operatingRides().length / rides.length : 0
    }
  })
})

app.get('/api/summary', (req, res) => {
  const riders = db.prepare("SELECT SUM(play_count) n, SUM(rev) s FROM rides").get()
  return res.json({
    totalRidePlays: riders.n || 0,
    totalRideRev: riders.s || 0,
    totalVisitors: (db.prepare('SELECT SUM(count) n FROM visitors').get().n || 0),
    totalEvents: db.prepare('SELECT COUNT(*) n FROM events').get().n,
    finance: db.prepare('SELECT label, SUM(amount) amount FROM finance GROUP BY label').all()
  })
})

// ---- 设施 ----
app.post('/api/rides', (req, res) => {
  const b = req.body || {}
  const type = b.type || '过山车'
  const zone_id = num(b.zone_id, 1)
  const name = b.name || `${type} · 新建`
  const preset = {
    '过山车': [32, 6, 60000, 260, 92], '旋转木马': [40, 4, 20000, 70, 15],
    '摩天轮': [24, 12, 45000, 150, 45], '跳楼机': [20, 8, 35000, 130, 88],
    '碰碰车': [12, 5, 26000, 95, 60], '海盗船': [30, 7, 38000, 140, 78],
    '水上漂流': [28, 9, 42000, 160, 82], '云霄飞车': [22, 10, 52000, 200, 90]
  }[type] || [20, 5, 30000, 100, 60]
  const [capacity, cycle, cost, run_cost, thrill] = preset
  let cash = state.cash()
  if (cash < cost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= cost
  setSetting('cash', Math.round(cash))
  const r = db.prepare('INSERT INTO rides(name,type,zone_id,status,capacity,cycle_min,build_cost,run_cost,thrill,attr,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(name, type, zone_id, 'operating', capacity, cycle, cost, run_cost, thrill, 60 + thrill * 0.2, Math.max(20, Math.round(thrill * 0.6)), req.body.pos_row || 0, req.body.pos_col || 0)
  logFinance(state.day(), '建设', -cost, `建造 ${name}`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/rides/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}

  // 检修：不再即时修复，改为创建检修工单（排队待维修员工接单，按游戏时间推进，完工结算恢复）
  if (b.repair) {
    const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(id)
    if (!ride) return res.status(404).json({ ok: false, msg: '设施不存在' })
    const r = createMaintenanceOrder(id, 'manual')
    if (!r.ok) return res.status(400).json(r)
    return res.json(r)
  }

  const sets = []
  const vals = []
  if (b.status) {
    // 在途检修工单期间不允许直接改运营状态：完工自动恢复，需撤销请先撤销工单
    const openOrder = db.prepare("SELECT id FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing')").get(id)
    if (openOrder) return res.status(400).json({ ok: false, msg: '该设施有在途检修工单，工单完工后自动恢复运营' })
    sets.push('status=?'); vals.push(b.status)
  }
  if (b.price) { sets.push('price=?'); vals.push(num(b.price)) }
  if (b.name) { sets.push('name=?'); vals.push(b.name) }
  if (b.thrill && b.upgrade) {
    // 升级刺激度花成本提升吸引度
    const up = num(b.upgrade, 0)
    sets.push('thrill=thrill+?'); vals.push(up)
    sets.push('attr=attr+?'); vals.push(up * 0.3)
    let cash = state.cash()
    const cost = up * 3000
    cash -= cost
    setSetting('cash', Math.round(cash))
    logFinance(state.day(), '升级', -cost, `升级设施 #${id}`)
  }
  if (!sets.length) return res.json({ ok: false, msg: '无更新项' })
  vals.push(id)
  db.prepare(`UPDATE rides SET ${sets.join(',')} WHERE id=?`).run(...vals)
  // 设施开放/停运联动分时预约：停运强制退款在途预约，恢复重新开放时段
  if (b.status) {
    const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(id)
    syncRideSlots(ride)
  }
  res.json({ ok: true })
})

app.delete('/api/rides/:id', (req, res) => {
  const id = num(req.params.id)
  // 拆除前对在途预约按园方原因全额退款
  const pending = db.prepare("SELECT * FROM reservations WHERE ride_id=? AND status='booked'").all(id)
  for (const r of pending) {
    refundReservation(r, 'park', '设施拆除，园方强制退款')
  }
  // 在途检修工单作废
  cancelOrdersByRide(id)
  db.prepare('DELETE FROM rides WHERE id=?').run(id)
  res.json({ ok: true })
})

// ---- 商铺 ----
app.post('/api/vendors', (req, res) => {
  const b = req.body || {}
  const type = b.type || '餐饮'
  const preset = { '餐饮': [0.62, 1000, 32], '纪念品': [0.7, 1200, 45], '饮品': [0.72, 600, 18] }[type] || [0.6, 800, 25]
  const [margin, rent, price] = preset
  let cash = state.cash()
  const buildCost = 8000
  if (cash < buildCost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= buildCost
  setSetting('cash', Math.round(cash))
  const r = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
    .run(b.name || `新${type}摊`, type, num(b.zone_id, 1), rent, margin, price, b.pos_row || 0, b.pos_col || 0)
  logFinance(state.day(), '建设', -buildCost, `开设 ${type} 商铺`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/vendors/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.price) db.prepare('UPDATE vendors SET price=? WHERE id=?').run(num(b.price), id)
  if (b.staff_id !== undefined) {
    const sid = b.staff_id ? num(b.staff_id) : null
    db.prepare('UPDATE vendors SET staff_id=? WHERE id=?').run(sid, id)
    if (sid) db.prepare("UPDATE staff SET assigned_ride_id=NULL WHERE id=?").run(sid)
  }
  res.json({ ok: true })
})

app.delete('/api/vendors/:id', (req, res) => {
  db.prepare('DELETE FROM vendors WHERE id=?').run(num(req.params.id))
  res.json({ ok: true })
})

// ---- 员工 ----
const ROLES = ['保安', '保洁', '维修']
app.post('/api/staff', (req, res) => {
  const b = req.body || {}
  const role = b.role || '保安'
  if (!ROLES.includes(role)) return res.status(400).json({ ok: false, msg: '非法岗位' })
  const wage = role === '维修' ? 380 : role === '保洁' ? 300 : 320
  const r = db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,?,?,?,?,?)')
    .run(b.name || `新员工`, role, num(b.zone_id, 1), wage, 1, 80, 1)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/staff/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.zone_id) db.prepare('UPDATE staff SET zone_id=? WHERE id=?').run(num(b.zone_id), id)
  if (b.active !== undefined) {
    db.prepare('UPDATE staff SET active=? WHERE id=?').run(b.active ? 1 : 0, id)
    // 维修工离岗：在修工单退回排队、进度保留，等待其他维修工接续
    if (!b.active) releaseStaffOrders(id)
  }
  if (b.assignRide) db.prepare('UPDATE staff SET assigned_ride_id=? WHERE id=?').run(num(b.assignRide), id)
  if (b.assignVendor) db.prepare('UPDATE staff SET assigned_ride_id=? WHERE id=?').run(num(b.assignVendor), id)
  res.json({ ok: true })
})

// ---- 区域 ----
app.post('/api/zones/:id/unlock', (req, res) => {
  const id = num(req.params.id)
  const z = db.prepare('SELECT * FROM zones WHERE id=?').get(id)
  if (!z) return res.status(404).json({ ok: false })
  let cash = state.cash()
  const cost = 80000
  if (cash < cost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= cost
  setSetting('cash', Math.round(cash))
  db.prepare('UPDATE zones SET unlocked=1, open=1 WHERE id=?').run(id)
  logFinance(state.day(), '扩建', -cost, `开放「${z.name}」`)
  res.json({ ok: true })
})

app.post('/api/zones/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.open !== undefined) db.prepare('UPDATE zones SET open=? WHERE id=?').run(b.open ? 1 : 0, id)
  if (b.scenery !== undefined) db.prepare('UPDATE zones SET scenery=? WHERE id=?').run(num(b.scenery), id)
  res.json({ ok: true })
})

// ---- 票务 / 分期贷款 ----
app.post('/api/ticket', (req, res) => {
  const p = num(req.body?.price, 120)
  setSetting('ticket', Math.max(10, Math.min(500, p)))
  res.json({ ok: true, ticket: num(getSetting('ticket')) })
})

// 申请分期贷款：可选期数(天)与每期利率，等额本息
app.post('/api/loan', (req, res) => {
  const amount = Math.round(num(req.body?.amount))
  const periods = Math.round(num(req.body?.periods, 10))
  // 前端以百分数传入（1 表示每期 1%）
  const rate = req.body?.ratePct !== undefined
    ? num(req.body.ratePct) / 100
    : num(req.body?.rate, 0.01)
  if (!Number.isFinite(amount) || amount < LOAN_MIN || amount > LOAN_MAX) {
    return res.status(400).json({ ok: false, msg: `贷款金额需在 ${LOAN_MIN.toLocaleString()} ~ ${LOAN_MAX.toLocaleString()} 之间` })
  }
  if (!Number.isInteger(periods) || periods < 1 || periods > 60) {
    return res.status(400).json({ ok: false, msg: '期数需为 1~60 之间的整数（天）' })
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.05) {
    return res.status(400).json({ ok: false, msg: '每期利率需在 0% ~ 5% 之间' })
  }
  const installment = calcInstallment(amount, rate, periods)
  const day = state.day()
  const r = db.prepare(`INSERT INTO loans(principal,rate,periods,installment,remain_principal,start_day,created_tick)
                        VALUES(?,?,?,?,?,?,?)`)
    .run(amount, rate, periods, installment, amount, day, state.tick())
  const cash = state.cash() + amount
  setSetting('cash', Math.round(cash))
  logFinance(day, '贷款', amount, `取得分期贷款 #${r.lastInsertRowid}：${periods} 期 · 每期 ${Math.round(rate * 1000) / 10}% · 月供 ¥${installment.toLocaleString()}`)
  res.json({ ok: true, id: Number(r.lastInsertRowid), installment, periods, ratePct: Math.round(rate * 1000) / 10, loan: loanDebt() })
})

// 提前结清单笔贷款：仅收取剩余本金与已产生的逾期利息/罚息，豁免未到期利息
app.post('/api/loans/:id/repay', (req, res) => {
  const id = num(req.params.id)
  const l = db.prepare("SELECT * FROM loans WHERE id=? AND status='active'").get(id)
  if (!l) return res.status(404).json({ ok: false, msg: '贷款不存在或已结清' })
  const need = l.remain_principal + l.arrears_i
  const cash = state.cash()
  if (cash < need) return res.status(400).json({ ok: false, msg: `资金不足，结清需 ¥${need.toLocaleString()}` })
  const day = state.day()
  if (l.arrears_i > 0) logFinance(day, '利息', -l.arrears_i, `贷款 #${l.id} 结清逾期利息/罚息`)
  logFinance(day, '贷款', -l.remain_principal, `提前结清贷款 #${l.id} 本金`)
  setSetting('cash', Math.round(cash - need))
  db.prepare("UPDATE loans SET remain_principal=0, arrears_p=0, arrears_i=0, status='done' WHERE id=?").run(l.id)
  res.json({ ok: true, loan: loanDebt() })
})

// ---- 活动与事件 ----
app.post('/api/events', (req, res) => {
  const b = req.body || {}
  let cash = state.cash()
  const budget = num(b.budget, 8000)
  if (cash < budget) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= budget
  setSetting('cash', Math.round(cash))
  const impact = b.type === '烟火' || b.type === '花车巡游' ? 2 : 1
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), state.day(), b.type, b.title || `${b.type}活动`, b.desc || '策划的园区活动', impact, 'active')
  logFinance(state.day(), '活动', -budget, `举办 ${b.title || '活动'}`)
  res.json({ ok: true })
})

app.post('/api/events/:id/resolve', (req, res) => {
  const id = num(req.params.id)
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(id)
  if (!ev) return res.status(404).json({ ok: false })
  db.prepare("UPDATE events SET status='resolved', feedback=? WHERE id=?").run('通过决策处理', id)
  // 处理得当可挽回部分声誉损失
  if (ev.impact < 0) {
    let rep = state.reputation() + Math.abs(ev.impact) * 5
    setSetting('reputation', Math.max(5, Math.min(100, rep)))
  }
  res.json({ ok: true })
})

// ---- 游客投诉与服务补救 ----
app.get('/api/complaints', (req, res) => {
  const rows = db.prepare('SELECT * FROM complaints ORDER BY id DESC LIMIT 120').all()
  res.json({ list: enrichComplaints(rows), stats: complaintStats() })
})

// 前台登记游客反馈（手动建单）
app.post('/api/complaints', (req, res) => {
  const b = req.body || {}
  const category = COMPLAINT_CATS[b.category] ? b.category : 'service'
  const severity = Math.max(1, Math.min(3, Math.round(num(b.severity, 1))))
  const content = String(b.content || '').trim()
  if (!content) return res.status(400).json({ ok: false, msg: '请填写游客反馈内容' })
  if (content.length > 200) return res.status(400).json({ ok: false, msg: '反馈内容请控制在 200 字以内' })
  let target = { type: '', id: null, name: '' }
  if (b.target_type === 'ride') { const r = allRides().find(x => x.id === num(b.target_id)); if (r) target = { type: 'ride', id: r.id, name: r.name } }
  else if (b.target_type === 'vendor') { const v = allVendors().find(x => x.id === num(b.target_id)); if (v) target = { type: 'vendor', id: v.id, name: v.name } }
  else if (b.target_type === 'zone') { const z = allZones().find(x => x.id === num(b.target_id)); if (z) target = { type: 'zone', id: z.id, name: z.name } }
  const title = `${COMPLAINT_CATS[category].name}投诉 · ${target.name || '园区整体'}`
  const r = createComplaint({ category, severity, title, content, target, source: 'manual' })
  res.json({ ok: true, ...r })
})

// 指派员工受理（员工处理：技能/满意度/岗位匹配决定处置速度与结案评价）
app.post('/api/complaints/:id/assign', (req, res) => {
  const id = num(req.params.id)
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c || !OPEN_COMPLAINT_STATUSES.includes(c.status)) return res.status(400).json({ ok: false, msg: '投诉不存在或已结案' })
  const st = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(num(req.body?.staff_id))
  if (!st) return res.status(400).json({ ok: false, msg: '员工不存在或已离岗' })
  db.prepare("UPDATE complaints SET status='processing', assignee_id=? WHERE id=?").run(st.id, id)
  logComplaint(id, 'assign', `指派 ${st.name}（${st.role}）受理`, st.id)
  res.json({ ok: true })
})

// 升级投诉：严重度 +1，时限按新等级重置，需更高技能员工接手
app.post('/api/complaints/:id/escalate', (req, res) => {
  const id = num(req.params.id)
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c || !OPEN_COMPLAINT_STATUSES.includes(c.status)) return res.status(400).json({ ok: false, msg: '投诉不存在或已结案' })
  if (c.severity >= 3) return res.status(400).json({ ok: false, msg: '已是最高等级，无法继续升级' })
  const sev = c.severity + 1
  db.prepare('UPDATE complaints SET severity=?, escalated=1, escalations=escalations+1, deadline_tick=? WHERE id=?')
    .run(sev, state.tick() + SEV_SLA[sev], id)
  logComplaint(id, 'escalate', `管理层介入，投诉升级为「${SEV_NAMES[sev]}」，限时 ${SEV_SLA[sev]} 小时`)
  res.json({ ok: true })
})

// 确认补偿方案并结案（补偿记录 + 声誉/口碑/员工满意度回流）
app.post('/api/complaints/:id/resolve', (req, res) => {
  const id = num(req.params.id)
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id)
  if (!c) return res.status(404).json({ ok: false, msg: '投诉不存在' })
  if (c.status !== 'ready') return res.status(400).json({ ok: false, msg: '需先指派员工完成现场处置，才能确认补偿' })
  const comp = COMP_OPTIONS[req.body?.compensation] ? req.body.compensation : 'apology'
  res.json(doResolveComplaint(id, comp))
})

// 不予补偿直接结案：游客不满，扣减声誉与口碑
app.post('/api/complaints/:id/close', (req, res) => {
  res.json(forceCloseComplaint(num(req.params.id)))
})

// 单条投诉详情 + 处理时间线
app.get('/api/complaints/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(num(req.params.id))
  if (!c) return res.status(404).json({ ok: false })
  const logs = db.prepare('SELECT * FROM complaint_logs WHERE complaint_id=? ORDER BY id').all(c.id)
  res.json({ complaint: enrichComplaints([c])[0], logs })
})

// ---- 设施检修工单 ----
// 工单列表（默认全部，可按状态过滤）
app.get('/api/maintenance', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listMaintenanceOrders({ status: q.status || null, limit: 200 }),
    stats: maintenanceStats()
  })
})

// 工单详情 + 处理时间线
app.get('/api/maintenance/:id', (req, res) => {
  const detail = maintenanceOrderDetail(num(req.params.id))
  if (!detail) return res.status(404).json({ ok: false })
  res.json(detail)
})

// 接单 / 转派（仅在岗维修员工，每人同时只接一个在修工单）
app.post('/api/maintenance/:id/assign', (req, res) => {
  const r = assignMaintenanceOrder(num(req.params.id), num(req.body?.staff_id))
  res.status(r.ok ? 200 : 400).json(r)
})

// 撤销排队中（未接单）的工单，设施恢复运营
app.post('/api/maintenance/:id/cancel', (req, res) => {
  const r = cancelMaintenanceOrder(num(req.params.id))
  res.status(r.ok ? 200 : 400).json(r)
})

// ---- 分时预约：库存 / 下单 / 改签 / 取消 / 核销 ----
// 查询时段库存（入园 entry / 设施 ride），可按日期与设施过滤
app.get('/api/reservation-slots', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listSlots({
      scope: q.scope === 'ride' ? 'ride' : 'entry',
      rideId: q.rideId ? num(q.rideId) : null,
      day: q.day ? num(q.day) : null
    }),
    stats: reservationStats()
  })
})

// 运营调度：调整时段容量 / 超售额度 / 开关时段
app.post('/api/reservation-slots/:id', (req, res) => {
  const r = updateSlot(num(req.params.id), req.body || {})
  res.json(r)
})

// 预约列表（可按状态/类型/日期过滤）
app.get('/api/reservations', (req, res) => {
  const q = req.query || {}
  res.json({
    list: listReservations({
      status: q.status || null,
      scope: q.scope || null,
      day: q.day ? num(q.day) : null
    }),
    stats: reservationStats()
  })
})

// 游客下单：按日期 + 时段预约入园或设施
app.post('/api/reservations', (req, res) => {
  const b = req.body || {}
  const scope = b.scope === 'ride' ? 'ride' : 'entry'
  const r = createReservation({
    scope,
    rideId: num(b.ride_id),
    slotId: num(b.slot_id),
    qty: num(b.qty, 1),
    guest_name: String(b.guest_name || '').trim(),
    guest_phone: String(b.guest_phone || '').trim(),
    source: b.source === 'manual' ? 'manual' : 'guest'
  })
  res.status(r.ok ? 200 : 400).json(r)
})

// 改签：目标时段有余量才可改，库存原子转移
app.post('/api/reservations/:id/reschedule', (req, res) => {
  res.json(rescheduleReservation(num(req.params.id), num(req.body?.slot_id)))
})

// 取消：未开始全额退，当日取消退 50%，时段已过不可取消
app.post('/api/reservations/:id/cancel', (req, res) => {
  res.json(cancelReservation(num(req.params.id)))
})

// 闸机 / 设施口扫码核销
app.post('/api/reservations/:id/checkin', (req, res) => {
  res.json(checkinReservation(num(req.params.id)))
})

// 预约详情时间线
app.get('/api/reservations/:id', (req, res) => {
  const id = num(req.params.id)
  const list = listReservations({ limit: 5000 }).filter(x => x.id === id)
  if (!list.length) return res.status(404).json({ ok: false })
  res.json({ reservation: list[0], logs: reservationLogs(id) })
})

app.listen(PORT, () => console.log(`[PARK] API running at http://localhost:${PORT}`))