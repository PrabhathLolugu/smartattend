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

  console.log('=== 1. GROUP ROSTER COUNTS ===');
  const { rows: groupCounts } = await client.query(`
    SELECT COALESCE(group_label, 'Unassigned') as grp, count(*) as count 
    FROM public.students 
    WHERE status = 'active' 
    GROUP BY group_label 
    ORDER BY grp;
  `);
  console.log(JSON.stringify(groupCounts, null, 2));

  console.log('\n=== 2. ALL SESSIONS FOR IC181 WITH ATTENDANCE COUNTS & TARGET ROSTER ===');
  const { rows: sessions } = await client.query(`
    SELECT 
      s.id,
      s.session_date,
      s.session_type,
      s.group_filter,
      s.status,
      count(ar.id) as present_count
    FROM public.sessions s
    LEFT JOIN public.attendance_records ar ON ar.session_id = s.id AND ar.status IN ('present', 'manual', 'override')
    WHERE s.course_name ILIKE 'IC181'
    GROUP BY s.id, s.session_date, s.session_type, s.group_filter, s.status
    ORDER BY s.session_date ASC, s.created_at ASC;
  `);
  
  const totalStudents = 388;
  const groupMap = new Map(groupCounts.map(g => [g.grp, Number(g.count)]));

  const enrichedSessions = sessions.map(s => {
    const isPractical = /yoga|yiga|practical|pract|lab|activity/i.test(s.session_type);
    const target = s.group_filter ? (groupMap.get(s.group_filter) || 45) : totalStudents;
    const present = Number(s.present_count);
    const pct = target > 0 ? Math.min(100, Math.round((present / target) * 1000) / 10) : 0;
    return {
      date: s.session_date.toISOString().slice(0, 10),
      type: s.session_type,
      category: isPractical ? 'Practical/Yoga' : 'Theory',
      group: s.group_filter || 'All',
      present,
      target,
      pct: `${pct}%`
    };
  });

  console.log(JSON.stringify(enrichedSessions, null, 2));

  console.log('\n=== 3. GROUP-WISE YOGA/PRACTICAL SUMMARY ===');
  const { rows: groupYogaStats } = await client.query(`
    WITH yoga_sessions AS (
      SELECT s.id, s.group_filter
      FROM public.sessions s
      WHERE s.course_name ILIKE 'IC181'
        AND (s.session_type ILIKE '%yoga%' OR s.session_type ILIKE '%practical%' OR s.session_type ILIKE '%lab%')
    ),
    group_students AS (
      SELECT st.id, st.group_label, st.roll_number
      FROM public.students st
      WHERE st.status = 'active' AND st.group_label IS NOT NULL
    ),
    student_yoga_attended AS (
      SELECT 
        gs.group_label,
        gs.id as student_id,
        count(DISTINCT ar.session_id) as attended_count
      FROM group_students gs
      LEFT JOIN public.attendance_records ar ON ar.student_id = gs.id AND ar.session_id IN (SELECT id FROM yoga_sessions) AND ar.status IN ('present', 'manual', 'override')
      GROUP BY gs.group_label, gs.id
    )
    SELECT 
      group_label,
      count(*) as student_count,
      round(avg(attended_count)::numeric, 2) as avg_attended_sessions
    FROM student_yoga_attended
    GROUP BY group_label
    ORDER BY group_label;
  `);
  console.log(JSON.stringify(groupYogaStats, null, 2));

} catch (err) {
  console.error('Error:', err);
} finally {
  await client.end();
}
