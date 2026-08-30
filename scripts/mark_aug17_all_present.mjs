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

const sessionId = 'ecf7434d-d491-46a2-951a-1a7803063cca'; // IC181 Theory on 2026-08-17

try {
  await client.query('BEGIN');

  console.log(`Marking all active students present for 17th August 2026 IC181 Theory session (${sessionId})...`);

  const { rows: activeStudents } = await client.query(`
    SELECT id, roll_number, name FROM public.students WHERE status = 'active' ORDER BY roll_number ASC;
  `);
  console.log(`Found ${activeStudents.length} active students.`);

  let newlyMarked = 0;
  let alreadyMarked = 0;

  for (const student of activeStudents) {
    const { rows: existing } = await client.query(`
      SELECT id, status, method FROM public.attendance_records
      WHERE session_id = $1 AND student_id = $2;
    `, [sessionId, student.id]);

    if (existing.length > 0) {
      if (existing[0].status !== 'present') {
        await client.query(`
          UPDATE public.attendance_records
          SET status = 'present', notes = COALESCE(notes || ' | ', '') || 'Paper attendance override'
          WHERE id = $1;
        `, [existing[0].id]);
        newlyMarked++;
      } else {
        alreadyMarked++;
      }
    } else {
      await client.query(`
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
          $1, $2, $3, 'present', 'manual', '2026-08-17T07:30:00.000Z', 'Paper attendance (17 Aug Theory class)', '18d28ba3-bb6d-4370-8737-451495470849'
        );
      `, [sessionId, student.id, student.roll_number]);
      newlyMarked++;
    }
  }

  // Also update session notes
  await client.query(`
    UPDATE public.sessions
    SET notes = 'Theory Class (General) - 17 August 2026 (Paper attendance marked for all active students)'
    WHERE id = $1;
  `, [sessionId]);

  // Add audit log entry
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
      'instructor_manual',
      'bulk_paper_attendance_aug17',
      'session',
      $1,
      $2::jsonb,
      $3::jsonb
    );
  `, [
    sessionId,
    JSON.stringify({ session_id: sessionId, previously_marked: alreadyMarked }),
    JSON.stringify({ session_id: sessionId, newly_marked: newlyMarked, total_present: alreadyMarked + newlyMarked })
  ]);

  await client.query('COMMIT');
  console.log(`Transaction committed! Already marked: ${alreadyMarked}, Newly marked: ${newlyMarked}, Total in session: ${alreadyMarked + newlyMarked}`);

  // Verify
  const { rows: [verifyCount] } = await client.query(`
    SELECT count(*) as total_marked,
           count(CASE WHEN status = 'present' THEN 1 END) as present_count
    FROM public.attendance_records
    WHERE session_id = $1;
  `, [sessionId]);
  console.log('Verified attendance count for 17 Aug Theory session:', verifyCount);

  // Check updated IC181 summary
  const { rows: [summaryStats] } = await client.query(`
    SELECT count(*) as total_students,
           min(attendance_percentage) as min_pct,
           round(avg(attendance_percentage), 1) as avg_pct,
           max(attendance_percentage) as max_pct,
           round(avg(theory_percentage), 1) as avg_theory_pct
    FROM public.student_attendance_summary('IC181');
  `);
  console.log('Updated IC181 summary stats:', summaryStats);

} catch (err) {
  await client.query('ROLLBACK');
  console.error('Error marking attendance for 17th Aug, rolled back:', err);
  process.exit(1);
} finally {
  await client.end();
}
