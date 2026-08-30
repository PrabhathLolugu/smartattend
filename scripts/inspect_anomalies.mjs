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

console.log('=== 1. ALL STUDENTS IN DB ===');
const { rows: students } = await client.query('SELECT id, roll_number, name, email, department, program, group_label, status, created_at FROM public.students ORDER BY roll_number ASC;');
console.log(`Total students: ${students.length}`);

// Check student roll_numbers that do not match standard patterns
const suspiciousStudents = [];
for (const s of students) {
  const roll = (s.roll_number || '').trim();
  const isStandard = /^(B\d{5}|IM\d{5}|UD\d{5}|DD\d{5}|D\d{5}|B23\d{3})$/i.test(roll);
  if (!isStandard) {
    suspiciousStudents.push(s);
  }
}
console.log(`\nSuspicious / Non-standard roll numbers in students table (${suspiciousStudents.length}):`);
console.table(suspiciousStudents);

// Check duplicate names or emails in students table
const byName = new Map();
const byEmail = new Map();

for (const s of students) {
  const cleanName = (s.name || '').trim().toLowerCase();
  const cleanEmail = (s.email || '').trim().toLowerCase();
  
  if (cleanName) {
    if (!byName.has(cleanName)) byName.set(cleanName, []);
    byName.get(cleanName).push(s);
  }
  if (cleanEmail) {
    if (!byEmail.has(cleanEmail)) byEmail.set(cleanEmail, []);
    byEmail.get(cleanEmail).push(s);
  }
}

console.log('\n=== 2. STUDENTS WITH SAME NAME ===');
for (const [name, list] of byName.entries()) {
  if (list.length > 1) {
    console.log(`Name: "${name}" has ${list.length} records:`, list.map(x => ({ id: x.id, roll: x.roll_number, email: x.email, group: x.group_label })));
  }
}

console.log('\n=== 3. STUDENTS WITH SAME EMAIL ===');
for (const [email, list] of byEmail.entries()) {
  if (list.length > 1) {
    console.log(`Email: "${email}" has ${list.length} records:`, list.map(x => ({ id: x.id, roll: x.roll_number, name: x.name })));
  }
}

// Check attendance records associated with suspicious students
console.log('\n=== 4. ATTENDANCE RECORDS FOR SUSPICIOUS STUDENTS ===');
if (suspiciousStudents.length > 0) {
  const ids = suspiciousStudents.map(s => s.id);
  const rolls = suspiciousStudents.map(s => s.roll_number);
  const { rows: susAtt } = await client.query(`
    SELECT ar.id, ar.session_id, ar.student_id, ar.roll_number as ar_roll, ar.status, ar.method, ar.marked_at, s.roll_number as stu_roll, s.name, sess.session_date::text, sess.course_name, sess.session_type
    FROM public.attendance_records ar
    LEFT JOIN public.students s ON s.id = ar.student_id
    JOIN public.sessions sess ON sess.id = ar.session_id
    WHERE ar.student_id = ANY($1) OR ar.roll_number = ANY($2);
  `, [ids, rolls]);
  console.log(`Found ${susAtt.length} attendance records associated with suspicious students/rolls:`);
  console.table(susAtt);
}

// Check attendance records where ar.roll_number does not match standard pattern or ar.student_id is null
console.log('\n=== 5. ATTENDANCE RECORDS WITH NON-STANDARD ROLL OR ORPHANED STUDENT_ID ===');
const { rows: orphanAtt } = await client.query(`
  SELECT ar.id, ar.session_id, ar.student_id, ar.roll_number, ar.status, ar.method, ar.marked_at, s.name as stu_name, sess.session_date::text, sess.course_name, sess.session_type
  FROM public.attendance_records ar
  LEFT JOIN public.students s ON s.id = ar.student_id
  JOIN public.sessions sess ON sess.id = ar.session_id
  WHERE s.id IS NULL OR ar.roll_number !~* '^(B|IM|UD|DD|D)[0-9]{4,6}$';
`);
console.log(`Orphan / Non-standard attendance records (${orphanAtt.length}):`);
console.table(orphanAtt);

// Check if any student has duplicate attendances in the same session (e.g. by student_id or roll_number)
console.log('\n=== 6. DUPLICATE ATTENDANCES PER SESSION ===');
const { rows: dupAtt } = await client.query(`
  SELECT session_id, student_id, count(*)
  FROM public.attendance_records
  GROUP BY session_id, student_id
  HAVING count(*) > 1;
`);
console.log(`Duplicate (session_id, student_id) in attendance_records: ${dupAtt.length}`);
if (dupAtt.length > 0) console.table(dupAtt);

const { rows: dupRollAtt } = await client.query(`
  SELECT session_id, UPPER(roll_number) as roll, count(*)
  FROM public.attendance_records
  GROUP BY session_id, UPPER(roll_number)
  HAVING count(*) > 1;
`);
console.log(`Duplicate (session_id, roll_number) in attendance_records: ${dupRollAtt.length}`);
if (dupRollAtt.length > 0) console.table(dupRollAtt);

// Check attendance records where student_id.roll_number != ar.roll_number
console.log('\n=== 7. ATTENDANCE RECORDS WHERE ar.roll_number != student.roll_number ===');
const { rows: mismatchRoll } = await client.query(`
  SELECT ar.id, ar.session_id, ar.student_id, ar.roll_number as ar_roll, s.roll_number as stu_roll, s.name as stu_name, sess.session_date::text, sess.course_name
  FROM public.attendance_records ar
  JOIN public.students s ON s.id = ar.student_id
  JOIN public.sessions sess ON sess.id = ar.session_id
  WHERE UPPER(TRIM(ar.roll_number)) != UPPER(TRIM(s.roll_number));
`);
console.log(`Roll number mismatches between attendance_records and students: ${mismatchRoll.length}`);
if (mismatchRoll.length > 0) console.table(mismatchRoll);

await client.end();
