/* ─────────────────────────────────────────────────────────
   Slot logic shared by the public booking page (browser) and
   the bookings API (Node), so both apply exactly the same rules.

   Rules
   • Slots start at the beginning of each opening period and repeat
     every `step` minutes (the interval set in the backoffice).
   • When a slot position falls inside an existing booking or a
     blockout, the next slot starts exactly when it ends
     (booking 09:00–09:40 → next slot 09:40, then 09:40 + step…).
   • A slot is only offered if the whole service fits: it must end
     before the period closes (e.g. lunch) and not overlap any
     booking or blockout.
   ───────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SlotLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // Used until the owner saves a schedule in the backoffice
  const WEEKDAY = { active: true, start1: '09:00', end1: '13:00', start2: '14:00', end2: '18:00' };
  const CLOSED  = { active: false, start1: '', end1: '', start2: '', end2: '' };
  const DEFAULT_SCHEDULE = { mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY, sat: CLOSED, sun: CLOSED };

  function toMin(t) {
    if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function toTime(min) {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }

  // 'DD/MM/YYYY' → 'YYYY-MM-DD'
  function ptToISO(datePt) {
    const [d, m, y] = String(datePt).split('/');
    return `${y}-${m}-${d}`;
  }

  // Weekday key ('mon'…) of a 'DD/MM/YYYY' date, independent of the runtime's timezone
  function dayKeyOf(datePt) {
    const [d, m, y] = String(datePt).split('/').map(Number);
    return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  // Opening periods of a schedule day as [[startMin, endMin], …]
  function periodsFor(day) {
    if (!day || !day.active) return [];
    return [[day.start1, day.end1], [day.start2, day.end2]]
      .map(([s, e]) => [toMin(s), toMin(e)])
      .filter(([s, e]) => s !== null && e !== null && e > s);
  }

  // Blockouts that touch a given date, as minute ranges within that day
  function blockedRangesFor(dateISO, blockouts) {
    return (blockouts || [])
      .filter(b => dateISO >= b.startDate && dateISO <= b.endDate)
      .map(b => ({
        start: dateISO === b.startDate ? (toMin(b.startTime) ?? 0) : 0,
        end:   dateISO === b.endDate   ? (toMin(b.endTime) ?? 1440) : 1440,
        kind: 'blocked',
      }))
      .filter(r => r.end > r.start);
  }

  // Bookings of a given date as minute ranges
  function bookedSegmentsFor(bookings, datePt, defaultDur, excludeId) {
    return (bookings || [])
      .filter(b => b.date === datePt && b.id !== excludeId && toMin(b.time) !== null)
      .map(b => {
        const start = toMin(b.time);
        return { start, end: start + (Number(b.serviceDuration) || defaultDur || 30), kind: 'booked', id: b.id };
      });
  }

  /**
   * Slots for one day.
   * @returns [{ time, min, available, reason }] — reason: 'booked' | 'blocked' | 'past'
   */
  function generateDaySlots({ day, step, duration, booked, blocked, notBeforeMin }) {
    step     = Math.max(5, Number(step) || 20);
    duration = Math.max(1, Number(duration) || 30);
    const segs = [...(booked || []), ...(blocked || [])].sort((a, b) => a.start - b.start);
    const out = [];

    for (const [pStart, pEnd] of periodsFor(day)) {
      let cur = pStart;
      let guard = 0;
      while (cur + duration <= pEnd && guard++ < 2000) {
        // Slot position inside a booking/blockout → next slot starts when it ends
        const covering = segs.find(s => s.start <= cur && s.end > cur);
        if (covering) { cur = covering.end; continue; }

        const end = cur + duration;
        const overlap = segs.find(s => s.start < end && s.end > cur);
        let reason = null;
        if (overlap) reason = overlap.kind === 'blocked' ? 'blocked' : 'booked';
        else if (notBeforeMin != null && cur <= notBeforeMin) reason = 'past';

        out.push({ time: toTime(cur), min: cur, available: !reason, reason });
        cur += step;
      }
    }
    return out;
  }

  // Current date/time in Portugal, regardless of the server's timezone
  function lisbonNow(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
    return { datePt: `${parts.day}/${parts.month}/${parts.year}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  /**
   * Validates a public booking request against schedule, blockouts, existing bookings and the clock.
   * @returns null when bookable, otherwise a user-facing error message
   */
  function checkBookable({ schedule, blockouts, bookings, datePt, time, duration, defaultDur, now }) {
    const start = toMin(time);
    if (start === null || !/^\d{2}\/\d{2}\/\d{4}$/.test(datePt || '')) return 'Data ou hora inválida.';
    const end = start + duration;

    const periods = periodsFor((schedule || {})[dayKeyOf(datePt)]);
    if (!periods.some(([s, e]) => start >= s && end <= e)) {
      return 'Este horário está fora do horário de atendimento. Por favor escolha outro.';
    }

    const n = now || lisbonNow();
    if (ptToISO(datePt) < ptToISO(n.datePt) || (datePt === n.datePt && start <= n.min)) {
      return 'Este horário já passou. Por favor escolha outro.';
    }

    if (blockedRangesFor(ptToISO(datePt), blockouts).some(r => r.start < end && r.end > start)) {
      return 'Este horário não está disponível. Por favor escolha outro.';
    }
    if (bookedSegmentsFor(bookings, datePt, defaultDur).some(s => s.start < end && s.end > start)) {
      return 'Este horário já está ocupado. Por favor escolha outro horário.';
    }
    return null;
  }

  return {
    DAY_KEYS, DEFAULT_SCHEDULE, toMin, toTime, ptToISO, dayKeyOf, periodsFor,
    blockedRangesFor, bookedSegmentsFor, generateDaySlots, lisbonNow, checkBookable,
  };
});
