import { Client } from 'pg';
import { readFileSync, writeFileSync, existsSync } from 'fs';
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

try {
  await client.query('BEGIN');

  console.log('=== 1. MERGING ATTENDANCE FROM DUPLICATE / WRONG-ROLL ENTRIES ===');

  // Category 1: Merge attendance records
  const mergeMappings = [
    { wrongRoll: '26030', correctRoll: 'IM26030' },
    { wrongRoll: '26155', correctRoll: 'B26155' },
    { wrongRoll: '26268', correctRoll: 'B26268' },
    { wrongRoll: 'B26CE116', correctRoll: 'B26116' },
    { wrongRoll: 'B56261', correctRoll: 'B26561' },
    { wrongRoll: 'BB26443', correctRoll: 'B26443' },
    { wrongRoll: 'DUTT', correctRoll: 'B26084' },
    { wrongRoll: 'JANGIR', correctRoll: 'B26283' },
    { wrongRoll: 'KUMAR', correctRoll: 'B26409' },
    { wrongRoll: 'RITIK', correctRoll: 'B26227' },
    { wrongRoll: 'SONI', correctRoll: 'B26271' },
    { wrongRoll: 'VISHWANATHE', correctRoll: 'B26442' },
  ];

  let mergedCount = 0;
  let deletedDuplicateAttCount = 0;

  for (const m of mergeMappings) {
    const { rows: [wrongStudent] } = await client.query('SELECT * FROM public.students WHERE roll_number = $1;', [m.wrongRoll]);
    const { rows: [correctStudent] } = await client.query('SELECT * FROM public.students WHERE roll_number = $1;', [m.correctRoll]);

    if (!wrongStudent) {
      console.log(`Wrong student ${m.wrongRoll} not found in DB (already removed?).`);
      continue;
    }
    if (!correctStudent) {
      throw new Error(`Target student ${m.correctRoll} not found in DB!`);
    }

    // Get wrong student attendance records
    const { rows: wrongAtts } = await client.query('SELECT * FROM public.attendance_records WHERE student_id = $1;', [wrongStudent.id]);
    // Get correct student attendance records
    const { rows: correctAtts } = await client.query('SELECT * FROM public.attendance_records WHERE student_id = $1;', [correctStudent.id]);

    const correctSessionIds = new Set(correctAtts.map(a => a.session_id));

    for (const wa of wrongAtts) {
      if (correctSessionIds.has(wa.session_id)) {
        // Correct student already has attendance for this session -> delete duplicate
        await client.query('DELETE FROM public.attendance_records WHERE id = $1;', [wa.id]);
        deletedDuplicateAttCount++;
        console.log(`Deleted duplicate attendance record ${wa.id} for session ${wa.session_id} (${m.wrongRoll} -> ${m.correctRoll})`);
      } else {
        // Move attendance record to correct student
        await client.query(`
          UPDATE public.attendance_records
          SET student_id = $1, roll_number = $2, notes = COALESCE(notes || ' | ', '') || 'Merged from ' || $3
          WHERE id = $4;
        `, [correctStudent.id, correctStudent.roll_number, m.wrongRoll, wa.id]);
        mergedCount++;
        correctSessionIds.add(wa.session_id);
        console.log(`Merged attendance record ${wa.id} in session ${wa.session_id} to ${m.correctRoll}`);
      }
    }

    // Delete wrong student record
    await client.query('DELETE FROM public.students WHERE id = $1;', [wrongStudent.id]);
    console.log(`Deleted duplicate student entry: ${m.wrongRoll} (${wrongStudent.name})`);
  }

  console.log(`\n=== 2. DELETING ZERO-ATTENDANCE DUPLICATE ENTRIES ===`);
  const zeroAttendanceDuplicates = [
    { roll: '194876', desc: 'Rushil Panchal (duplicate of IM26049)' },
    { roll: '344571', desc: 'Rathod Balaji (duplicate of B26596)' },
    { roll: '640655', desc: 'Rastiv Raj (duplicate of B26364)' },
    { roll: '861129', desc: 'Rastiv Raj (duplicate of B26364)' },
    { roll: '898927', desc: 'Guddu Kumar Gupta (duplicate of IM26024)' },
    { roll: 'B26ME538', desc: 'Manvinder Singh (duplicate of B26538)' },
    { roll: 'B36450', desc: 'Himanshu (duplicate of B26450)' },
  ];

  for (const item of zeroAttendanceDuplicates) {
    const { rows: [st] } = await client.query('SELECT * FROM public.students WHERE roll_number = $1;', [item.roll]);
    if (st) {
      // Ensure no attendance records exist
      const { rows: [att] } = await client.query('SELECT count(*) FROM public.attendance_records WHERE student_id = $1;', [st.id]);
      if (parseInt(att.count, 10) > 0) {
        throw new Error(`Unexpected attendance records found for ${item.roll}!`);
      }
      await client.query('DELETE FROM public.students WHERE id = $1;', [st.id]);
      console.log(`Deleted duplicate zero-attendance student: ${item.roll} - ${item.desc}`);
    }
  }

  console.log(`\n=== 3. DELETING FALSE / JUNK / TEST ENTRIES ===`);
  const falseEntries = [
    { roll: 'B2683738826', desc: 'Jdjdn (Fake test entry)' },
    { roll: 'D23293', desc: 'Ansul (Fake test entry)' },
    { roll: 'D23294', desc: 'A (Fake test entry)' },
  ];

  for (const item of falseEntries) {
    const { rows: [st] } = await client.query('SELECT * FROM public.students WHERE roll_number = $1;', [item.roll]);
    if (st) {
      const { rowCount } = await client.query('DELETE FROM public.attendance_records WHERE student_id = $1;', [st.id]);
      if (rowCount > 0) {
        console.log(`Deleted ${rowCount} attendance record(s) for fake entry ${item.roll}`);
      }
      await client.query('DELETE FROM public.students WHERE id = $1;', [st.id]);
      console.log(`Deleted false/fake student entry: ${item.roll} - ${item.desc}`);
    }
  }

  // Insert audit log
  await client.query(`
    INSERT INTO public.audit_log (
      actor_id,
      actor_label,
      action,
      entity_type,
      entity_id,
      before,
      after
    ) VALUES (
      '18d28ba3-bb6d-4370-8737-451495470849',
      'system_deduplication',
      'student_and_attendance_deduplication',
      'system',
      '00000000-0000-0000-0000-000000000000',
      $1::jsonb,
      $2::jsonb
    );
  `, [
    JSON.stringify({ merged_records: mergedCount, deleted_duplicates: deletedDuplicateAttCount }),
    JSON.stringify({ status: 'completed', cleaned_students: 22 })
  ]);

  await client.query('COMMIT');
  console.log('\n=== TRANSACTION COMMITTED SUCCESSFULLY! ===');

  // Verify
  const { rows: [finalStuCount] } = await client.query('SELECT count(*) FROM public.students;');
  const { rows: [finalAttCount] } = await client.query('SELECT count(*) FROM public.attendance_records;');
  console.log(`Total students now in DB: ${finalStuCount.count}`);
  console.log(`Total attendance records now in DB: ${finalAttCount.count}`);

  const { rows: weirdRolls } = await client.query(`
    SELECT roll_number, count(*)
    FROM public.students
    WHERE roll_number !~* '^(B26[0-9]{3}|IM26[0-9]{3}|UD26[0-9]{3}|DD26[0-9]{3}|D26[0-9]{3}|B23[0-9]{3}|B26151)$'
    GROUP BY roll_number;
  `);
  console.log(`Non-standard roll numbers remaining in students table: ${weirdRolls.length}`);

  const { rows: weirdAttRolls } = await client.query(`
    SELECT roll_number, count(*)
    FROM public.attendance_records
    WHERE roll_number !~* '^(B26[0-9]{3}|IM26[0-9]{3}|UD26[0-9]{3}|DD26[0-9]{3}|D26[0-9]{3}|B23[0-9]{3}|B26151)$'
    GROUP BY roll_number;
  `);
  console.log(`Non-standard roll numbers remaining in attendance_records table: ${weirdAttRolls.length}`);

  // Dump updated students to scripts/db_students.json
  const { rows: freshStudents } = await client.query('SELECT id, roll_number, name, email, group_label, status FROM public.students ORDER BY roll_number ASC;');
  writeFileSync('scripts/db_students.json', JSON.stringify(freshStudents, null, 2));
  console.log('Saved updated student roster to scripts/db_students.json');

} catch (err) {
  await client.query('ROLLBACK');
  console.error('Error during cleanup, transaction rolled back:', err);
  process.exit(1);
} finally {
  await client.end();
}
