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

try {
  await client.connect();

  console.log('Creating get_course_session_stats RPC function...');

  await client.query(`
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
  `);

  console.log('Testing get_course_session_stats for IC181...');
  const { rows } = await client.query(`SELECT * FROM public.get_course_session_stats('IC181')`);
  console.log('Found sessions count:', rows.length);
  console.log(JSON.stringify(rows.map(r => ({
    date: r.session_date.toISOString().slice(0, 10),
    type: r.session_type,
    group: r.group_filter,
    present: r.present_count,
    manual: r.manual_count,
    override: r.override_count
  })), null, 2));

} catch (err) {
  console.error('Error:', err);
} finally {
  await client.end();
}
