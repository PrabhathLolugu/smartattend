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

const { rows: students } = await client.query('SELECT * FROM public.students ORDER BY roll_number ASC;');
const { rows: attendance } = await client.query(`
  SELECT ar.*, s.name as stu_name, s.roll_number as stu_roll, sess.session_date::text, sess.session_type, sess.course_name
  FROM public.attendance_records ar
  LEFT JOIN public.students s ON s.id = ar.student_id
  LEFT JOIN public.sessions sess ON sess.id = ar.session_id
  ORDER BY sess.session_date, ar.marked_at;
`);

console.log(`Auditing ${students.length} students and ${attendance.length} attendance records...`);

// Let's find every student whose roll number is not normal standard format:
// Valid formats: B26xxx (5-6 chars like B26001..B26599), IM26xxx, UD26xxx, DD26xxx, B23xxx
const nonStandard = students.filter(s => !/^(B26\d{3}|IM26\d{3}|UD26\d{3}|DD26\d{3}|D26\d{3}|B23\d{3})$/i.test(s.roll_number));

console.log('\n--- NON-STANDARD STUDENTS AUDIT ---');
for (const s of nonStandard) {
  const records = attendance.filter(a => a.student_id === s.id || a.roll_number === s.roll_number);
  console.log(`\nStudent: ID=${s.id} | Roll="${s.roll_number}" | Name="${s.name}" | Email="${s.email}" | Status="${s.status}" | Records=${records.length}`);
  for (const r of records) {
    console.log(`   Session [${r.session_date} ${r.course_name} ${r.session_type}] ID=${r.session_id} | Status=${r.status} | Method=${r.method}`);
  }
}

// Let's also check all students to see if any valid-looking roll numbers are duplicates of others (e.g. same name or same email)
console.log('\n--- DUPLICATE NAME/EMAIL AUDIT AMONG STANDARD STUDENTS ---');
const stdStudents = students.filter(s => /^(B26\d{3}|IM26\d{3}|UD26\d{3}|DD26\d{3}|D26\d{3}|B23\d{3})$/i.test(s.roll_number));
const nameMap = new Map();
for (const s of stdStudents) {
  const n = s.name.trim().toLowerCase();
  if (!nameMap.has(n)) nameMap.set(n, []);
  nameMap.get(n).push(s);
}
for (const [name, list] of nameMap.entries()) {
  if (list.length > 1) {
    console.log(`Standard students with duplicate name "${name}":`, list.map(x => ({ id: x.id, roll: x.roll_number, email: x.email, group: x.group_label })));
  }
}

// Check attendance records with orphaned student_id or roll_number mismatch
console.log('\n--- ATTENDANCE RECORDS INTEGRITY CHECK ---');
const orphans = attendance.filter(a => !a.student_id || !students.find(s => s.id === a.student_id));
console.log(`Orphaned attendance records: ${orphans.length}`);

await client.end();
