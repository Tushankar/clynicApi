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

/** True when [slotStart, slotEnd) overlaps any block's [startAt, endAt) window. */
function inBlockedWindow(slotStart, slotEnd, blocks) {
  for (const b of blocks) {
    const bs = new Date(b.startAt).getTime();
    const be = new Date(b.endAt).getTime();
    if (slotStart < be && slotEnd > bs) return true;
  }
  return false;
}

/**
 * @param {{ doctor, date, bookedStarts?: Date[], now?: Date, leadMinutes?: number,
 *           blocks?: Array<{startAt: Date, endAt: Date}> }} args
 *   blocks: availability blocks (doctor leave / clinic holidays) overlapping the day —
 *   slots inside any block are marked unavailable (§5.20).
 * @returns {Array<{ start: string(ISO), label: string, available: boolean }>}
 */
function generateSlots({ doctor, date, bookedStarts = [], now = new Date(), leadMinutes = 0, blocks = [] }) {
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
        available: cur > cutoff && !bookedSet.has(cur) && !inBlockedWindow(cur, cur + step * 60000, blocks),
      });
      cur += step * 60000;
    }
  }
  return slots;
}

/** True if the doctor has ANY working hours configured (used to decide whether to enforce them). */
function hasWorkingHours(doctor) {
  const avail = availabilityToObject(doctor && doctor.availability);
  return DAY_KEYS.some((k) => Array.isArray(avail[k]) && avail[k].some((w) => w && w.start && w.end));
}

/**
 * True if `when` falls at the start of one of the doctor's weekly windows for that weekday.
 * Server-side guard so a crafted request can't book/reschedule outside the doctor's hours
 * (the slot picker already restricts this client-side). Matches generateSlots: a time counts
 * as valid when it is >= a window start and < that window's end.
 */
function isWithinWorkingHours(doctor, when) {
  const avail = availabilityToObject(doctor && doctor.availability);
  const d = new Date(when);
  const windows = avail[DAY_KEYS[d.getDay()]] || [];
  if (!windows.length) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return windows.some((w) => {
    if (!w || !w.start || !w.end) return false;
    const s = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    return mins >= s.h * 60 + s.m && mins < e.h * 60 + e.m;
  });
}

module.exports = { generateSlots, inBlockedWindow, hasWorkingHours, isWithinWorkingHours, DAY_KEYS };
