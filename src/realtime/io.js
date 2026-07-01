'use strict';

const { Server } = require('socket.io');
const config = require('../config/env');
const { normalizeRole } = require('../config/roles');

/**
 * Resolve a socket's identity from its handshake — NEVER from client room-join args.
 * Clerk mode: verify the session token in handshake.auth.token. Dev mode: read
 * handshake.auth fields. Unauthenticated sockets get {} (they can still use the
 * public, display-safe queue/TV rooms, but never the staff notif/chat rooms).
 */
async function resolveSocketIdentity(socket) {
  const auth = socket.handshake.auth || {};
  if (config.devAuth) {
    return { clinicId: auth.clinicId || null, userId: auth.userId || null, role: normalizeRole(auth.role) };
  }
  if (!auth.token) return {};
  try {
    // eslint-disable-next-line global-require
    const { verifyToken } = require('@clerk/backend');
    const claims = await verifyToken(auth.token, { secretKey: config.clerk.secretKey });
    return { clinicId: claims.org_id || null, userId: claims.sub || null, role: normalizeRole(claims.org_role) };
  } catch {
    return {}; // invalid token → no staff identity (public-only)
  }
}

/**
 * Socket.IO server for the live queue / TV display (section 5.3 / 9).
 *
 * Clients join a `clinic:<clinicId>:branch:<branchId>` room and receive queue
 * snapshots. Payloads are DISPLAY-SAFE ONLY (token, first name, doctor, status,
 * wait) — never phone/email/records — because the TV join is unauthenticated.
 */
let io = null;

function roomFor(clinicId, branchId) {
  return `clinic:${clinicId}:branch:${branchId}`;
}

function initIo(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigins.length ? config.corsOrigins : true, credentials: true },
  });

  // Attach a verified identity to every socket (does NOT reject — public TV needs in).
  io.use(async (socket, next) => {
    socket.data = await resolveSocketIdentity(socket);
    next();
  });

  io.on('connection', (socket) => {
    // Public, display-safe: the waiting-room TV joins by clinic+branch (args ok —
    // payloads carry only token/first-name/status).
    socket.on('queue:join', ({ clinicId, branchId }) => {
      if (clinicId && branchId) socket.join(roomFor(clinicId, branchId));
    });
    socket.on('queue:leave', ({ clinicId, branchId }) => {
      if (clinicId && branchId) socket.leave(roomFor(clinicId, branchId));
    });
    // Notifications + chat carry PHI (names, message bodies), so room membership
    // comes ONLY from the socket's verified identity — never client-supplied args.
    socket.on('staff:join', () => {
      const { clinicId, userId } = socket.data || {};
      if (!clinicId) return;
      socket.join(`notif:${clinicId}`);
      if (userId) {
        socket.join(`notif:${clinicId}:${userId}`);
        socket.join(`chat:${clinicId}:${userId}`);
      }
    });
  });

  return io;
}

/** Notification push: targeted to a staff member, or broadcast to the clinic. */
function emitNotification(clinicId, recipientId, payload) {
  if (!io) return;
  if (recipientId) io.to(`notif:${clinicId}:${recipientId}`).emit('notification:new', payload);
  else io.to(`notif:${clinicId}`).emit('notification:new', payload);
}

/** Chat push: deliver a message to the recipient staff member's room. */
function emitChatMessage(clinicId, toStaffId, payload) {
  if (io && toStaffId) io.to(`chat:${clinicId}:${toStaffId}`).emit('chat:message', payload);
}

function emitQueueUpdate(clinicId, branchId, snapshot) {
  if (io) io.to(roomFor(clinicId, branchId)).emit('queue:update', snapshot);
}

function emitYourTurn(clinicId, branchId, payload) {
  if (io) io.to(roomFor(clinicId, branchId)).emit('queue:your-turn', payload);
}

function getIo() {
  return io;
}

module.exports = { initIo, emitQueueUpdate, emitYourTurn, emitNotification, emitChatMessage, getIo, roomFor };
