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

const sessionId = '69ad558e-ce59-4480-ab0c-7d30a134f4e2'; // IC181 Theory on 2026-08-19

const studentsToAdd = [
  { roll: 'B26057', name: 'Vishist Tulsyan' },
  { roll: 'IM26041', name: 'Divyam Dev' },
  { roll: 'IM26039', name: 'Amit' },
  { roll: 'B26058', name: 'Yashu' },
  { roll: 'IM26040', name: 'Nitesh' },
  { roll: 'B26084', name: 'Sanskar Dutt' },
  { roll: 'B26563', name: 'Sarthak Mishra' },
];

try {
  await client.query('BEGIN');

  console.log(`Adding attendance for 19th August 2026 Theory session (${sessionId})...`);

  for (const item of studentsToAdd) {
    const { rows: [student] } = await client.query('SELECT * FROM public.students WHERE roll_number = $1;', [item.roll]);
    if (!student) {
      throw new Error(`Student ${item.roll} (${item.name}) not found!`);
    }

    const { rowCount } = await client.query(`
      INSERT INTO public.attendance_records (
        session_id,
        student_id,
        roll_number,
        status,
        method,
        marked_at,
        notes,
        recorded_by
      ) VALUES (
        $1, $2, $3, 'present', 'manual', '2026-08-19T07:35:00.000Z', 'Manual sheet entry (19 Aug 1:05pm)', '18d28ba3-bb6d-4370-8737-451495470849'
      ) ON CONFLICT (session_id, student_id) DO UPDATE
      SET status = 'present',
          method = EXCLUDED.method,
          notes = EXCLUDED.notes,
          marked_at = EXCLUDED.marked_at,
          recorded_by = EXCLUDED.recorded_by;
    `, [sessionId, student.id, student.roll_number]);

    console.log(`Marked present: ${student.roll_number} - ${student.name} (DB ID: ${student.id})`);
  }

  await client.query('COMMIT');
  console.log('Transaction committed successfully!');

  // Verify
  const { rows: verifyRecords } = await client.query(`
    SELECT ar.id, ar.session_id, ar.student_id, ar.roll_number, s.name, ar.status, ar.method, ar.marked_at, ar.notes
    FROM public.attendance_records ar
    JOIN public.students s ON s.id = ar.student_id
    WHERE ar.session_id = $1 AND ar.roll_number = ANY($2::text[]);
  `, [sessionId, studentsToAdd.map(s => s.roll_number)]);

  console.log('\n--- VERIFIED ATTENDANCE ON 2026-08-19 ---');
  console.table(verifyRecords);

  const { rows: updatedSummary } = await client.query(`
    SELECT student_id, roll_number, name, present_count, total_sessions, attendance_percentage, theory_present_count, theory_percentage
    FROM public.student_attendance_summary('IC181')
    WHERE roll_number = ANY($1::text[])
    ORDER BY roll_number ASC;
  `, [studentsToAdd.map(s => s.roll_number)]);

  console.log('\n--- UPDATED ATTENDANCE SUMMARY FOR THESE 7 STUDENTS IN IC181 ---');
  console.table(updatedSummary);

} catch (err) {
  await client.query('ROLLBACK');
  console.error('Error adding attendance, rolled back:', err);
  process.exit(1);
} finally {
  await client.end();
}
