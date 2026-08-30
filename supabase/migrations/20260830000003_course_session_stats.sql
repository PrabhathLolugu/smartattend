CREATE OR REPLACE FUNCTION public.get_course_session_stats(p_course_name TEXT)
RETURNS TABLE (
  session_id UUID,
  course_name TEXT,
  session_date DATE,
  session_type TEXT,
  group_filter TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  present_count BIGINT,
  excused_count BIGINT,
  manual_count BIGINT,
  override_count BIGINT,
  gps_clean_count BIGINT,
  gps_flagged_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT 
    s.id AS session_id,
    s.course_name,
    s.session_date,
    s.session_type,
    s.group_filter,
    s.status,
    s.created_at,
    COUNT(CASE WHEN ar.status IN ('present', 'manual', 'override') THEN 1 END) AS present_count,
    COUNT(CASE WHEN ar.status = 'excused' THEN 1 END) AS excused_count,
    COUNT(CASE WHEN ar.status = 'manual' OR ar.method = 'manual' THEN 1 END) AS manual_count,
    COUNT(CASE WHEN ar.status = 'override' OR ar.method IN ('override_code', 'instructor_approved', 'gps_flagged') THEN 1 END) AS override_count,
    COUNT(CASE WHEN ar.method = 'gps' THEN 1 END) AS gps_clean_count,
    COUNT(CASE WHEN ar.method = 'gps_flagged' THEN 1 END) AS gps_flagged_count
  FROM public.sessions s
  LEFT JOIN public.attendance_records ar ON ar.session_id = s.id
  WHERE s.course_name ILIKE p_course_name
  GROUP BY s.id, s.course_name, s.session_date, s.session_type, s.group_filter, s.status, s.created_at
  ORDER BY s.session_date ASC, s.created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_course_session_stats(TEXT) TO anon, authenticated, service_role;
