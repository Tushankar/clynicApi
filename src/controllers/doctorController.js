'use strict';

const asyncHandler = require('../utils/asyncHandler');
const doctorService = require('../services/doctorService');

const list = asyncHandler(async (req, res) => {
  const items = await doctorService.listDoctors(req.ctx, { activeOnly: req.query.activeOnly === 'true' });
  res.json({ items });
});

const me = asyncHandler(async (req, res) => {
  res.json(await doctorService.resolveCurrentDoctor(req.ctx));
});

const dashboard = asyncHandler(async (req, res) => {
  res.json(await doctorService.getDashboard(req.ctx, { doctorId: req.query.doctorId, date: req.query.date }));
});

const staffDirectory = asyncHandler(async (req, res) => {
  res.json({ items: await doctorService.staffDirectory(req.ctx) });
});

const get = asyncHandler(async (req, res) => {
  res.json(await doctorService.getDoctor(req.ctx, req.params.id));
});

const create = asyncHandler(async (req, res) => {
  const doctor = await doctorService.createDoctor(req.ctx, req.clinic?.subscriptionPlan, req.body);
  res.status(201).json(doctor);
});

const update = asyncHandler(async (req, res) => {
  res.json(await doctorService.updateDoctor(req.ctx, req.params.id, req.body, req.clinic?.subscriptionPlan));
});

module.exports = { list, me, dashboard, staffDirectory, get, create, update };
