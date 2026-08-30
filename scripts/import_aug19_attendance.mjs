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

// Helper to convert "8/19/2026 12:53:52" (IST, UTC+5:30) to ISO string in UTC
function parseIstTimestamp(tsStr) {
  const parts = tsStr.trim().split(/\s+/);
  const dateParts = parts[0].split('/');
  const timeParts = parts[1].split(':');
  
  const month = parseInt(dateParts[0], 10);
  const day = parseInt(dateParts[1], 10);
  const year = parseInt(dateParts[2], 10);
  
  const hour = parseInt(timeParts[0], 10);
  const min = parseInt(timeParts[1], 10);
  const sec = parseInt(timeParts[2], 10);

  // IST is UTC+5:30 -> subtract 5h 30m in ms
  const utcMs = Date.UTC(year, month - 1, day, hour, min, sec) - (5.5 * 60 * 60 * 1000);
  return new Date(utcMs).toISOString();
}

async function run() {
  const records = JSON.parse(readFileSync('scripts/parsed_attendance_records.json', 'utf8'));
  console.log(`Loaded ${records.length} parsed records for import.`);

  await client.connect();
  console.log('Connected to Supabase Postgres.');

  try {
    await client.query('BEGIN');

    // 1. Find or create the Theory session on 2026-08-19
    const { rows: existingSessions } = await client.query(`
      SELECT * FROM public.sessions 
      WHERE session_date = '2026-08-19' 
        AND course_name = 'IC181' 
        AND session_type = 'Theory' 
        AND group_filter IS NULL;
    `);

    let sessionId;
    if (existingSessions.length > 0) {
      sessionId = existingSessions[0].id;
      console.log(`Found existing Theory session: ${sessionId}`);
    } else {
      console.log('Creating new Theory session on 2026-08-19...');
      const { rows: newSessionRows } = await client.query(`
        INSERT INTO public.sessions (
          session_date,
          session_type,
          course_name,
          status,
          started_by,
          anchor_lat,
          anchor_lng,
          radius_meters,
          group_filter,
          rotation_id,
          rotation_expires_at,
          allow_gps_override,
          notes,
          created_at,
          ended_at
        ) VALUES (
          '2026-08-19',
          'Theory',
          'IC181',
          'ended',
          '18d28ba3-bb6d-4370-8737-451495470849',
          31.7810151,
          76.9996043,
          100,
          NULL,
          gen_random_uuid(),
          '2026-08-19T07:48:00.000Z',
          TRUE,
          'Theory Class (General) - 19 August 2026 (Spreadsheet Import)',
          '2026-08-19T07:23:50.000Z',
          '2026-08-19T07:48:00.000Z'
        ) RETURNING id;
      `);
      sessionId = newSessionRows[0].id;
      console.log(`Created new session with ID: ${sessionId}`);
    }

    // 2. Insert attendance records
    let insertedCount = 0;
    for (const item of records) {
      const student = item.matchedStudent;
      const markedAt = parseIstTimestamp(item.timestamp);

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
          $1, $2, $3, 'present', 'manual', $4, 'Spreadsheet import', '18d28ba3-bb6d-4370-8737-451495470849'
        ) ON CONFLICT (session_id, student_id) DO UPDATE
        SET status = EXCLUDED.status,
            method = EXCLUDED.method,
            marked_at = EXCLUDED.marked_at,
            notes = EXCLUDED.notes,
            recorded_by = EXCLUDED.recorded_by;
      `, [sessionId, student.id, student.roll_number, markedAt]);

      insertedCount++;
    }

    console.log(`Successfully upserted ${insertedCount} attendance records for session ${sessionId}.`);

    // 3. Insert audit log
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
        'venkatesh@iitmandi.ac.in',
        'spreadsheet_attendance_import',
        'session',
        $1,
        NULL,
        $2::jsonb
      );
    `, [sessionId, JSON.stringify({
      session_id: sessionId,
      session_date: '2026-08-19',
      session_type: 'Theory',
      course_name: 'IC181',
      total_students_marked: insertedCount,
    })]);

    await client.query('COMMIT');
    console.log('Transaction committed successfully.');

    // 4. Verify results
    const { rows: verifyCount } = await client.query(`
      SELECT count(*) FROM public.attendance_records WHERE session_id = $1;
    `, [sessionId]);
    console.log(`Verified count in database for session ${sessionId}: ${verifyCount[0].count}`);

    const { rows: sessionSummary } = await client.query(`
      SELECT s.id, s.session_date::text as s_date, s.session_type, s.course_name, s.group_filter, s.status, count(ar.id) as records_count
      FROM public.sessions s
      LEFT JOIN public.attendance_records ar ON ar.session_id = s.id
      WHERE s.id = $1
      GROUP BY s.id, s.session_date, s.session_type, s.course_name, s.group_filter, s.status;
    `, [sessionId]);
    console.log('Session status:', JSON.stringify(sessionSummary[0], null, 2));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during import, rolled back:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
