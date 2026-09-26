<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
onMounted(async () => {
  // 首次拉取设施时段库存（随后随 /state 轮询刷新入园库存）
  await loadRideSlots()
})
// 随全局 2s 轮询静默刷新设施时段，反映模拟下单/核销的实时变化
watch(() => store.clock.tick, () => { if (tab.value === 'guest' || tab.value === 'ops') loadRideSlots(true) })

const today = computed(() => store.clock.day)
const stats = computed(() => store.reservationStats)

// ---- 三个页签 ----
const tabs = [
  { k: 'guest', label: '游客预约' },
  { k: 'ops', label: '运营调度' },
  { k: 'tickets', label: '预约单核销' }
]
const tab = ref('guest')

// ============ 页签一：游客预约下单 ============
const scope = ref('entry')
const pickRide = ref(0)
const pickDay = computed(() => today.value + dayOffset.value)
const dayOffset = ref(0)
const qty = ref(2)
const guestName = ref('')
const bookMsg = ref('')

const rideSlotsMap = ref({})   // rideId -> slots
const rideSlotsLoading = ref(false)
async function loadRideSlots(silent = false) {
  if (!silent) rideSlotsLoading.value = true
  const rides = store.rides.filter(r => r.status === 'operating')
  const entries = await Promise.all(rides.map(r => store.rideSlots(r.id)))
  const map = {}
  entries.forEach((e, i) => { map[rides[i].id] = e.list || [] })
  rideSlotsMap.value = map
  if (!silent) rideSlotsLoading.value = false
}

const entrySlotsByDay = computed(() => {
  const d = pickDay.value
  return store.entrySlots
    .filter(s => s.day === d)
    .sort((a, b) => a.hour - b.hour)
})

const rideSlotsByDay = computed(() => {
  if (!pickRide.value) return []
  return (rideSlotsMap.value[pickRide.value] || [])
    .filter(s => s.day === pickDay.value)
    .sort((a, b) => a.hour - b.hour)
})

const slotsForDay = computed(() => scope.value === 'entry' ? entrySlotsByDay.value : rideSlotsByDay.value)
const chosenRide = computed(() => store.rides.find(r => r.id === pickRide.value))
const unitPrice = computed(() => scope.value === 'entry' ? +store.ticket : (chosenRide.value?.price ?? 0))
const totalPrice = computed(() => unitPrice.value * qty.value)

function pickSlot(s) { selectedSlot.value = s }
const selectedSlot = ref(null)
function onScopeChange() { selectedSlot.value = null; if (scope.value === 'ride' && !pickRide.value && store.rides.length) pickRide.value = store.rides.find(r => r.status === 'operating')?.id || 0 }
function onRideChange() { selectedSlot.value = null }

function slotState(s) {
  if (s.status !== 'open') return { cls: 'closed', text: '已关闭' }
  const now = today.value
  if (s.day < now || (s.day === now && s.hour < store.clock.hour)) return { cls: 'past', text: '已过期' }
  if (s.remain <= 0) return { cls: 'full', text: '约满' }
  return { cls: 'open', text: `余 ${s.remain}` }
}

async function submitBook() {
  bookMsg.value = ''
  if (!selectedSlot.value) { bookMsg.value = '请选择入园/游玩时段'; return }
  const r = await store.bookReservation({
    scope: scope.value,
    ride_id: scope.value === 'ride' ? pickRide.value : undefined,
    slot_id: selectedSlot.value.id,
    qty: qty.value,
    guest_name: guestName.value
  })
  if (r?.ok) {
    bookMsg.value = `预约成功！预约号 ${r.code}，预收 ¥${totalPrice.value.toLocaleString()}，请按时段核销入园`
    guestName.value = ''
    selectedSlot.value = null
    if (scope.value === 'ride') await loadRideSlots()
  } else {
    bookMsg.value = r?.msg || '预约失败'
  }
}

