import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, 'park.db')

const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  theme TEXT NOT NULL,           -- 奇幻/冒险/水上/未来/儿童
  unlocked INTEGER NOT NULL DEFAULT 1,
  capacity INTEGER NOT NULL DEFAULT 200,
  cleanliness INTEGER NOT NULL DEFAULT 80,  -- 清洁度 0-100
  scenery INTEGER NOT NULL DEFAULT 60,      -- 景观值 0-100
  open INTEGER NOT NULL DEFAULT 1,
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 过山车/旋转木马/摩天轮/跳楼机/水上漂流/碰碰车/海盗船/云霄飞车
  zone_id INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'operating', -- operating/maintenance/closed
  capacity INTEGER NOT NULL DEFAULT 20,     -- 单轮载客
  cycle_min REAL NOT NULL DEFAULT 5,        -- 运行周期(游戏分钟)
  build_cost INTEGER NOT NULL DEFAULT 5000,
  run_cost INTEGER NOT NULL DEFAULT 60,     -- 每施工时段运行成本
  thrill INTEGER NOT NULL DEFAULT 50,       -- 刺激度
  attr REAL NOT NULL DEFAULT 60,            -- 游客吸引度
  health REAL NOT NULL DEFAULT 100,         -- 健康度 0-100
  queue INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 30,
  play_count INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,           -- 累计收入
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 餐饮/纪念品/饮品
  zone_id INTEGER NOT NULL DEFAULT 1,
  rent INTEGER NOT NULL DEFAULT 800,
  margin REAL NOT NULL DEFAULT 0.6,
  price INTEGER NOT NULL DEFAULT 25,
  sold INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  staff_id INTEGER,
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- 保安/保洁/维修/员工管理员
  zone_id INTEGER NOT NULL DEFAULT 1,
  wage INTEGER NOT NULL DEFAULT 300,
  skill INTEGER NOT NULL DEFAULT 1,
  morale INTEGER NOT NULL DEFAULT 80,      -- 满意度 0-100
  active INTEGER NOT NULL DEFAULT 1,
  assigned_ride_id INTEGER
);

CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,        -- 该时段入园人数
  satisfaction REAL NOT NULL DEFAULT 70,
  eat REAL NOT NULL DEFAULT 40,  -- 人均消费期望
  total_spend INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  label TEXT NOT NULL,           -- 门票/游乐/餐饮/纪念品/工资/租金/运营/消费/建设/升级/扩建/活动/贷款/利息
  amount INTEGER NOT NULL,       -- 正负(贷款正数=放款/本金返还，负数=偿还本金；利息负数=付息/罚息)
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal INTEGER NOT NULL,        -- 借款本金
  rate REAL NOT NULL,                -- 每期(每日)利率
  periods INTEGER NOT NULL,          -- 总期数(天)
  installment INTEGER NOT NULL,      -- 每期等额本息应还
  remain_principal INTEGER NOT NULL, -- 剩余本金(含已到期未还的本金)
  paid_periods INTEGER NOT NULL DEFAULT 0,
  arrears_p INTEGER NOT NULL DEFAULT 0, -- 逾期挂账本金
  arrears_i INTEGER NOT NULL DEFAULT 0, -- 逾期挂账利息(含罚息)
  overdue_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active/done
  start_day INTEGER NOT NULL,
  created_tick INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  impact INTEGER NOT NULL DEFAULT 0,  -- 影响力影响声誉/客流
  status TEXT NOT NULL DEFAULT 'active', -- active/resolved
  feedback TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',             -- 投诉单号 TS0001
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  category TEXT NOT NULL,                    -- queue/hygiene/facility/safety/food/service/pricing/missing
  severity INTEGER NOT NULL DEFAULT 1,       -- 1 一般 / 2 严重 / 3 紧急
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',      -- ride/vendor/zone
  target_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',       -- open/processing/ready/closed_resolved/closed_force/closed_timeout
  assignee_id INTEGER,                       -- 受理员工
  progress REAL NOT NULL DEFAULT 0,          -- 处置进度 0-100
  deadline_tick INTEGER NOT NULL,            -- 限时处置截止时刻(tick=游戏小时)
  escalated INTEGER NOT NULL DEFAULT 0,      -- 是否经历过升级
  escalations INTEGER NOT NULL DEFAULT 0,
  compensation TEXT NOT NULL DEFAULT '',     -- apology/ticket/fastpass/voucher/cash
  comp_cost INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0,         -- 游客结案评价 1-5
  close_reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'guest',      -- guest 游客自发 / manual 前台登记
  resolved_tick INTEGER NOT NULL DEFAULT 0,  -- 现场处置完成(待确认补偿)时刻
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS complaint_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,                      -- submit/assign/ready/resolve/escalate/auto_escalate/unassign/force/timeout
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaint_logs_cid ON complaint_logs(complaint_id);

