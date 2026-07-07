# Backup & recovery runbook

Irreplaceable medical records live in MongoDB. This is the minimum trust bar before real patient
data goes in. Two scripts plus a schedule = a real answer to "what happens if the server dies?"

## Scripts

| Script | What it does |
|--------|--------------|
| `node scripts/backup.js`  | `mongodump` the whole DB → one timestamped `.archive.gz` in `BACKUP_DIR`, then prune to `BACKUP_RETENTION` newest. |
| `node scripts/restore.js <archive.gz> --yes` | `mongorestore --drop` that archive into `MONGODB_URI`. Refuses to run without `--yes`. |

Both need the **MongoDB Database Tools** (`mongodump` / `mongorestore`) on PATH —
<https://www.mongodb.com/docs/database-tools/installation/>.

## Env

| Var | Default | Meaning |
|-----|---------|---------|
| `MONGODB_URI` | app default | Source (backup) / target (restore) DB |
| `BACKUP_DIR` | `./backups` | Where archives are written |
| `BACKUP_RETENTION` | `14` | How many archives to keep |

## Schedule it (pick one)

**cron (Linux):** daily 02:30, keep 30 days
```cron
30 2 * * * cd /app/clynicApi && BACKUP_RETENTION=30 node scripts/backup.js >> /var/log/clinic-backup.log 2>&1
```

**Windows Task Scheduler:**
```powershell
schtasks /Create /SC DAILY /ST 02:30 /TN clinic-backup ^
  /TR "node C:\path\to\clynicApi\scripts\backup.js"
```

**Docker:** run from a sidecar/host that has the Database Tools and can reach `mongo:27017`.

## Recovery drill (do this BEFORE go-live)

1. `node scripts/backup.js` → note the archive name.
2. Restore into a scratch DB: `MONGODB_URI=mongodb://127.0.0.1:27017/clinic-restore-test node scripts/restore.js backups/clinic-YYYYMMDD-HHMMSS.archive.gz --yes`
3. Point a throwaway API at `clinic-restore-test` and confirm patients/appointments/invoices are intact.
4. Write down the wall-clock time it took — that's your recovery-time estimate.

## Off-box copies

Archives on the same disk as the DB are not a backup. Copy `BACKUP_DIR` to object storage
(S3/Backblaze/GCS) or a different host on the same schedule. For managed MongoDB (Atlas), enable
its built-in continuous/PITR backups **in addition** to these logical dumps.

## Files, too

`mongodump` covers the database. Uploaded medical **files** (reports, prescription images) live in
the storage backend (`STORAGE_DRIVER`): with `s3`/`cloudinary` they're already durable + versionable
there; with `local` disk, include the storage directory in your file backup. The broadened CSV
export (`/api/export/:entity`, now incl. prescriptions/clinical_notes/lab_requests/reports) gives a
portable, human-readable copy of the record and a manifest of every stored file.
