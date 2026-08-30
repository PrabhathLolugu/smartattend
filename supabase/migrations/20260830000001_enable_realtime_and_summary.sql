-- Migration: Enable Realtime Publication and Real-Time Attendance Summary
-- File: 20260830000001_enable_realtime_and_summary.sql

-- 1. Configure Replica Identity for Realtime tracking
ALTER TABLE IF EXISTS public.sessions REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS public.attendance_records REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS public.students REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS public.gps_override_requests REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS public.course_settings REPLICA IDENTITY FULL;

-- 2. Add tables to Supabase Realtime publication safely
DO $$
BEGIN
  -- Add sessions if not already in publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
  END IF;

  -- Add attendance_records if not already in publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'attendance_records'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_records;
  END IF;

  -- Add students if not already in publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'students'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.students;
  END IF;

  -- Add gps_override_requests if not already in publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'gps_override_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gps_override_requests;
  END IF;

  -- Add course_settings if not already in publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'course_settings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.course_settings;
  END IF;
END $$;

-- 3. Replace student_attendance_summary with robust real-time & parallel session support
DROP FUNCTION IF EXISTS public.student_attendance_summary(TEXT);
CREATE OR REPLACE FUNCTION public.student_attendance_summary(p_course_name TEXT)
RETURNS TABLE (
  student_id UUID,
  roll_number TEXT,
  name TEXT,
  role_type TEXT,
  department TEXT,
  program TEXT,
  group_label TEXT,
  present_count BIGINT,
  excused_count BIGINT,
  manual_count BIGINT,
  override_count BIGINT,
  total_sessions BIGINT,
  attendance_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH course_sessions AS (
    SELECT s.id, s.group_filter, s.round_id, s.status
    FROM public.sessions s
    WHERE s.course_name ILIKE p_course_name
  ),
  student_records AS (
    SELECT 
      ar.student_id,
      ar.roll_number,
      ar.session_id,
      ar.status,
      ar.method,
      cs.round_id,
      cs.group_filter,
      cs.status AS session_status
    FROM public.attendance_records ar
    JOIN course_sessions cs ON cs.id = ar.session_id
  ),
  session_counts AS (
    SELECT 
      st.id AS student_id,
      COUNT(DISTINCT cs.id)::BIGINT AS total_sessions
    FROM public.students st
    CROSS JOIN course_sessions cs
    WHERE st.status = 'active'
      AND (cs.group_filter IS NULL OR cs.group_filter = st.group_label)
    GROUP BY st.id
  ),
  student_stats AS (
    SELECT 
      st.id AS student_id,
      st.roll_number,
      st.name,
      st.role_type,
      st.department,
      st.program,
      st.group_label,
      COUNT(DISTINCT CASE WHEN sr.status IN ('present', 'manual', 'override') THEN sr.session_id END)::BIGINT AS present_count,
      COUNT(DISTINCT CASE WHEN sr.status = 'excused' THEN sr.session_id END)::BIGINT AS excused_count,
      COUNT(DISTINCT CASE WHEN sr.method = 'manual' OR sr.status = 'manual' THEN sr.session_id END)::BIGINT AS manual_count,
      COUNT(DISTINCT CASE WHEN sr.method IN ('override_code', 'instructor_approved', 'gps_flagged') OR sr.status = 'override' THEN sr.session_id END)::BIGINT AS override_count
    FROM public.students st
    LEFT JOIN student_records sr ON (sr.student_id = st.id OR UPPER(sr.roll_number) = UPPER(st.roll_number))
    WHERE st.status = 'active'
    GROUP BY st.id, st.roll_number, st.name, st.role_type, st.department, st.program, st.group_label
  )
  SELECT 
    ss.student_id,
    ss.roll_number,
    ss.name,
    ss.role_type,
    ss.department,
    ss.program,
    ss.group_label,
    ss.present_count,
    ss.excused_count,
    ss.manual_count,
    ss.override_count,
    GREATEST(COALESCE(sc.total_sessions, 0), ss.present_count)::BIGINT AS total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(sc.total_sessions, 0), ss.present_count) = 0 THEN 0.0
      ELSE ROUND((ss.present_count::NUMERIC / GREATEST(sc.total_sessions, ss.present_count)::NUMERIC) * 100, 1)
    END AS attendance_percentage
  FROM student_stats ss
  LEFT JOIN session_counts sc ON sc.student_id = ss.student_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
