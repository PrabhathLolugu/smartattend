import { Client } from 'pg';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

function loadEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      env[key] = val;
    }
  }
  return env;
}

const env = {
  ...loadEnv(path.resolve('.env')),
  ...loadEnv(path.resolve('.env.deploy')),
  ...process.env,
};

const ref = env.SUPABASE_PROJECT_REF;
const password = env.SUPABASE_DB_PASSWORD;
const poolerHost = env.SUPABASE_POOLER_HOST || 'aws-0-ap-south-1.pooler.supabase.com';

const client = new Client({
  connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${poolerHost}:5432/postgres`,
});

const sql = `
DROP FUNCTION IF EXISTS public.student_attendance_summary(TEXT);

CREATE OR REPLACE FUNCTION public.student_attendance_summary(p_course_name TEXT)
RETURNS TABLE (
  student_id UUID,
  roll_number TEXT,
  name TEXT,
  department TEXT,
  program TEXT,
  group_label TEXT,
  present_count BIGINT,
  excused_count BIGINT,
  manual_count BIGINT,
  override_count BIGINT,
  total_sessions BIGINT,
  attendance_percentage NUMERIC,
  theory_present_count BIGINT,
  theory_total_sessions BIGINT,
  theory_percentage NUMERIC,
  practical_present_count BIGINT,
  practical_total_sessions BIGINT,
  practical_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH course_sessions AS (
    SELECT 
      s.id, 
      s.session_type,
      s.group_filter, 
      s.round_id, 
      s.status,
      (LOWER(s.session_type) LIKE '%yoga%' OR LOWER(s.session_type) LIKE '%practical%' OR LOWER(s.session_type) LIKE '%lab%' OR LOWER(s.session_type) LIKE '%activity%') AS is_practical
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
      cs.session_type,
      cs.is_practical,
      cs.status AS session_status
    FROM public.attendance_records ar
    JOIN course_sessions cs ON cs.id = ar.session_id
  ),
  session_counts AS (
    SELECT 
      st.id AS student_id,
      COUNT(DISTINCT cs.id)::BIGINT AS total_sessions,
      COUNT(DISTINCT CASE WHEN NOT cs.is_practical THEN cs.id END)::BIGINT AS theory_total_sessions,
      COUNT(DISTINCT CASE WHEN cs.is_practical THEN cs.id END)::BIGINT AS practical_total_sessions
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
      st.department,
      st.program,
      st.group_label,
      COUNT(DISTINCT CASE WHEN sr.status IN ('present', 'manual', 'override') THEN sr.session_id END)::BIGINT AS present_count,
      COUNT(DISTINCT CASE WHEN sr.status = 'excused' THEN sr.session_id END)::BIGINT AS excused_count,
      COUNT(DISTINCT CASE WHEN sr.method = 'manual' OR sr.status = 'manual' THEN sr.session_id END)::BIGINT AS manual_count,
      COUNT(DISTINCT CASE WHEN sr.method IN ('override_code', 'instructor_approved', 'gps_flagged') OR sr.status = 'override' THEN sr.session_id END)::BIGINT AS override_count,
      COUNT(DISTINCT CASE WHEN sr.status IN ('present', 'manual', 'override') AND NOT sr.is_practical THEN sr.session_id END)::BIGINT AS theory_present_count,
      COUNT(DISTINCT CASE WHEN sr.status IN ('present', 'manual', 'override') AND sr.is_practical THEN sr.session_id END)::BIGINT AS practical_present_count
    FROM public.students st
    LEFT JOIN student_records sr ON (sr.student_id = st.id OR UPPER(sr.roll_number) = UPPER(st.roll_number))
    WHERE st.status = 'active'
    GROUP BY st.id, st.roll_number, st.name, st.department, st.program, st.group_label
  )
  SELECT 
    ss.student_id,
    ss.roll_number,
    ss.name,
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
    END AS attendance_percentage,
    ss.theory_present_count,
    GREATEST(COALESCE(sc.theory_total_sessions, 0), ss.theory_present_count)::BIGINT AS theory_total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(sc.theory_total_sessions, 0), ss.theory_present_count) = 0 THEN 0.0
      ELSE ROUND((ss.theory_present_count::NUMERIC / GREATEST(sc.theory_total_sessions, ss.theory_present_count)::NUMERIC) * 100, 1)
    END AS theory_percentage,
    ss.practical_present_count,
    GREATEST(COALESCE(sc.practical_total_sessions, 0), ss.practical_present_count)::BIGINT AS practical_total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(sc.practical_total_sessions, 0), ss.practical_present_count) = 0 THEN 0.0
      ELSE ROUND((ss.practical_present_count::NUMERIC / GREATEST(sc.practical_total_sessions, ss.practical_present_count)::NUMERIC) * 100, 1)
    END AS practical_percentage
  FROM student_stats ss
  LEFT JOIN session_counts sc ON sc.student_id = ss.student_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
`;

try {
  await client.connect();
  console.log('Running SQL fix...');
  await client.query(sql);
  console.log('SQL executed successfully!');

  console.log('\nTesting student_attendance_summary for IC181...');
  const { rows: ic181 } = await client.query("SELECT * FROM public.student_attendance_summary('IC181') LIMIT 5;");
  console.log('IC181 Sample Output:', JSON.stringify(ic181, null, 2));

  console.log('\nTesting student_attendance_summary for General Class...');
  const { rows: gen } = await client.query("SELECT * FROM public.student_attendance_summary('General Class') LIMIT 5;");
  console.log('General Class Sample Output:', JSON.stringify(gen, null, 2));

} catch (err) {
  console.error('Error:', err);
} finally {
  await client.end();
}
