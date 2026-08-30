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

console.log('=== ALL SUSPICIOUS / NON-STANDARD STUDENTS ===');
for (const s of allStudents) {
  const isStd = /^(B\d{5}|IM\d{5}|UD\d{5}|DD\d{5}|D\d{5}|B23\d{3})$/i.test(s.roll_number);
  if (!isStd) {
    const recs = allRecords.filter(r => r.student_id === s.id || r.roll_number === s.roll_number);
    console.log(`Student ID: ${s.id}, Roll: "${s.roll_number}", Name: "${s.name}", Email: "${s.email}", Group: "${s.group_label}", Records: ${recs.length}`);
    for (const r of recs) {
      console.log(`   -> Session ${r.session_date} [${r.course_name} / ${r.session_type}] Status: ${r.status}, Method: ${r.method}`);
    }
  }
}

console.log('\n=== DUPLICATE NAMES IN STUDENTS TABLE ===');
const byName = {};
for (const s of allStudents) {
  const n = s.name.toLowerCase().trim();
  if (!byName[n]) byName[n] = [];
  byName[n].push(s);
}
for (const [name, list] of Object.entries(byName)) {
  if (list.length > 1) {
    console.log(`Name: "${name}" (${list.length} entries):`);
    for (const s of list) {
      const recs = allRecords.filter(r => r.student_id === s.id || r.roll_number === s.roll_number);
      console.log(`   ID: ${s.id}, Roll: "${s.roll_number}", Email: "${s.email}", Group: "${s.group_label}", Records: ${recs.length}`);
      for (const r of recs) {
        console.log(`      -> Session ${r.session_date} [${r.course_name} / ${r.session_type}] Status: ${r.status}, Method: ${r.method}`);
      }
    }
  }
}

console.log('\n=== DUPLICATE EMAILS IN STUDENTS TABLE ===');
const byEmail = {};
for (const s of allStudents) {
  if (!s.email) continue;
  const e = s.email.toLowerCase().trim();
  if (!byEmail[e]) byEmail[e] = [];
  byEmail[e].push(s);
}
for (const [email, list] of Object.entries(byEmail)) {
  if (list.length > 1) {
    console.log(`Email: "${email}" (${list.length} entries):`);
    for (const s of list) {
      const recs = allRecords.filter(r => r.student_id === s.id);
      console.log(`   ID: ${s.id}, Roll: "${s.roll_number}", Name: "${s.name}", Group: "${s.group_label}", Records: ${recs.length}`);
    }
  }
}

await client.end();
