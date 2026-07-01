'use strict';

/**
 * Appointment + queue state machines (sections 6 & 9).
 * Transitions are validated in the service so an appointment can only move
 * along legal edges (e.g. you can't complete a booked-but-never-checked-in appt).
 */

const APPOINTMENT_STATUSES = [
  'booked',
  'confirmed',
  'checked_in',
  'in_consultation',
  'completed',
  'cancelled',
  'no_show',
];

const APPOINTMENT_SOURCES = ['online', 'walkin', 'phone', 'whatsapp'];

// Legal next-states from each status.
const TRANSITIONS = {
  booked: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_consultation', 'cancelled', 'no_show'],
  in_consultation: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

const TERMINAL_STATUSES = ['completed', 'cancelled', 'no_show'];
const ACTIVE_STATUSES = ['booked', 'confirmed', 'checked_in', 'in_consultation'];

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

const QUEUE_STATUSES = ['waiting', 'called', 'in_consultation', 'done', 'skipped'];

module.exports = {
  APPOINTMENT_STATUSES,
  APPOINTMENT_SOURCES,
  TRANSITIONS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  canTransition,
  QUEUE_STATUSES,
};