-- 分时预约库存：scope=entry 为入园时段（ride_id 恒 NULL），scope=ride 为设施分时时段
CREATE TABLE IF NOT EXISTS reservation_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                 -- entry / ride
  ride_id INTEGER,                     -- entry 时段为 NULL
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  capacity INTEGER NOT NULL,           -- 时段容量（运营可调）
  oversell INTEGER NOT NULL DEFAULT 0, -- 超售余量（爽约率对冲，运营可调）
  booked_count INTEGER NOT NULL DEFAULT 0,
  checked_count INTEGER NOT NULL DEFAULT 0,
  noshow_count INTEGER NOT NULL DEFAULT 0,
  refund_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'  -- open / closed
);
-- NULL 在 UNIQUE 中互不相等，entry/ride 各建部分唯一索引保证同一时段只有一条库存
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_entry ON reservation_slots(day,hour) WHERE scope='entry';
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_ride ON reservation_slots(ride_id,day,hour) WHERE scope='ride';

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',        -- 预约号 YY0001
  guest_name TEXT NOT NULL DEFAULT '游客',
  guest_phone TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,                  -- entry / ride
  ride_id INTEGER,
  slot_id INTEGER,
  slot_day INTEGER NOT NULL,
  slot_hour INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,       -- 人数
  amount INTEGER NOT NULL DEFAULT 0,   -- 预收款（下单时即收取，现金制）
  status TEXT NOT NULL DEFAULT 'booked',-- booked/checked/noshow/refunded/refunded_half
  reason TEXT NOT NULL DEFAULT '',      -- guest/late/park/overbook/noshow
  source TEXT NOT NULL DEFAULT 'guest', -- guest 游客端 / auto 模拟客流 / manual 前台
  reschedules INTEGER NOT NULL DEFAULT 0,
  created_tick INTEGER NOT NULL,
  created_day INTEGER NOT NULL,
  checked_tick INTEGER NOT NULL DEFAULT 0,
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reservations_slot ON reservations(slot_day,slot_hour,status);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);

CREATE TABLE IF NOT EXISTS reservation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,  -- create/auto_book/checkin/reschedule/auto_reschedule/noshow/cancel/refund/split
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reservation_logs_rid ON reservation_logs(reservation_id);

-- 设施检修工单：报修后进入排队，维修员工接单后按游戏时间推进，支持转派与离岗接续
CREATE TABLE IF NOT EXISTS maintenance_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- 工单号 WX0001
  ride_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued 排队待接单 / processing 检修中 / done 已完工 / cancelled 已撤销
  source TEXT NOT NULL DEFAULT 'manual',   -- manual 人工报修 / auto 故障自动停运 / system 兼容既有检修状态补建
  assignee_id INTEGER,                     -- 接单维修员工
  progress REAL NOT NULL DEFAULT 0,        -- 检修进度 0-100，按游戏小时推进
  cost INTEGER NOT NULL DEFAULT 0,         -- 检修费用（报修时按健康度核定，完工结算入账）
  create_tick INTEGER NOT NULL,
  create_day INTEGER NOT NULL,
  start_tick INTEGER NOT NULL DEFAULT 0,   -- 最近一次接单/转派到手时刻
  completed_tick INTEGER NOT NULL DEFAULT 0,
  completed_day INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_maint_ride ON maintenance_orders(ride_id);
CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_orders(status);
CREATE INDEX IF NOT EXISTS idx_maint_assignee ON maintenance_orders(assignee_id);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,                    -- create/assign/transfer/release/complete/cancel
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_maint_logs_oid ON maintenance_logs(order_id);
`)

const now = () => new Date().toISOString()

// ---------- 种子数据 ----------
const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k)
  return r ? r.value : d
}
const setSetting = (k, v) => {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v))
}

function seed() {
  const c = db.prepare('SELECT COUNT(*) n FROM zones').get().n
  if (c > 0) return

  // 初始经营参数
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('ticket', 120)
  setSetting('reputation', 70)
  setSetting('cash', 200000)
  setSetting('guestBase', 600)
  setSetting('wordOfMouth', 0)   // 投诉补救口碑 -10 ~ +10，回流影响客流与满意度

  const iz = db.prepare('INSERT INTO zones(name,theme,unlocked,capacity,cleanliness,scenery,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
  const zones = [
    ['奇幻山谷', '奇幻', 1, 300, 85, 70, 1, 1],
    ['冒险岛', '冒险', 1, 260, 70, 65, 3, 1],
    ['未来世界', '未来', 0, 220, 60, 55, 1, 3],
    ['水上乐园', '水上', 0, 250, 75, 60, 3, 3],
    ['儿童王国', '儿童', 1, 180, 90, 75, 1, 2],
    ['美食广场', '美食', 1, 150, 85, 60, 3, 2]
  ]
  zones.forEach(z => iz.run(...z))
  const zoneMap = { 奇幻山谷: 1, 冒险岛: 2, 未来世界: 3, 水上乐园: 4, 儿童王国: 5, 美食广场: 6 }

  const ir = db.prepare('INSERT INTO rides(name,type,zone_id,status,capacity,cycle_min,build_cost,run_cost,thrill,attr,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const rides = [
    ['极速飞车', '过山车', 2, 'operating', 32, 6, 60000, 260, 92, 88, 60, 2, 2],
    ['旋转木马', '旋转木马', 5, 'operating', 40, 4, 20000, 70, 15, 75, 20, 2, 3],
    ['摩天轮', '摩天轮', 1, 'operating', 24, 12, 45000, 150, 45, 85, 45, 1, 3],
    ['跳楼机', '跳楼机', 2, 'operating', 20, 8, 35000, 130, 88, 80, 55, 3, 2],
    ['碰碰车', '碰碰车', 5, 'operating', 12, 5, 26000, 95, 60, 82, 35, 3, 3],
    ['海盗船', '海盗船', 2, 'operating', 30, 7, 38000, 140, 78, 84, 50, 4, 1],
    ['激流勇进', '水上漂流', 2, 'operating', 28, 9, 42000, 160, 82, 86, 55, 4, 2]
  ]
  rides.forEach(r => ir.run(...r))

  const iv = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
  const vendors = [
    ['爆米花小屋', '餐饮', 1, 900, 0.65, 28, 1, 4],
    ['纪念品旗舰店', '纪念品', 1, 1200, 0.7, 55, 1, 5],
    ['冰爽柠檬饮', '饮品', 5, 600, 0.72, 18, 2, 4],
    ['热狗快餐厅', '餐饮', 6, 1000, 0.62, 32, 4, 3],
    ['玩具总动员', '纪念品', 5, 900, 0.68, 45, 4, 4]
  ]
  vendors.forEach(v => iv.run(...v))

  const is = db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,assigned_ride_id) VALUES(?,?,?,?,?,?,?)')
  const staff = [
    ['张伟', '保安', 1, 320, 1, 85, null],
    ['李娜', '保洁', 1, 300, 1, 88, null],
    ['王强', '维修', 2, 380, 2, 78, 1],
    ['赵敏', '维修', 2, 360, 1, 80, 2],
    ['陈杰', '安保', 3, 320, 1, 82, null],
    ['刘洋', '保洁', 3, 300, 1, 79, null]
  ]
  staff.forEach(s => is.run(...s))

  // 启动期财务记录（昨日）
  const nf = new Date().toISOString()
  const parseFinance = `INSERT OR IGNORE INTO settings(key,value) VALUES('seed_finance','1')`
  const f = db.prepare('INSERT INTO finance(tick,day,label,amount,detail) VALUES(?,?,?,?,?)')
  const pre = db.prepare('SELECT COUNT(*) n FROM finance').get().n
  if (pre === 0) {
    f.run(0, 0, '门票', 72000, '昨日门票收入')
    f.run(0, 0, '游乐', 48000, '昨日游乐设施收入')
    f.run(0, 0, '餐饮', 18000, '昨日餐饮收入')
    f.run(0, 0, '纪念品', 15000, '昨日纪念品收入')
    f.run(0, 0, '工资', -26000, '昨日工资支出')
    f.run(0, 0, '维护', -9000, '昨日设施维护')
  }
}
seed()

export default db
export { now, getSetting, setSetting }