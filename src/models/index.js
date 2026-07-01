'use strict';

/**
 * Central model registry. Requiring this ensures every Mongoose model is
 * registered exactly once (important for index building and populate refs).
 */
module.exports = {
  Clinic: require('./Clinic'),
  Staff: require('./Staff'),
  Branch: require('./Branch'),
  Patient: require('./Patient'),
  AuditLog: require('./AuditLog'),
  Counter: require('./Counter'),
  Doctor: require('./Doctor'),
  Appointment: require('./Appointment'),
  QueueEntry: require('./QueueEntry'),
  Reminder: require('./Reminder'),
  OtpChallenge: require('./OtpChallenge'),
  Prescription: require('./Prescription'),
  ClinicalNote: require('./ClinicalNote'),
  LabRequest: require('./LabRequest'),
  Report: require('./Report'),
  ChatMessage: require('./ChatMessage'),
  Notification: require('./Notification'),
  Invoice: require('./Invoice'),
  Payment: require('./Payment'),
  Subscription: require('./Subscription'),
  WebhookEvent: require('./WebhookEvent'),
  AiDraft: require('./AiDraft'),
  ClinicDomain: require('./ClinicDomain'),
  VoiceSession: require('./VoiceSession'),
};
