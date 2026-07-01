# clinic-api

Express + Mongoose backend for the Clinic Management SaaS. **Phase 0 (foundation) only.**

Multi-tenant: one deployment serves many clinics. Each clinic is a **Clerk Organization**;
the org id IS the `clinicId`, and the org role is the staff role (owner / doctor / receptionist).

## Stack
Node + Express + Mongoose (MongoDB) · Clerk (Organizations = clinics) · plan gating by subscription.

## Project structure
```
src/
  config/
    env.js        # env loading + validation (refuses DEV_AUTH in production)
    db.js         # mongoose connection
    plans.js      # PLAN -> FEATURE map + LIMITS (single source of truth, hard rule 5)
    roles.js      # staff roles + Clerk org-role normalization (hard rule 4)
  models/
    plugins.js    # clinicScoped / softDeletable / branchAware schema plugins
    Clinic.js Staff.js Branch.js Patient.js AuditLog.js Counter.js
    index.js
  lib/
    TenantRepository.js   # ★ shared tenant data layer — rules 1, 6, 7 live here
    sequence.js     # atomic per-clinic counters (race-safe patient codes etc.)
  middleware/
    auth.js          # Clerk session -> req.ctx {clinicId,role,userId} + req.clinic
    requireRole.js   # RBAC guard (hard rule 4)
    requireFeature.js# plan gate -> 403 upgrade_required (hard rule 5)
    errorHandler.js
  controllers/patientController.js
  services/patientService.js   # ★ reference feature: uses the tenant repo correctly
  routes/ index.js patientRoutes.js meRoutes.js
  app.js          # express app factory (mounts Clerk + routes)
  index.js        # server bootstrap
tests/tenant.test.js  # proves tenant isolation / soft delete / audit log
```

## The hard rules and where they live
| Rule | Where enforced |
|------|----------------|
| 1. Tenant isolation | `TenantRepository` injects `clinicId` on every query; missing clinicId throws |
| 4. RBAC | `requireRole(...)` on every protected route; roles from Clerk org role |
| 5. Plan gating | `config/plans.js` + `requireFeature('KEY')` (wired; no Phase 0 route gated) |
| 6. Soft delete | `TenantRepository` excludes `deletedAt != null`; delete sets `deletedAt`/`deletedBy` |
| 7. Audit log | `TenantRepository` writes `auditLogs` on create/update/delete |
| 8. Branch-aware | `branchAware` plugin adds `branchId` to operational docs (Phase 1+) |

## ★ Using the tenant data layer (do this for EVERY feature)
Never touch a tenant model directly. Always go through the repository:

```js
const { tenantRepo } = require('../lib/TenantRepository');
const { Patient } = require('../models');

const repo = tenantRepo(Patient, req.ctx);   // req.ctx = { clinicId, actorId, actorRole }

await repo.create({ name, phone });           // clinicId injected, audit written
await repo.find({ phone });                   // auto clinic-scoped + soft-delete excluded
await repo.findById(id);
await repo.updateById(id, { name });          // audit before/after
await repo.softDeleteById(id);                // deletedAt/deletedBy + audit
await repo.find({}, { includeDeleted: true }); // opt-in to see soft-deleted (admin/restore)
```

The repository **ignores any `clinicId` you pass** and always uses `req.ctx.clinicId`.
A repo built without a `clinicId` throws — a tenant query is never a wildcard.

## Setup & run
```bash
npm install
cp .env.example .env       # fill in MONGODB_URI + Clerk keys (or set DEV_AUTH=true)
npm run dev                # nodemon
# or
npm start
```

### Dev without Clerk (local only)
Set `DEV_AUTH=true` with `NODE_ENV` set to `development` or `test`. The auth
middleware then reads identity from headers so you can exercise the API:
```
x-dev-clinic-id: org_dev_clinic_a
x-dev-role:      owner            # owner | doctor | receptionist
x-dev-user-id:   user_dev_123
```
**Fail-closed:** the app refuses to boot if `DEV_AUTH=true` while `NODE_ENV` is
anything other than `development`/`test` (production, staging, prod, …) — the
bypass can never be reached in a remote/shared environment.

### Endpoints (Phase 0)
```
GET    /api/health                      # public
GET    /api/me                          # who am I / which clinic / role
GET    /api/me/plan                     # plan + resolved feature flags + limits
GET    /api/patients?search=&limit=&skip=   # owner|doctor|receptionist
GET    /api/patients?includeDeleted=true    # OWNER ONLY (view soft-deleted)
POST   /api/patients                    # owner|receptionist (patientCode auto-generated)
GET    /api/patients/:id                # owner|doctor|receptionist
PATCH  /api/patients/:id                # owner|doctor|receptionist
DELETE /api/patients/:id                # owner only (soft delete)
```

## Tests / Phase 0 proof
```bash
npm test     # node --test + mongodb-memory-server (downloads a mongod binary on first run)
```
Proves: (a) tenant isolation, (b) soft delete, (c) audit log — see `tests/tenant.test.js`.

## NOT in Phase 0
Appointments, queue, reminders, billing, prescriptions, reports, website builder, AI —
all Phase 1+. The plan map lists their feature keys so they slot in without re-plumbing.