// ============ 页签二：运营调度 ============
const opsScope = ref('entry')
const opsRide = ref(0)
const opsDayOffset = ref(0)
const opsDay = computed(() => today.value + opsDayOffset.value)
const opsSlots = computed(() => {
  if (opsScope.value === 'entry') return store.entrySlots.filter(s => s.day === opsDay.value).sort((a, b) => a.hour - b.hour)
  return (rideSlotsMap.value[opsRide.value] || []).filter(s => s.day === opsDay.value).sort((a, b) => a.hour - b.hour)
})
const opsRideName = id => store.rides.find(r => r.id === id)?.name || ''
const editing = ref({})   // slotId -> { cap, oversell }
function beginEdit(s) { editing.value[s.id] = { cap: s.capacity, oversell: s.oversell } }
async function saveSlot(s) {
  const e = editing.value[s.id]
  if (!e) return
  const r = await store.updateSlot(s.id, { capacity: Math.round(+e.cap), oversell: Math.round(+e.oversell) })
  if (r?.ok) { editing.value[s.id] = null; if (opsScope.value === 'ride') await loadRideSlots() }
}
async function toggleSlot(s) {
  const r = await store.updateSlot(s.id, { status: s.status === 'open' ? 'closed' : 'open' })
  if (r?.ok && opsScope.value === 'ride') await loadRideSlots()
}

// ============ 页签三：预约单核销 ============
const tFilter = ref('active')   // active / all
const tScope = ref('all')
const filteredTickets = computed(() => {
  return store.reservations.filter(r => {
    if (tFilter.value === 'active' && r.status !== 'booked') return false
    if (tScope.value !== 'all' && r.scope !== tScope.value) return false
    return true
  })
})

const statusBadge = st => ({
  booked: { cls: 'b-booked', text: '待核销' },
  checked: { cls: 'b-checked', text: '已核销' },
  noshow: { cls: 'b-noshow', text: '爽约' },
  refunded: { cls: 'b-refund', text: '已退款' },
  refunded_half: { cls: 'b-half', text: '退50%' }
}[st] || { cls: '', text: st })

async function checkin(r) {
  const res = await store.checkinReservation(r.id)
  flash(r.id, res?.ok ? `✓ ${r.code} 已核销 ${r.qty} 人` : (res?.msg || '核销失败'), res?.ok)
}
async function cancel(r) {
  const res = await store.cancelReservation(r.id)
  flash(r.id, res?.ok ? `已取消，退款 ¥${res.back}${res.fee ? `，手续费 ¥${res.fee}` : ''}` : (res?.msg || '取消失败'), res?.ok)
}

// 改签：展开选择其他时段
const rsOpen = ref({})
const rsTarget = ref({})
function toggleRs(id) { rsOpen.value[id] = !rsOpen.value[id] }
const rsCandidates = (r) => {
  if (r.scope === 'entry') {
    return store.entrySlots.filter(s =>
      s.status === 'open' && s.remain >= r.qty &&
      (s.day > today.value || (s.day === today.value && s.hour >= store.clock.hour)) &&
      s.id !== r.slot_id)
  }
  return (rideSlotsMap.value[r.ride_id] || []).filter(s =>
    s.status === 'open' && s.remain >= r.qty &&
    (s.day > today.value || (s.day === today.value && s.hour >= store.clock.hour)) &&
    s.id !== r.slot_id)
}
async function doReschedule(r) {
  const sid = +rsTarget.value[r.id]
  if (!sid) return
  const res = await store.rescheduleReservation(r.id, sid)
  flash(r.id, res?.ok ? '改签成功' : (res?.msg || '改签失败'), res?.ok)
  if (res?.ok) { rsOpen.value[r.id] = false; await loadRideSlots() }
}

const flashes = ref({})
function flash(id, msg, ok) { flashes.value[id] = { msg, ok: !!ok } }

// 详情时间线
const detail = ref(null)
const detailLogs = ref([])
const ACTION_LABEL = {
  create: '游客下单', auto_book: '系统代约', checkin: '核销入园', reschedule: '游客改签',
  auto_reschedule: '超售自动改签', noshow: '爽约处理', cancel: '取消(扣手续费)', refund: '退款', split: '拆单'
}
async function openDetail(r) {
  const d = await store.reservationDetail(r.id)
  if (d?.reservation) { detail.value = d.reservation; detailLogs.value = d.logs || [] }
}
function closeDetail() { detail.value = null }

const dayTabs = [0, 1, 2]
const dayLabel = off => off === 0 ? '今天' : off === 1 ? '明天' : '后天'
const fillPct = s => s.capacity + s.oversell ? Math.round(s.booked_count / (s.capacity + s.oversell) * 100) : 0
function pickDayIf(off) { return today.value + off }
</script>

