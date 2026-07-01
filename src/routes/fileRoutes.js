'use strict';

const express = require('express');
const ctrl = require('../controllers/fileController');

/**
 * Signed file-bytes route. Mounted at /api/files BEFORE the Clerk-protected API,
 * because it authorizes via the signed token in the query string (so the URL works
 * in an <img>/<a>), not a Bearer header. There is no public/unsigned access path.
 */
const router = express.Router();
router.get('/report/:id', ctrl.streamReport);

module.exports = router;
