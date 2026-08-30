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
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
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

await client.connect();

const { rows: allStudents } = await client.query('SELECT * FROM public.students ORDER BY roll_number ASC;');
const { rows: allRecords } = await client.query(`
  SELECT ar.*, s.name as student_name, s.roll_number as student_roll, sess.session_date::text, sess.session_type, sess.course_name
  FROM public.attendance_records ar
  LEFT JOIN public.students s ON s.id = ar.student_id
  LEFT JOIN public.sessions sess ON sess.id = ar.session_id
  ORDER BY sess.session_date ASC, ar.marked_at ASC;
`);

console.log('=== ALL 398 STUDENTS LIST WITH RECORDS COUNT ===');
const nonStandard = [];
for (const s of allStudents) {
  const recs = allRecords.filter(r => r.student_id === s.id || r.roll_number === s.roll_number);
  const isStd = /^(B26\d{3}|IM26\d{3}|UD26\d{3}|DD26\d{3}|D26\d{3}|B23\d{3})$/i.test(s.roll_number);
  if (!isStd || recs.length === 0 || s.roll_number.length < 6 || s.roll_number.length > 6) {
    nonStandard.push({
      id: s.id,
      roll: s.roll_number,
      name: s.name,
      email: s.email,
      group: s.group_label,
      isStd,
      records: recs.length,
      recordSessions: recs.map(r => `${r.session_date} (${r.course_name}) [${r.status}/${r.method}]`),
    });
  }
}

console.log(JSON.stringify(nonStandard, null, 2));

await client.end();