<template>
  <div class="rsv">
    <!-- 顶部指标 -->
    <div class="stat-grid">
      <div class="card stat"><span>📅</span><b>{{ stats.todayBooked }}</b><em>今日预约名额</em></div>
      <div class="card stat"><span>✅</span><b class="money">{{ stats.todayChecked }}</b><em>今日已核销入园</em></div>
      <div class="card stat"><span>📊</span><b>{{ stats.todayFill }}%</b><em>今日预约填充率</em></div>
      <div class="card stat"><span>🎟️</span><b>{{ stats.pendingOrders }}</b><em>在途预约单 / {{ stats.pendingQty }} 人</em></div>
      <div class="card stat"><span>⏭️</span><b>{{ stats.soldAheadQty }}</b><em>未来预售名额</em></div>
      <div class="card stat"><span class="money">¥</span><b class="money">{{ stats.soldAheadAmount.toLocaleString() }}</b><em>预售已收款</em></div>
      <div class="card stat" :class="{ alert: stats.noshowToday }"><span>⌛</span><b :class="stats.noshowToday ? 'neg' : ''">{{ stats.noshowToday }}</b><em>今日爽约单</em></div>
      <div class="card stat" :class="{ alert: stats.oversoldPending }"><span>⚠️</span><b :class="stats.oversoldPending ? 'neg' : ''">{{ stats.oversoldPending }}</b><em>超售待处理</em></div>
    </div>

    <div class="tabs card">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
      <span class="muted hint" v-if="tab === 'guest'">游客按日期 + 时段预约入园或热门设施，下单即预收票款</span>
      <span class="muted hint" v-else-if="tab === 'ops'">按容量、超售额度与设备状态调度分时时段</span>
      <span class="muted hint" v-else>闸机/设施口核销，处理改签、爽约、超售与退款</span>
    </div>

    <!-- ============ 游客预约 ============ -->
    <div v-if="tab === 'guest'" class="guest-grid">
      <div class="card">
        <h3>🧾 填写预约信息</h3>
        <div class="seg">
          <button :class="{ on: scope === 'entry' }" @click="scope = 'entry'; onScopeChange()">🏞️ 分时入园</button>
          <button :class="{ on: scope === 'ride' }" @click="scope = 'ride'; onScopeChange()">🎢 设施预约</button>
        </div>
        <label class="fld" v-if="scope === 'ride'">选择设施
          <select v-model.number="pickRide" @change="onRideChange">
            <option :value="0" disabled>请选择设施…</option>
            <option v-for="r in store.rides.filter(x => x.status === 'operating')" :key="r.id" :value="r.id">
              {{ r.name }}（¥{{ r.price }}/人）
            </option>
            <option v-for="r in store.rides.filter(x => x.status !== 'operating')" :key="r.id" :value="r.id" disabled>
              {{ r.name }}（停运中，不可约）
            </option>
          </select>
        </label>
        <label class="fld">预约日期
          <div class="chips">
            <button v-for="off in dayTabs" :key="off" type="button" class="chip" :class="{ on: dayOffset === off }" @click="dayOffset = off; selectedSlot = null">
              第{{ pickDayIf(off) }}天 · {{ dayLabel(off) }}
            </button>
          </div>
        </label>
        <label class="fld">游客姓名（选填）<input v-model="guestName" placeholder="如：王**" maxlength="12" /></label>
        <label class="fld">人数
          <div class="stepper">
            <button type="button" @click="qty = Math.max(1, qty - 1)">－</button>
            <b>{{ qty }}</b>
            <button type="button" @click="qty = Math.min(20, qty + 1)">＋</button>
          </div>
        </label>
        <div class="quote">
          <span>{{ scope === 'entry' ? '门票单价' : '设施票价' }} <b class="money">¥{{ unitPrice }}</b> / 人</span>
          <span>合计预收 <b class="money">¥{{ totalPrice.toLocaleString() }}</b></span>
          <em class="muted">提前取消全额退；当日取消退 50%；爽约不退。预约费用下单即收取。</em>
        </div>
        <button class="primary wide" :disabled="!selectedSlot" @click="submitBook">
          {{ selectedSlot ? `预约 第${selectedSlot.day}天 ${selectedSlot.hour}:00 · ¥${totalPrice.toLocaleString()}` : '请先选择时段' }}
        </button>
        <em v-if="bookMsg" class="bookmsg" :class="{ err: bookMsg.includes('失败') || bookMsg.includes('请') }">{{ bookMsg }}</em>
      </div>

      <div class="card slots-card">
        <h3>🕘 选择{{ scope === 'entry' ? '入园' : '游玩' }}时段
          <span class="muted" style="font-size:12px">第{{ pickDay }}天</span>
        </h3>
        <div class="slot-grid">
          <button v-for="s in slotsForDay" :key="s.id" class="slot"
                  :class="[slotState(s).cls, { picked: selectedSlot?.id === s.id }]"
                  :disabled="slotState(s).cls !== 'open'"
                  @click="pickSlot(s)">
            <b>{{ s.hour }}:00</b>
            <em>{{ slotState(s).text }}</em>
            <i v-if="s.oversell > 0" class="ov">超售+{{ s.oversell }}</i>
            <div class="mini"><i :style="{ width: Math.min(100, fillPct(s)) + '%' }"></i></div>
          </button>
        </div>
        <div v-if="scope === 'ride' && !pickRide" class="muted empty">请先选择设施查看可约时段。</div>
        <div v-else-if="!slotsForDay.length" class="muted empty">当日暂无可约时段。</div>
      </div>
    </div>

    <!-- ============ 运营调度 ============ -->
    <div v-if="tab === 'ops'" class="card">
      <div class="ops-head">
        <div class="seg">
          <button :class="{ on: opsScope === 'entry' }" @click="opsScope = 'entry'">🏞️ 入园时段</button>
          <button :class="{ on: opsScope === 'ride' }" @click="opsScope = 'ride'">🎢 设施时段</button>
        </div>
        <select v-if="opsScope === 'ride'" v-model.number="opsRide" @change="loadRideSlots()">
          <option :value="0" disabled>选择设施…</option>
          <option v-for="r in store.rides" :key="r.id" :value="r.id">{{ r.name }}（{{ r.status === 'operating' ? '运营中' : r.status === 'maintenance' ? '检修中' : '关闭' }}）</option>
        </select>
        <div class="chips">
          <button v-for="off in dayTabs" :key="off" class="chip" :class="{ on: opsDayOffset === off }" @click="opsDayOffset = off">{{ dayLabel(off) }}</button>
        </div>
      </div>

      <div class="table" v-if="opsScope === 'entry' || opsRide">
        <div class="thead">
          <span>时段</span><span>状态</span><span>容量</span><span>超售</span><span>已约 / 核销 / 爽约 / 退</span><span>填充</span><span>操作</span>
        </div>
        <div class="trow" v-for="s in opsSlots" :key="s.id" :class="{ closedrow: s.status !== 'open' }">
          <span><b>第{{ s.day }}天 {{ s.hour }}:00</b><em class="muted" v-if="s.scope === 'ride'">{{ s.ride_name }}</em></span>
          <span><i class="dot" :class="s.status"></i>{{ s.status === 'open' ? '开放' : '关闭' }}</span>
          <span>
            <template v-if="editing[s.id]">
              <input type="number" class="mini-in" v-model.number="editing[s.id].cap" min="0" step="10" />
            </template>
            <template v-else>{{ s.capacity }}</template>
          </span>
          <span>
            <template v-if="editing[s.id]">
              <input type="number" class="mini-in" v-model.number="editing[s.id].oversell" min="0" max="200" step="5" />
            </template>
            <template v-else>{{ s.oversell }}</template>
          </span>
          <span class="nums">{{ s.booked_count }} / {{ s.checked_count }} / {{ s.noshow_count }} / {{ s.refund_count }}</span>
          <span><div class="hb"><i :style="{ width: Math.min(100, fillPct(s)) + '%', background: fillPct(s) > 100 ? 'var(--red)' : fillPct(s) > 85 ? 'var(--accent2)' : 'var(--green)' }"></i></div>{{ fillPct(s) }}%</span>
          <span class="ops-btns">
            <template v-if="editing[s.id]">
              <button class="succ" @click="saveSlot(s)">保存</button>
              <button class="ghost" @click="editing[s.id] = null">取消</button>
            </template>
            <template v-else>
              <button class="ghost" @click="beginEdit(s)">调容量</button>
              <button class="ghost" :class="{ danger: s.status === 'open' }" @click="toggleSlot(s)">{{ s.status === 'open' ? '关闭时段' : '开放时段' }}</button>
            </template>
          </span>
        </div>
      </div>
      <div v-else class="muted empty">请选择要调度的设施。</div>
      <div class="muted tips">
        💡 容量调减不得低于已预约人数；超售额度用于对冲爽约（爽约率约 18%），到场超额时系统优先自动改签后段，无法安置则全额退款并自动生成投诉工单。
        关闭时段或关联设施停运，将对在途预约执行<b>园方全额退款</b>并联动投诉。
      </div>
    </div>

    <!-- ============ 预约单核销 ============ -->
    <div v-if="tab === 'tickets'" class="tk">
      <div class="filters card">
        <div class="seg">
          <button :class="{ on: tFilter === 'active' }" @click="tFilter = 'active'">待核销</button>
          <button :class="{ on: tFilter === 'all' }" @click="tFilter = 'all'">全部单据</button>
        </div>
        <div class="seg">
          <button :class="{ on: tScope === 'all' }" @click="tScope = 'all'">全部</button>
          <button :class="{ on: tScope === 'entry' }" @click="tScope = 'entry'">入园</button>
          <button :class="{ on: tScope === 'ride' }" @click="tScope = 'ride'">设施</button>
        </div>
      </div>

      <div class="tlist">
        <div class="titem card" v-for="r in filteredTickets" :key="r.id">
          <div class="ti-main">
            <div class="code">
              <b>{{ r.code }}</b>
              <span class="badge" :class="statusBadge(r.status).cls">{{ statusBadge(r.status).text }}</span>
              <span class="tag">{{ r.scope_name }}</span>
            </div>
            <div class="meta">
              {{ r.scope === 'ride' ? `🎢 ${r.ride_name} · ` : '🏞️ ' }}
              第{{ r.slot_day }}天 {{ r.slot_hour }}:00 ·
              👤 {{ r.guest_name }} · {{ r.qty }} 人 ·
              <b class="money">¥{{ r.amount.toLocaleString() }}</b>
              <em v-if="r.reschedules" class="muted"> · 已改签 {{ r.reschedules }} 次</em>
              <em v-if="r.source === 'auto'" class="muted"> · 系统代约</em>
            </div>
          </div>
          <div class="ti-ops">
            <template v-if="r.status === 'booked'">
              <button class="succ" @click="checkin(r)">✅ 核销</button>
              <button class="ghost" @click="toggleRs(r.id)">改签</button>
              <button class="danger" @click="cancel(r)">取消退款</button>
            </template>
            <button class="ghost" @click="openDetail(r)">时间线</button>
          </div>
          <!-- 改签展开 -->
          <div class="rs-box" v-if="rsOpen[r.id]">
            <select v-model.number="rsTarget[r.id]">
              <option :value="0" disabled>选择改入时段…</option>
              <option v-for="s in rsCandidates(r)" :key="s.id" :value="s.id">
                第{{ s.day }}天 {{ s.hour }}:00 · 余 {{ s.remain }}{{ s.scope === 'ride' ? ` · ${s.ride_name}` : '' }}
              </option>
            </select>
            <button class="primary" :disabled="!rsTarget[r.id]" @click="doReschedule(r)">确认改签（不加价）</button>
          </div>
          <em v-if="flashes[r.id]" class="flash" :class="{ ok: flashes[r.id].ok, err: !flashes[r.id].ok }">{{ flashes[r.id].msg }}</em>
        </div>
        <div class="muted empty card" v-if="!filteredTickets.length">
          {{ tFilter === 'active' ? '当前没有待核销预约单。' : '暂无预约记录。' }}
        </div>
      </div>
    </div>

    <!-- 详情时间线 -->
    <div class="mask" v-if="detail" @click.self="closeDetail">
      <div class="dialog card">
        <h3>🎫 预约单 {{ detail.code }}
          <span class="badge" :class="statusBadge(detail.status).cls">{{ statusBadge(detail.status).text }}</span>
          <button class="ghost x" @click="closeDetail">✕</button>
        </h3>
        <p class="d-meta muted">
          {{ detail.scope_name }}<template v-if="detail.ride_name"> · {{ detail.ride_name }}</template>
          · 第{{ detail.slot_day }}天 {{ detail.slot_hour }}:00 · {{ detail.guest_name }} · {{ detail.qty }} 人
          · 预收 <b class="money">¥{{ detail.amount.toLocaleString() }}</b>
        </p>
        <h4>处理时间线</h4>
        <div class="logs">
          <div v-for="l in detailLogs" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ ACTION_LABEL[l.action] || l.action }}</b>
            <em class="muted">第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rsv { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.neg { color: var(--red); }

.tabs { display: flex; align-items: center; gap: 8px; }
.tabs button { padding: 7px 18px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.tabs .hint { margin-left: 8px; font-size: 12px; }

/* 游客预约 */
.guest-grid { display: grid; grid-template-columns: 360px 1fr; gap: 14px; align-items: start; }
@media (max-width: 1000px) { .guest-grid { grid-template-columns: 1fr; } }
.seg { display: flex; gap: 6px; margin-bottom: 12px; }
.seg button { flex: 1; }
.seg button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.fld { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); margin-bottom: 12px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 5px 12px; font-size: 12px; border-radius: 16px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.chip.on { background: rgba(255,107,107,.18); border-color: var(--accent); color: var(--accent); }
.stepper { display: flex; align-items: center; gap: 14px; }
.stepper button { width: 38px; padding: 6px 0; }
.stepper b { font-size: 18px; min-width: 24px; text-align: center; }
.quote { background: var(--panel2); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; margin-bottom: 12px; }
.quote em { font-size: 11px; line-height: 1.5; }
.wide { width: 100%; padding: 11px; }
.bookmsg { display: block; margin-top: 10px; font-size: 12.5px; color: var(--green); font-style: normal; }
.bookmsg.err { color: var(--red); }

.slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
.slot { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; padding: 10px; border-radius: 10px; position: relative; text-align: left; }
.slot b { font-size: 15px; }
.slot em { font-style: normal; font-size: 11px; color: var(--muted); }
.slot .ov { font-style: normal; font-size: 10px; color: var(--purple); }
.slot .mini { width: 100%; height: 4px; background: #10162a; border-radius: 3px; overflow: hidden; margin-top: 2px; }
.slot .mini i { display: block; height: 100%; background: var(--accent2); }
.slot.open.picked { border-color: var(--accent); background: rgba(255,107,107,.14); }
.slot.full, .slot.closed, .slot.past { opacity: .5; cursor: not-allowed; }
.slot.full em { color: var(--red); }
.slot.closed em { color: var(--red); }
.empty { padding: 22px; text-align: center; }

/* 调度表 */
.ops-head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.ops-head .seg { margin-bottom: 0; }
.ops-head select { min-width: 180px; }
.table .thead, .table .trow { display: grid; grid-template-columns: 1.2fr .7fr .7fr .6fr 1.6fr .9fr 1.3fr; gap: 8px; align-items: center; padding: 10px 8px; font-size: 13px; }
.table .thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.table .trow { border-bottom: 1px solid var(--border); }
.table .trow.closedrow { opacity: .6; }
.table b { display: block; }
.table em { font-style: normal; font-size: 11px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.dot.open { background: var(--green); }
.dot.closed { background: var(--red); }
.mini-in { width: 74px; padding: 4px 6px; }
.hb { width: 90px; height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden; display: inline-block; margin-right: 6px; vertical-align: middle; }
.hb i { display: block; height: 100%; }
.nums { font-variant-numeric: tabular-nums; color: var(--muted); }
.ops-btns { display: flex; gap: 4px; flex-wrap: wrap; }
.ops-btns button { font-size: 11px; padding: 4px 8px; }
.tips { margin-top: 14px; font-size: 12px; line-height: 1.7; }
.tips b { color: var(--text); }

/* 单据 */
.tk .filters { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.tk .filters .seg { margin-bottom: 0; }
.tlist { display: flex; flex-direction: column; gap: 10px; }
.titem { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; }
.titem > .ti-main { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.code { display: flex; align-items: center; gap: 8px; }
.code b { font-size: 14px; }
.meta { font-size: 13px; color: var(--muted); }
.ti-ops { display: flex; gap: 6px; }
.ti-ops button { font-size: 12px; }
.badge { font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); }
.b-booked { color: var(--accent2) !important; border-color: rgba(255,209,102,.5) !important; }
.b-checked { color: var(--green) !important; border-color: rgba(109,213,160,.5) !important; }
.b-noshow { color: #fff !important; background: var(--red) !important; border-color: var(--red) !important; }
.b-refund { color: var(--blue) !important; border-color: rgba(102,166,255,.5) !important; }
.b-half { color: var(--purple) !important; border-color: rgba(167,139,250,.5) !important; }
.rs-box { display: flex; gap: 8px; align-items: center; }
.rs-box select { flex: 1; max-width: 420px; }
.flash { font-style: normal; font-size: 12.5px; }
.flash.ok { color: var(--green); }
.flash.err { color: var(--red); }

/* 详情 */
.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(560px, 100%); max-height: 86vh; overflow-y: auto; }
.dialog .x { margin-left: auto; }
.d-meta { font-size: 13px; margin: 8px 0; }
.dialog h4 { margin: 16px 0 10px; font-size: 13px; }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 16px 20px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .ldot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 3px; }
</style>
