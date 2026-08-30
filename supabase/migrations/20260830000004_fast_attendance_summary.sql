CREATE OR REPLACE FUNCTION public.student_attendance_summary(p_course_name text)
RETURNS TABLE(
  student_id uuid,
  roll_number text,
  name text,
  department text,
  program text,
  group_label text,
  present_count bigint,
  excused_count bigint,
  manual_count bigint,
  override_count bigint,
  total_sessions bigint,
  attendance_percentage numeric,
  theory_present_count bigint,
  theory_total_sessions bigint,
  theory_percentage numeric,
  practical_present_count bigint,
  practical_total_sessions bigint,
  practical_percentage numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH course_sessions AS (
    SELECT 
      s.id, 
      s.group_filter, 
      (LOWER(s.session_type) LIKE '%yoga%' OR LOWER(s.session_type) LIKE '%practical%' OR LOWER(s.session_type) LIKE '%lab%' OR LOWER(s.session_type) LIKE '%activity%') AS is_practical
    FROM public.sessions s
    WHERE s.course_name ILIKE p_course_name
  ),
  general_session_counts AS (
    SELECT 
      COUNT(*)::BIGINT AS general_total,
      COUNT(CASE WHEN NOT is_practical THEN 1 END)::BIGINT AS general_theory,
      COUNT(CASE WHEN is_practical THEN 1 END)::BIGINT AS general_practical
    FROM course_sessions
    WHERE group_filter IS NULL
  ),
  group_session_counts AS (
    SELECT 
      group_filter,
      COUNT(*)::BIGINT AS grp_total,
      COUNT(CASE WHEN NOT is_practical THEN 1 END)::BIGINT AS grp_theory,
      COUNT(CASE WHEN is_practical THEN 1 END)::BIGINT AS grp_practical
    FROM course_sessions
    WHERE group_filter IS NOT NULL
    GROUP BY group_filter
  ),
  student_attended AS (
    SELECT 
      ar.student_id,
      COUNT(DISTINCT CASE WHEN ar.status IN ('present', 'manual', 'override') THEN ar.session_id END)::BIGINT AS present_count,
      COUNT(DISTINCT CASE WHEN ar.status = 'excused' THEN ar.session_id END)::BIGINT AS excused_count,
      COUNT(DISTINCT CASE WHEN ar.method = 'manual' OR ar.status = 'manual' THEN ar.session_id END)::BIGINT AS manual_count,
      COUNT(DISTINCT CASE WHEN ar.status = 'override' OR ar.method IN ('override_code', 'instructor_approved', 'gps_flagged') THEN ar.session_id END)::BIGINT AS override_count,
      COUNT(DISTINCT CASE WHEN ar.status IN ('present', 'manual', 'override') AND NOT cs.is_practical THEN ar.session_id END)::BIGINT AS theory_present_count,
      COUNT(DISTINCT CASE WHEN ar.status IN ('present', 'manual', 'override') AND cs.is_practical THEN ar.session_id END)::BIGINT AS practical_present_count
    FROM public.attendance_records ar
    JOIN course_sessions cs ON cs.id = ar.session_id
    WHERE ar.student_id IS NOT NULL
    GROUP BY ar.student_id
  )
  SELECT 
    st.id AS student_id,
    st.roll_number,
    st.name,
    st.department,
    st.program,
    st.group_label,
    COALESCE(sa.present_count, 0)::BIGINT AS present_count,
    COALESCE(sa.excused_count, 0)::BIGINT AS excused_count,
    COALESCE(sa.manual_count, 0)::BIGINT AS manual_count,
    COALESCE(sa.override_count, 0)::BIGINT AS override_count,
    GREATEST(COALESCE(gc.general_total, 0) + COALESCE(gsc.grp_total, 0), COALESCE(sa.present_count, 0))::BIGINT AS total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(gc.general_total, 0) + COALESCE(gsc.grp_total, 0), COALESCE(sa.present_count, 0)) = 0 THEN 0.0
      ELSE ROUND((COALESCE(sa.present_count, 0)::NUMERIC / GREATEST(COALESCE(gc.general_total, 0) + COALESCE(gsc.grp_total, 0), COALESCE(sa.present_count, 0))::NUMERIC) * 100, 1)
    END AS attendance_percentage,
    COALESCE(sa.theory_present_count, 0)::BIGINT AS theory_present_count,
    GREATEST(COALESCE(gc.general_theory, 0) + COALESCE(gsc.grp_theory, 0), COALESCE(sa.theory_present_count, 0))::BIGINT AS theory_total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(gc.general_theory, 0) + COALESCE(gsc.grp_theory, 0), COALESCE(sa.theory_present_count, 0)) = 0 THEN 0.0
      ELSE ROUND((COALESCE(sa.theory_present_count, 0)::NUMERIC / GREATEST(COALESCE(gc.general_theory, 0) + COALESCE(gsc.grp_theory, 0), COALESCE(sa.theory_present_count, 0))::NUMERIC) * 100, 1)
    END AS theory_percentage,
    COALESCE(sa.practical_present_count, 0)::BIGINT AS practical_present_count,
    GREATEST(COALESCE(gc.general_practical, 0) + COALESCE(gsc.grp_practical, 0), COALESCE(sa.practical_present_count, 0))::BIGINT AS practical_total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(gc.general_practical, 0) + COALESCE(gsc.grp_practical, 0), COALESCE(sa.practical_present_count, 0)) = 0 THEN 0.0
      ELSE ROUND((COALESCE(sa.practical_present_count, 0)::NUMERIC / GREATEST(COALESCE(gc.general_practical, 0) + COALESCE(gsc.grp_practical, 0), COALESCE(sa.practical_present_count, 0))::NUMERIC) * 100, 1)
    END AS practical_percentage
  FROM public.students st
  CROSS JOIN general_session_counts gc
  LEFT JOIN group_session_counts gsc ON gsc.group_filter = st.group_label
  LEFT JOIN student_attended sa ON sa.student_id = st.id
  WHERE st.status = 'active'
  ORDER BY st.roll_number ASC;
$$;

GRANT EXECUTE ON FUNCTION public.student_attendance_summary(TEXT) TO anon, authenticated, service_role;
