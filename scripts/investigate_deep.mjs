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
  SELECT ar.*, s.name as student_name, s.roll_number as student_roll, s.email as student_email,
         sess.session_date::text, sess.session_type, sess.course_name
  FROM public.attendance_records ar
  LEFT JOIN public.students s ON s.id = ar.student_id
  LEFT JOIN public.sessions sess ON sess.id = ar.session_id
  ORDER BY sess.session_date ASC, ar.marked_at ASC;
`);

console.log('=== INVESTIGATING SPECIFIC ENTRIES ===');

// Check 194876, 344571, 640655, 861129, 898927
const numericRolls = ['194876', '344571', '640655', '861129', '898927'];
for (const roll of numericRolls) {
  const st = allStudents.find(s => s.roll_number === roll);
  console.log(`Numeric roll ${roll}:`, st);
  // See if name matches any other student
  if (st) {
    const matches = allStudents.filter(s => s.name.toLowerCase().includes(st.name.toLowerCase().split(' ')[0]) && s.id !== st.id);
    console.log(`  Similar name matches for ${st.name}:`, matches.map(m => ({ id: m.id, roll: m.roll_number, name: m.name, email: m.email })));
  }
}

// Check D23293 and D23294
console.log('\n=== D23293 and D23294 ===');
const dStudents = allStudents.filter(s => s.roll_number.startsWith('D23'));
console.table(dStudents);
for (const ds of dStudents) {
  const recs = allRecords.filter(r => r.student_id === ds.id);
  console.log(`Records for ${ds.roll_number} (${ds.name}):`, recs.map(r => ({ session_date: r.session_date, course: r.course_name, type: r.session_type, status: r.status, method: r.method, marked_at: r.marked_at })));
}

// Check if any attendance records exist with NO student_id in public.attendance_records
console.log('\n=== ATTENDANCE RECORDS WITH NULL STUDENT_ID OR INVALID STUDENT_ID ===');
const invalidStudentRecs = allRecords.filter(r => !r.student_id || !allStudents.find(s => s.id === r.student_id));
console.log(`Invalid student_id records: ${invalidStudentRecs.length}`);

// Check all duplicate student pairs in detail
console.log('\n=== DETAILED MAPPING OF DUPLICATES / WRONG ROLLS TO CORRECT STUDENTS ===');
const mappings = [
  { wrongRoll: '26030', correctRoll: 'IM26030', reason: 'Missing IM prefix' },
  { wrongRoll: '26155', correctRoll: 'B26155', reason: 'Missing B prefix' },
  { wrongRoll: '26268', correctRoll: 'B26268', reason: 'Missing B prefix' },
  { wrongRoll: 'B26CE116', correctRoll: 'B26116', reason: 'Contains branch code CE' },
  { wrongRoll: 'B26ME538', correctRoll: 'B26538', reason: 'Contains branch code ME' },
  { wrongRoll: 'B36450', correctRoll: 'B26450', reason: 'Typo in roll number B36 vs B26' },
  { wrongRoll: 'B56261', correctRoll: 'B26561', reason: 'Digits swapped 56 vs 26' },
  { wrongRoll: 'BB26443', correctRoll: 'B26443', reason: 'Double B prefix' },
  { wrongRoll: 'DUTT', correctRoll: 'B26084', reason: 'Name DUTT instead of roll B26084' },
  { wrongRoll: 'JANGIR', correctRoll: 'B26283', reason: 'Name JANGIR instead of roll B26283' },
  { wrongRoll: 'KUMAR', correctRoll: 'B26409', reason: 'Name KUMAR instead of roll B26409' },
  { wrongRoll: 'RITIK', correctRoll: 'B26227', reason: 'Name RITIK instead of roll B26227' },
  { wrongRoll: 'SONI', correctRoll: 'B26271', reason: 'Name SONI instead of roll B26271' },
  { wrongRoll: 'VISHWANATHE', correctRoll: 'B26442', reason: 'Name VISHWANATHE instead of roll B26442' },
  { wrongRoll: 'B2683738826', correctRoll: null, reason: 'False/fake entry (Jdjdn)' },
];

for (const m of mappings) {
  const wrongStu = allStudents.find(s => s.roll_number === m.wrongRoll);
  const correctStu = m.correctRoll ? allStudents.find(s => s.roll_number === m.correctRoll) : null;
  const wrongRecs = wrongStu ? allRecords.filter(r => r.student_id === wrongStu.id) : [];
  const correctRecs = correctStu ? allRecords.filter(r => r.student_id === correctStu.id) : [];

  console.log(`\n------------------------------------------------------------`);
  console.log(`Map: ${m.wrongRoll} -> ${m.correctRoll} (${m.reason})`);
  console.log(`  Wrong Student:`, wrongStu ? { id: wrongStu.id, roll: wrongStu.roll_number, name: wrongStu.name, email: wrongStu.email, group: wrongStu.group_label } : 'NOT FOUND');
  console.log(`  Correct Student:`, correctStu ? { id: correctStu.id, roll: correctStu.roll_number, name: correctStu.name, email: correctStu.email, group: correctStu.group_label } : 'N/A');
  console.log(`  Wrong Student Records (${wrongRecs.length}):`);
  for (const r of wrongRecs) {
    const collidesWithCorrect = correctRecs.some(cr => cr.session_id === r.session_id);
    console.log(`    Session ${r.session_date} [${r.course_name} / ${r.session_type}] Status: ${r.status}, Method: ${r.method}, Marked: ${r.marked_at} (Already marked in correct student: ${collidesWithCorrect})`);
  }
}

await client.end();
