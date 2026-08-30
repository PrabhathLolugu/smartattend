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

  console.log('Inspecting definition of student_attendance_summary...');
  const { rows: funcDef } = await client.query(`
    SELECT pg_get_functiondef(p.oid) as def
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'student_attendance_summary' AND n.nspname = 'public';
  `);
  console.log(funcDef[0]?.def);

  console.log('\nTiming execution of EXPLAIN ANALYZE SELECT * FROM student_attendance_summary(\'IC181\')...');
  const t0 = Date.now();
  const { rows: plan } = await client.query("EXPLAIN ANALYZE SELECT * FROM student_attendance_summary('IC181')");

  console.log('Took ms:', Date.now() - t0);
  console.log(plan.map(r => r['QUERY PLAN']).join('\n'));

} catch (err) {
  console.error('Error:', err);
} finally {
  await client.end();
}
