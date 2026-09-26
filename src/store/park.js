import { defineStore } from 'pinia'

const BASE = '/api'

async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch(BASE + path, opt)
  return r.json()
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
    lastTick: 0
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
    // 分时预约
    bookReservation(payload) { return this.api('POST', '/reservations', payload) },
    rescheduleReservation(id, slot_id) { return this.api('POST', `/reservations/${id}/reschedule`, { slot_id }) },
    cancelReservation(id) { return this.api('POST', `/reservations/${id}/cancel`, {}) },
    checkinReservation(id) { return this.api('POST', `/reservations/${id}/checkin`, {}) },
    updateSlot(id, payload) { return this.api('POST', `/reservation-slots/${id}`, payload) },
    async rideSlots(rideId, day) { return j('GET', `/reservation-slots?scope=ride&rideId=${rideId}${day ? `&day=${day}` : ''}`) },
    async reservationDetail(id) { return j('GET', `/reservations/${id}`) },
    // 设施检修工单
    assignMaintenance(id, staff_id) { return this.api('POST', `/maintenance/${id}/assign`, { staff_id }) },
    cancelMaintenance(id) { return this.api('POST', `/maintenance/${id}/cancel`, {}) },
    async maintenanceDetail(id) { return j('GET', `/maintenance/${id}`) }
  }
})