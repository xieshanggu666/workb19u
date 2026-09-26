// HTTP 端到端：启动真实 express 服务，验证四接口的幂等头/错误码/trace_id
import { spawn } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const dbFile = join(here, '..', 'server', 'park.db')
for (const ext of ['', '-wal', '-shm']) { if (existsSync(dbFile + ext)) try { rmSync(dbFile + ext) } catch {} }

const srv = spawn(join('/tmp/node-v22.14.0-linux-arm64/bin/node'),
  ['--no-warnings', join(here, '..', 'server', 'index.js')], { stdio: ['ignore', 'pipe', 'pipe'] })

let bootLog = ''
srv.stdout.on('data', d => { bootLog += d })
srv.stderr.on('data', d => { bootLog += d })
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server boot timeout: ' + bootLog)), 8000)
  const iv = setInterval(() => { if (bootLog.includes('API running')) { clearTimeout(t); clearInterval(iv); res() } }, 100)
})

const BASE = 'http://localhost:4150'
let passed = 0
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓', n); passed++ }
const eq = (n, a, b) => { assert.equal(a, b, `${n}: ${a} !== ${b}`); console.log('  ✓', n); passed++ }

async function call(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['Idempotency-Key'] = key
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, json }
}

try {
  console.log('\n[A] 取一个可约时段')
  const state = await (await fetch(BASE + '/api/state')).json()
  const slot = state.entrySlots.find(s => s.day === state.clock.day + 1)
  ok('存在明日时段', !!slot)

  console.log('\n[B] 缺幂等键 → 400 + 结构化错误体（code/trace_id/hint）')
  const noKey = await call('POST', '/api/reservations', { scope: 'entry', slot_id: slot.id, qty: 1 })
  eq('HTTP 400', noKey.status, 400)
  eq('错误码', noKey.json.code, 'RSV_IDEMPOTENCY_REQUIRED')
  ok('带 trace_id', /^RSV-/.test(noKey.json.trace_id))
  ok('带用户提示 hint', !!noKey.json.hint)

  console.log('\n[C] 同一幂等键双击下单：只生效一次，第二次重放且金额/库存一致')
  const key = 'book-' + Math.random().toString(36).slice(2, 10)
  const payload = { scope: 'entry', slot_id: slot.id, qty: 2 }
  const [c1, c2] = await Promise.all([
    call('POST', '/api/reservations', payload, key),
    call('POST', '/api/reservations', payload, key)
  ])
  ok('首次 200', c1.status === 200 && c1.json.ok)
  const firstCode = c1.json.code
  const replay = c1.json.replayed ? c1 : c2
  const fresh = c1.json.replayed ? c2 : c1
  ok('其中一次为重放', replay.json.replayed === true)
  eq('重放返回同一预约号', replay.json.code, firstCode)
  eq('重放 HTTP 200', replay.status, 200)

  const st2 = await (await fetch(BASE + '/api/state')).json()
  const slotAfter = st2.entrySlots.find(s => s.id === slot.id)
  eq('库存只扣了一次（+2，非 +4）', slotAfter.booked_count, slot.booked_count + 2)

  console.log('\n[D] 同键不同载荷 → 409 冲突')
  const conf = await call('POST', '/api/reservations', { ...payload, qty: 5 }, key)
  eq('HTTP 409', conf.status, 409)
  eq('错误码', conf.json.code, 'RSV_IDEMPOTENCY_CONFLICT')
  ok('冲突响应带 trace_id', !!conf.json.trace_id)

  console.log('\n[E] 库存不足 → 409 RSV_NO_STOCK，失败不扣键（可换键重试其他时段）')
  // 找一个余量最小的可约时段，用多次 20 人订单打满，再下一单触发超卖
  const es = await (await fetch(BASE + '/api/reservation-slots?scope=entry')).json()
  const target0 = es.list
    .filter(s => s.status === 'open' && (s.day > state.clock.day || (s.day === state.clock.day && s.hour >= state.clock.hour)))
    .sort((a, b) => a.remain - b.remain)[0]
  let remainNow = target0.remain
  while (remainNow > 0) {
    const q = Math.min(20, remainNow)
    const b = await call('POST', '/api/reservations',
      { scope: 'entry', slot_id: target0.id, qty: q }, 'fill-' + Math.random().toString(36).slice(2))
    if (!b.json.ok) break
    remainNow -= q
  }
  const bigKey = 'big-' + Date.now()
  const big = await call('POST', '/api/reservations', { scope: 'entry', slot_id: target0.id, qty: 1 }, bigKey)
  eq('HTTP 409', big.status, 409)
  eq('错误码 RSV_NO_STOCK', big.json.code, 'RSV_NO_STOCK')
  ok('消息含剩余名额', big.json.msg.includes('余量') || big.json.msg.includes('约满'))
  // 同键同载荷此时应可再次请求（失败未落库）——会再次得到业务失败而非冲突
  const bigRetry = await call('POST', '/api/reservations', { scope: 'entry', slot_id: target0.id, qty: 1 }, bigKey)
  ok('失败后同键重试不被幂等层拦截', bigRetry.json.code === 'RSV_NO_STOCK')

  console.log('\n[F] 核销/取消/改签 均要求幂等键')
  const rid = fresh.json.id
  for (const [path, body] of [
    [`/api/reservations/${rid}/checkin`, {}],
    [`/api/reservations/${rid}/cancel`, {}],
  ]) {
    const r = await call('POST', path, body)
    eq(`${path} 缺键 400`, r.status, 400)
    ok('错误码正确', r.json.code === 'RSV_IDEMPOTENCY_REQUIRED')
  }

  console.log('\n[G] 重复核销幂等：同键重放，不同键第二次返回状态冲突（不重复放行）')
  // 先把预约改到当前时段以便核销：直接新建当日当前小时的单
  const curSlot = st2.entrySlots.find(s => s.day === st2.clock.day && s.hour === st2.clock.hour)
  // 找到一个当前可核销（开放有余量）的时段
  let target = curSlot
  if (!target || target.remain < 1 || target.status !== 'open') {
    target = st2.entrySlots.find(s => s.day === st2.clock.day && s.hour >= st2.clock.hour && s.remain > 0 && s.status === 'open')
  }
  if (target) {
    const bk = 'ci-' + Math.random().toString(36).slice(2)
    const b = await call('POST', '/api/reservations', { scope: 'entry', slot_id: target.id, qty: 1 }, bk)
    ok('下单成功用于核销', b.json.ok)
    const cid = b.json.id
    const ck = 'cik-' + Math.random().toString(36).slice(2)
    const [x1, x2] = await Promise.all([
      call('POST', `/api/reservations/${cid}/checkin`, {}, ck),
      call('POST', `/api/reservations/${cid}/checkin`, {}, ck)
    ])
    const reps = [x1, x2].filter(x => x.json.replayed)
    ok('同键双击其中一次重放', reps.length === 1)
    // 用新键再核销 → 状态冲突
    const dup = await call('POST', `/api/reservations/${cid}/checkin`, {}, 'new-' + Date.now())
    eq('重复新键核销返回 409', dup.status, 409)
    eq('状态冲突码', dup.json.code, 'RSV_STATE_CONFLICT')
  }

  console.log('\n[H] 对账接口可读取健康状态')
  const rec = await (await fetch(BASE + '/api/reservation-slots-reconcile?fix=0')).json()
  ok('对账返回扫描数', rec.checked > 0)
  eq('健康库零漂移', rec.mismatches, 0)

  console.log(`\n🎉 HTTP 端到端 ${passed} 项断言通过`)
} catch (e) {
  console.error('TEST FAILURE:', e)
  srv.kill(); process.exit(1)
}
srv.kill()
setTimeout(() => process.exit(0), 200)
