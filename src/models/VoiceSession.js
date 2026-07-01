'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * voiceSessions — state for an in-progress AI voice-receptionist call (step 9). The dialog is
 * a slot-filling state machine (voiceService); this holds where the caller is + what's been
 * collected, so each webhook turn is stateless on the wire. Ephemeral + clinic-scoped (rule 1);
 * soft-deletable, not audited (high-frequency, non-clinical). Rule 2 applies to every spoken
 * turn — the receptionist never diagnoses.
 */
const voiceSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true }, // telephony call id (provider-agnostic)
    callerPhone: { type: String, default: null },
    state: { type: String, default: 'greet' }, // greet → menu → book_doctor → book_date → book_name → done
    collected: { type: mongoose.Schema.Types.Mixed, default: {} }, // { doctorId, doctorName, scheduledAt, dateISO }
    transcript: { type: [{ role: String, text: String, _id: false }], default: [] },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    tokenNumber: { type: Number, default: null },
  },
  { timestamps: true }
);

clinicScoped(voiceSessionSchema);
softDeletable(voiceSessionSchema);
voiceSessionSchema.index({ clinicId: 1, sessionId: 1 }, { unique: true });

module.exports = mongoose.model('VoiceSession', voiceSessionSchema);
