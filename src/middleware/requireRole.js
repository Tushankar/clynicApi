'use strict';

const AppError = require('../utils/AppError');
const { ALL_ROLES } = require('../config/roles');

/**
 * RBAC guard (hard rule 4). Deny by default.
 *
 * Usage:
 *   router.post('/patients', requireRole('owner', 'receptionist'), handler)
 *   router.delete('/patients/:id', requireRole('owner'), handler)
 *
 * Must run AFTER attachAuthContext (it reads req.auth.role, which is the
 * normalized Clerk org role for the active clinic).
 */
function requireRole(...allowed) {
  const allowedSet = new Set(allowed.flat());
  // Fail loudly on a typo'd role at wiring time rather than silently locking everyone out.
  for (const r of allowedSet) {
    if (!ALL_ROLES.includes(r)) {
      throw new Error(`requireRole: unknown role "${r}" (valid: ${ALL_ROLES.join(', ')})`);
    }
  }

  return function roleGuard(req, res, next) {
    const role = req.auth?.role;
    if (!role) {
      return next(new AppError(403, 'No clinic role assigned to this user'));
    }
    if (!allowedSet.has(role)) {
      return next(
        new AppError(403, 'Insufficient role', {
          requiredRoles: [...allowedSet],
          yourRole: role,
        })
      );
    }
    next();
  };
}

module.exports = { requireRole };
