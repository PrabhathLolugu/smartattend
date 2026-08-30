-- Migration: Support GPS-flagged attendance (no-block policy)
-- Adds gps_flag column, expands method CHECK, expands override status CHECK

-- 1. Add gps_flag column to attendance_records (nullable text — null means clean GPS)
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS gps_flag TEXT;

-- 2. Drop the old method CHECK constraint and recreate it with 'gps_flagged' included
ALTER TABLE public.attendance_records
  DROP CONSTRAINT IF EXISTS attendance_records_method_check;

ALTER TABLE public.attendance_records
  ADD CONSTRAINT attendance_records_method_check
  CHECK (method IN ('gps', 'gps_flagged', 'override_code', 'manual', 'instructor_approved'));

-- 3. Drop the old gps_override_requests status CHECK and recreate with 'auto_allowed' included
ALTER TABLE public.gps_override_requests
  DROP CONSTRAINT IF EXISTS gps_override_requests_status_check;

ALTER TABLE public.gps_override_requests
  ADD CONSTRAINT gps_override_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'auto_allowed'));
