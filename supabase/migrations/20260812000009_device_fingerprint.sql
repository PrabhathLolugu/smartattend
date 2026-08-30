-- Device fingerprint: one device per session anti-proxy enforcement
-- Adds device_fingerprint to attendance_records and gps_override_requests.
-- A partial unique index (WHERE device_fingerprint IS NOT NULL) enforces one
-- submission per browser/device per session without breaking existing rows
-- (which will have NULL) or manual records inserted by staff.

-- ── attendance_records ───────────────────────────────────────────────────────
alter table public.attendance_records
  add column if not exists device_fingerprint text;

-- Non-unique index for device fingerprint lookup
create index if not exists attendance_records_device_uniq
  on public.attendance_records (session_id, device_fingerprint)
  where device_fingerprint is not null;

create index if not exists attendance_records_device_idx
  on public.attendance_records (device_fingerprint);

-- ── gps_override_requests ────────────────────────────────────────────────────
alter table public.gps_override_requests
  add column if not exists device_fingerprint text;

-- Index for device fingerprint
create index if not exists gps_override_requests_device_uniq
  on public.gps_override_requests (session_id, device_fingerprint)
  where device_fingerprint is not null;

