import crypto from 'node:crypto'
import db, { getSetting } from './db.js'
import { ApiError, newTraceId } from './errors.js'

// 幂等中间件：为写接口提供「同一请求只生效一次」的保证。
// - 客户端携带 Idempotency-Key 请求头或 body.idempotency_key（前端对每次用户点击生成 UUID）；
// - 首次请求落库（method+path+body 指纹 + 成功响应），网络重试/双击直接重放首次响应；
// - 同一 key 但请求体不同 → 409 冲突，防止键被误复用；
// - 同 key 并发进行中的第二个请求 → 等待重放（串行引擎下防御异步并发/重入）。
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/
const inFlight = new Map()   // key -> Promise

function bodyFingerprint(method, path, body) {
  const payload = { ...(body || {}) }
  delete payload.idempotency_key
  return crypto.createHash('sha256')
    .update(`${method} ${path} ${JSON.stringify(payload, Object.keys(payload).sort())}`)
    .digest('hex')
}

const lookup = db.prepare('SELECT * FROM idempotency_keys WHERE key=?')
const insertRec = db.prepare(`INSERT INTO idempotency_keys(key,scope,method,path,fingerprint,status_code,response,created_tick,created_day)
                              VALUES(?,?,?,?,?,?,?,?,?)`)

export function idempotent(scope = 'reservation') {
  return (req, res, next) => {
    try {
      const key = req.get('Idempotency-Key') || req.body?.idempotency_key
      if (!key || !KEY_RE.test(String(key))) {
        throw new ApiError('RSV_IDEMPOTENCY_REQUIRED', '缺少合法的幂等请求标识（Idempotency-Key）')
      }
      const idemKey = String(key)
      const fp = bodyFingerprint(req.method, req.path, req.body)

      // 1) 已有成功记录：原样重放
      const rec = lookup.get(idemKey)
      if (rec) {
        if (rec.fingerprint !== fp) {
          throw new ApiError('RSV_IDEMPOTENCY_CONFLICT',
            '该请求编号已用于其他内容的操作，请勿重复使用编号', { details: { reused_key: idemKey } })
        }
        let payload
        try { payload = JSON.parse(rec.response) } catch { payload = { ok: true } }
        payload.replayed = true
        payload.trace_id = payload.trace_id || newTraceId()
        return res.status(rec.status_code).json(payload)
      }

      // 2) 并发同键：等待首个请求落库后重放；首个失败未落库则放行重试
      const pending = inFlight.get(idemKey)
      if (pending) {
        return pending.then(() => {
          try {
            const r2 = lookup.get(idemKey)
            if (r2) {
              const payload = JSON.parse(r2.response)
              payload.replayed = true
              return res.status(r2.status_code).json(payload)
            }
            next()
          } catch (e) { next(e) }
        }).catch(() => next())
      }

      // 3) 首次请求：拦截 res.json 记录成功响应（仅 2xx 落库，业务/系统失败允许同键重试）
      req.idempotencyKey = idemKey
      const origJson = res.json.bind(res)
      let settle
      const done = new Promise(r => { settle = r })
      inFlight.set(idemKey, done)

      res.json = (payload) => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            insertRec.run(
              idemKey, scope, req.method, req.path, fp,
              res.statusCode, JSON.stringify(payload ?? {}),
              Number(getSetting('tick') || 0), Number(getSetting('day') || 1)
            )
          }
        } catch (e) {
          // 唯一键竞争：另一并发请求已落库，忽略写入（语义等价）；其他错误向上抛
          if (!String(e.message).includes('UNIQUE') && !String(e.message).includes('constraint')) throw e
        } finally {
          inFlight.delete(idemKey)
          settle()
        }
        return origJson(payload)
      }
      next()
    } catch (e) {
      next(e)
    }
  }
}
