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

  const { rows: students } = await client.query('SELECT id, roll_number, name, email, group_label, status FROM public.students ORDER BY roll_number ASC;');
  console.log(`Fetched ${students.length} students from database.`);
  
  // Save students to json for matching script
  const fs = await import('fs');
  fs.writeFileSync('scripts/db_students.json', JSON.stringify(students, null, 2));
  console.log('Saved to scripts/db_students.json');

} catch (err) {
  console.error('Error:', err);
} finally {
  await client.end();
}
