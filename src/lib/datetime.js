'use strict';

/**
 * Small date helpers (server-local time). Phase 1 targets a single Kolkata
 * timezone, so wall-clock server time is acceptable; revisit with a tz library
 * if multi-region clinics arrive.
 */

/** Start/end of the local day containing `date` (or a 'YYYY-MM-DD' string). */
function dayRange(date) {
  const d = typeof date === 'string' ? parseDateOnly(date) : new Date(date);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { start, end };
}

/** Parse 'YYYY-MM-DD' as a local date (midnight). */
function parseDateOnly(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60000);
}

/** 'YYYY-MM-DD' for the local day of `date` (used for per-day token sequences). */
function dateKey(date) {
  const d = new Date(date);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

module.exports = { dayRange, parseDateOnly, addMinutes, dateKey };
