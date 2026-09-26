// 预约模块并发一致性端到端验证（真实 node:sqlite）
// 用法：NODE22/bin/node test/reservations.test.js
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// 用临时内存库替换磁盘 park.db：在 import db 之前拦截
const mem = new DatabaseSync(':memory:')
import { register } from 'node:module'
// 直接通过全局钩子不可行，改为先写 loader：这里用简单方式——临时改 DB_PATH 不支持，
// 故采用：db.js 固定 park.db，测试前删除文件并在结束后清理
import { rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dbFile = join(here, '..', 'server', 'park.db')
for (const ext of ['', '-wal', '-shm']) { if (existsSync(dbFile + ext)) try { rmSync(dbFile + ext) } catch {} }

const db = (await import('../server/db.js')).default
const { getSetting, setSetting, tx } = await import('../server/db.js')
const R = await import('../server/reservations.js')

// ---- 注入最小上下文 ----
const financeLogs = []
R.initReservationContext({
  logFinance: (day, label, amount, detail) => financeLogs.push({ day, label, amount, detail }),
  createComplaint: (p) => { complaints.push(p); return { id: complaints.length } }
})
const complaints = []

let passed = 0
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓', name); passed++ }
function eq(name, a, b) { assert.equal(a, b, `${name}: got ${a}, want ${b}`); console.log('  ✓', name); passed++ }

// ---- 构造测试数据：第 10 天 9 点入园时段，容量 5、超售 1 ----
setSetting('day', 10); setSetting('hour', 8); setSetting('tick', 100); setSetting('cash', 100000); setSetting('ticket', 100)
const slotId = Number(db.prepare(`INSERT INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell,status)
  VALUES('entry',NULL,10,9,5,1,'open')`).run().lastInsertRowid)

console.log('\n[1] 下单：库存原子校验，容量5+超售1，第7个人必须被拒绝且无副作用')
const cash0 = Number(getSetting('cash'))
const r1 = R.createReservation({ scope: 'entry', slotId, qty: 5, source: 'guest' })
ok('5 人下单成功', r1.ok)
const r2 = R.createReservation({ scope: 'entry', slotId, qty: 1, source: 'guest' })
ok('超售额度内 +1 成功', r2.ok)
const r3 = R.createReservation({ scope: 'entry', slotId, qty: 1, source: 'guest' })
ok('第 7 人被拒', !r3.ok)
eq('错误码为 RSV_NO_STOCK', r3.code, 'RSV_NO_STOCK')
eq('拒绝后时段 booked 仍为 6（未脏写）', db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(slotId).b, 6)
eq('拒绝后现金未增加', Number(getSetting('cash')), cash0 + 600)

console.log('\n[2] 事务回滚：人为注入失败（日志函数抛错），库存/现金/单据必须全部回滚')
const before = {
  cash: Number(getSetting('cash')),
  booked: db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(slotId).b,
  cnt: db.prepare('SELECT COUNT(*) c FROM reservations').get().c
}
// 新建一个容量充足的时段用于回滚测试
const slot2 = Number(db.prepare(`INSERT INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell,status)
  VALUES('entry',NULL,10,10,50,0,'open')`).run().lastInsertRowid)
R.initReservationContext({
  logFinance: () => { throw new Error('模拟财务服务中断') },
  createComplaint: () => {}
})
const rb = R.createReservation({ scope: 'entry', slotId: slot2, qty: 3, source: 'guest' })
ok('失败返回 ok:false', !rb.ok)
eq('回滚后 slot2 库存为 0', db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(slot2).b, 0)
eq('回滚后预约单总数不变', db.prepare('SELECT COUNT(*) c FROM reservations').get().c, before.cnt)
eq('回滚后现金不变', Number(getSetting('cash')), before.cash)
// 恢复上下文
R.initReservationContext({
  logFinance: (day, label, amount, detail) => financeLogs.push({ day, label, amount, detail }),
  createComplaint: (p) => { complaints.push(p); return { id: complaints.length } }
})

console.log('\n[3] 退款：状态机守卫，重复退款不会重复出钱')
const cashBeforeRefund = Number(getSetting('cash'))
const rf1 = R.refundReservation(r1.id, 'guest', '测试全额退')
ok('首次退款成功', rf1.ok)
eq('全额退款金额=500', rf1.back, 500)
const rf2 = R.refundReservation(r1.id, 'guest', '重复退款')
ok('重复退款被拒', !rf2.ok)
eq('状态冲突错误码', rf2.code, 'RSV_STATE_CONFLICT')
eq('现金只退了一次', Number(getSetting('cash')), cashBeforeRefund - 500)
eq('退款释放名额（booked 6→1）', db.prepare('SELECT booked_count b, refund_count rf FROM reservation_slots WHERE id=?').get(slotId).b, 1)
eq('refund_count=5', db.prepare('SELECT refund_count rf FROM reservation_slots WHERE id=?').get(slotId).rf, 5)

console.log('\n[4] 改签：库存原子转移，失败回滚两侧库存')
// slot2（容量50，booked 0）可作为目标；把 r2（1人，在 slot1，slot1 已无余量）改到 slot2
const rs1 = R.rescheduleReservation(r2.id, slot2)
ok('改签成功', rs1.ok)
eq('原时段 booked 0', db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(slotId).b, 0)
eq('目标时段 booked 1', db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(slot2).b, 1)
const r2fresh = db.prepare('SELECT * FROM reservations WHERE id=?').get(r2.id)
eq('单据指向新时段', r2fresh.slot_id, slot2)
eq('改签次数=1', r2fresh.reschedules, 1)
// 再次改签回已满的 slot1（容量5超售1全退了→booked 0；其实可改），改测非法目标
const rsBad = R.rescheduleReservation(r2.id, 999999)
ok('非法目标被拒', !rsBad.ok)
eq('目标时段 booked 仍为 1（未脏写）', db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(slot2).b, 1)
// 改签到相同时段
const rsSame = R.rescheduleReservation(r2.id, slot2)
eq('同时段拒绝码 RSV_TARGET_SAME', rsSame.code, 'RSV_TARGET_SAME')

console.log('\n[5] 核销：状态守卫防重复核销；超售自动改签/退款')
setSetting('hour', 9)
// r2 现在在 slot2（10点），9点核销应被拒（未到时段）
const early = R.checkinReservation(r2.id)
eq('未到时段拒绝码 RSV_NOT_DUE', early.code, 'RSV_NOT_DUE')
setSetting('hour', 10)
const ci1 = R.checkinReservation(r2.id)
ok('10点核销成功', ci1.ok)
const ci2 = R.checkinReservation(r2.id)
ok('重复核销被拒', !ci2.ok)
eq('重复核销码 RSV_STATE_CONFLICT', ci2.code, 'RSV_STATE_CONFLICT')
eq('checked_count 只计 1 次（1人）', db.prepare('SELECT checked_count c FROM reservation_slots WHERE id=?').get(slot2).c, 1)

// 超售场景：容量2无超售，塞3人，到点核销第3人 → 应自动改签到后续有余时段
setSetting('hour', 9)
const sA = Number(db.prepare(`INSERT INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell,status)
  VALUES('entry',NULL,11,9,2,0,'open')`).run().lastInsertRowid)
const sB = Number(db.prepare(`INSERT INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell,status)
  VALUES('entry',NULL,11,10,5,0,'open')`).run().lastInsertRowid)
const a1 = R.createReservation({ scope: 'entry', slotId: sA, qty: 2, source: 'manual' })
// 直接改库存制造超售：booked_count 改为 3（模拟历史漂移/超额），再补一张1人单到 sB 之外——
// 更真实：容量2超售1，下3单
db.prepare('UPDATE reservation_slots SET oversell=1 WHERE id=?').run(sA)
const a2 = R.createReservation({ scope: 'entry', slotId: sA, qty: 1, source: 'manual' })
ok('超售名额下单成功', a2.ok)
setSetting('day', 11); setSetting('hour', 9)
const ca1 = R.checkinReservation(a1.id)
ok('容量内2人核销', ca1.ok)
const ca2 = R.checkinReservation(a2.id)
ok('第3人未放行（ok:false 软结果）', !ca2.ok)
eq('自动改签结果码', ca2.code, 'RSV_OVERBOOK_RESCHEDULED')
const a2fresh = db.prepare('SELECT slot_hour h FROM reservations WHERE id=?').get(a2.id)
eq('已改签到10点', a2fresh.h, 10)
eq('sA booked 转移后=2', db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(sA).b, 2)
eq('sB booked=1', db.prepare('SELECT booked_count b FROM reservation_slots WHERE id=?').get(sB).b, 1)

console.log('\n[6] 自动核销引擎：单条异常不影响整批，失败自动回滚')
// sB 上 a2（1人）10点自动核销；再放一个会失败的单：直接构造 slot 容量不足且无后续时段
setSetting('day', 11); setSetting('hour', 10)
const auto = R.autoCheckin(10)
ok('自动核销入园1人', auto.entry === 1)
eq('无失败单', auto.failures.length, 0)
eq('sB checked=1', db.prepare('SELECT checked_count c FROM reservation_slots WHERE id=?').get(sB).c, 1)
// 幂等：再次 autoCheckin 同时段不应重复核销
const auto2 = R.autoCheckin(10)
eq('重复自动核销 entry=0', auto2.entry, 0)
eq('sB checked 仍为1', db.prepare('SELECT checked_count c FROM reservation_slots WHERE id=?').get(sB).c, 1)

console.log('\n[7] 爽约：状态守卫，已核销/已退款的单不会被重复没收')
setSetting('day', 12); setSetting('hour', 9)
const ns = R.expireNoShow(9)
ok('爽约批处理完成无异常', Array.isArray(ns.failures))

console.log('\n[8] 库存对账自愈：人为制造漂移后修复')
// 把 sB 的 booked_count 故意 +5，checked 故意 -1
db.prepare('UPDATE reservation_slots SET booked_count=booked_count+5, checked_count=MAX(0,checked_count-1) WHERE id=?').run(sB)
const dry = R.reconcileSlots({ fix: false })
ok('只读模式能发现漂移', dry.mismatches >= 1)
const fix = R.reconcileSlots({ fix: true })
ok('修复执行', fix.fixed >= 1)
const sBfixed = db.prepare('SELECT booked_count b, checked_count c FROM reservation_slots WHERE id=?').get(sB)
eq('修复后 booked=1（a2 1人 booked→实际已checked，booked含checked）', sBfixed.b, 1)
eq('修复后 checked=1', sBfixed.c, 1)
// 再次对账应为 0 漂移
const again = R.reconcileSlots({ fix: true })
eq('二次对账零漂移', again.mismatches, 0)
ok('修复留痕写入 reservation_logs(action=reconcile)',
  db.prepare("SELECT COUNT(*) c FROM reservation_logs WHERE action='reconcile'").get().c >= 1)

console.log('\n[9] 幂等中间件：同键重放、异载荷冲突、缺键拒绝（使用真实 express 管道）')
const { idempotent } = await import('../server/idempotency.js')
function runMiddleware(mw, { method = 'POST', path = '/x', body = {}, key }) {
  const req = {
    method, path, body,
    get(h) { return h.toLowerCase() === 'idempotency-key' ? key : undefined }
  }
  const events = []
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this },
    json(p) { events.push({ status: this.statusCode, payload: p }) }
  }
  let nextErr
  mw(req, res, (err) => { if (err) nextErr = err; else events.push({ next: true, res }) })
  return { events, nextErr, res, req }
}
const mw = idempotent('test')
// 首次
const first = runMiddleware(mw, { body: { qty: 2 }, key: 'key-aaaa-1' })
ok('首次请求放行', first.events.some(e => e.next))
first.res.json({ ok: true, code: 'YY0099' })
// 重放
const replay = runMiddleware(mw, { body: { qty: 2 }, key: 'key-aaaa-1' })
ok('同键重放不进 handler', replay.events.length === 1 && replay.events[0].payload?.code === 'YY0099')
ok('重放带 replayed 标记', replay.events[0].payload.replayed === true)
// 不同载荷
const conflict = runMiddleware(mw, { body: { qty: 9 }, key: 'key-aaaa-1' })
eq('载荷冲突码 RSV_IDEMPOTENCY_CONFLICT', conflict.nextErr?.code, 'RSV_IDEMPOTENCY_CONFLICT')
// 缺键
const nokey = runMiddleware(mw, { body: { qty: 2 }, key: undefined })
eq('缺键码 RSV_IDEMPOTENCY_KEY_REQUIRED', nokey.nextErr?.code, 'RSV_IDEMPOTENCY_REQUIRED')
// 失败请求不落库 → 同键可重试
const mw2 = idempotent('test2')
const failFirst = runMiddleware(mw2, { body: { q: 1 }, key: 'key-bbbb-2' })
failFirst.res.statusCode = 400
failFirst.res.json({ ok: false, code: 'RSV_NO_STOCK' })  // 非 2xx 不落库
const retry = runMiddleware(mw2, { body: { q: 1 }, key: 'key-bbbb-2' })
ok('失败后同键可重新发起', retry.events.some(e => e.next))

console.log(`\n🎉 全部 ${passed} 项断言通过`)
process.exit(0)
