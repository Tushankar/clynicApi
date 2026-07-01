'use strict';

/**
 * Slot generation from a doctor's weekly availability (Phase 1).
 * availability is { mon: [{start:'09:00', end:'13:00'}], ... }; slots step by
 * slotDurationMinutes. Booked starts and past times are marked unavailable.
 */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseHHMM(s) {
  const [h, m] = String(s).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

function fmtLabel(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function availabilityToObject(availability) {
  if (!availability) return {};
  if (availability instanceof Map) return Object.fromEntries(availability);
  if (typeof availability.toObject === 'function') return availability.toObject();
  return availability;
}

/**
 * @returns {Array<{ start: string(ISO), label: string, available: boolean }>}
 */
function generateSlots({ doctor, date, bookedStarts = [], now = new Date(), leadMinutes = 0 }) {
  const avail = availabilityToObject(doctor.availability);
  const day = typeof date === 'string' ? new Date(date) : date;
  const windows = avail[DAY_KEYS[day.getDay()]] || [];
  const step = doctor.slotDurationMinutes || 15;
  const bookedSet = new Set(bookedStarts.map((d) => new Date(d).getTime()));
  const cutoff = now.getTime() + leadMinutes * 60000;

  const slots = [];
  for (const w of windows) {
    if (!w || !w.start || !w.end) continue;
    const s = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    let cur = new Date(day.getFullYear(), day.getMonth(), day.getDate(), s.h, s.m, 0, 0).getTime();
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), e.h, e.m, 0, 0).getTime();
    while (cur < end) {
      const slotDate = new Date(cur);
      slots.push({
        start: slotDate.toISOString(),
        label: fmtLabel(slotDate),
        available: cur > cutoff && !bookedSet.has(cur),
      });
      cur += step * 60000;
    }
  }
  return slots;
}

module.exports = { generateSlots, DAY_KEYS };
