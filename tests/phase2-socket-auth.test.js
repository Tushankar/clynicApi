'use strict';

/**
 * [fix] Socket tenant-isolation — a socket with no verified identity (or a forged
 * client-supplied clinicId) must NOT be able to join staff notification/chat rooms,
 * so it can never receive another clinic's PHI-bearing notifications. (Hard rule 1.)
 *
 * Runs in NODE_ENV=test with DEV_AUTH off, so the socket auth path is the real one
 * (verify token from the handshake) — and with no token it resolves to no identity.
 */
process.env.NODE_ENV = 'test';
process.env.CLERK_SECRET_KEY = 'sk_test_dummy';
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_dummy';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');

const { Clinic } = require('../src/models');
const { createApp } = require('../src/app');
const { initIo } = require('../src/realtime/io');
const notificationService = require('../src/services/notificationService');

let mongod;
let server;
let base;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Clinic.create({ clinicId: 'org_A', name: 'A', slug: 'a-sock', subscriptionPlan: 'standard' });
  const app = createApp();
  server = http.createServer(app);
  initIo(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('unauthenticated / forged-clinicId socket cannot receive a clinic notification', async () => {
  const client = ioClient(base, { transports: ['websocket'], forceNew: true, auth: {} }); // no token
  await new Promise((resolve, reject) => {
    client.on('connect', resolve);
    client.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 2000);
  });
  assert.ok(client.connected, 'socket connects (public connections are allowed for the TV)');

  // Attacker tries to join clinic A's staff rooms by supplying clinicId/userId — must be ignored.
  client.emit('staff:join', { clinicId: 'org_A', userId: 'victim' });
  await delay(80);

  let leaked = false;
  client.on('notification:new', () => {
    leaked = true;
  });

  // A real clinic-A notification is emitted to the notif:org_A room.
  await notificationService.emit({ clinicId: 'org_A', actorId: 'sys', actorRole: 'owner' }, { type: 'other', message: 'PHI: prescription for Jane Doe' });
  await delay(300);

  assert.equal(leaked, false, 'forged/unauthenticated socket received NO cross-tenant notification');
  client.close();
  console.log('  ✓ [fix] socket staff rooms require a verified identity — no cross-tenant leak');
});
