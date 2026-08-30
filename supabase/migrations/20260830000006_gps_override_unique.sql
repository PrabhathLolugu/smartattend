-- Migration: Add unique constraint on (session_id, student_id) for gps_override_requests
-- Ensures one override log entry per student per session and prevents duplicate submissions

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gps_override_requests_session_student_uniq'
  ) THEN
    ALTER TABLE public.gps_override_requests
      ADD CONSTRAINT gps_override_requests_session_student_uniq
      UNIQUE (session_id, student_id);
  END IF;
END $$;
