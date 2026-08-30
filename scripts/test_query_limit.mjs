import { createClient } from '@supabase/supabase-js';
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

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const { data: sessionRows } = await supabase
  .from('sessions')
  .select('*')
  .ilike('course_name', 'IC181')
  .order('created_at', { ascending: false });

const allIds = (sessionRows || []).map(s => s.id);

const { data: records, count } = await supabase
  .from('attendance_records')
  .select('session_id, status, method', { count: 'exact' })
  .in('session_id', allIds)
  .limit(30000);

console.log('Total records matching in DB:', count);
console.log('Records actually returned by Supabase .select():', records?.length);

const perSession = {};
records?.forEach(r => {
  perSession[r.session_id] = (perSession[r.session_id] || 0) + 1;
});

console.log('\nSession counts in client array:');
sessionRows?.forEach(s => {
  console.log(`${s.session_date} | ${s.session_type} | id: ${s.id.slice(0, 8)} | records returned: ${perSession[s.id] || 0}`);
});
