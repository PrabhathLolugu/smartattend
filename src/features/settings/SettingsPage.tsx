import React, { useEffect, useState } from 'react';
import { supabase } from '../../services/supabase';
import { toast } from '../../components/ui/Toast';
import type { CourseSettings } from '../../types';

const DEFAULT_SETTINGS: CourseSettings = {
  course_name: 'IC181',
  gps_radius_meters: 100,
  override_code_ttl_seconds: 180,
  qr_rotation_seconds: 25,
  qr_token_validity_seconds: 1800,
};

export function SettingsPage() {
  const [form, setForm] = useState<CourseSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from('course_settings').select('*').maybeSingle().then(({ data }) => {
      setForm(data || DEFAULT_SETTINGS);
      setLoading(false);
    });
  }, []);

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    const { error } = await supabase
      .from('course_settings')
      .upsert({
        id: true,
        course_name: form.course_name,
        gps_radius_meters: form.gps_radius_meters,
        override_code_ttl_seconds: form.override_code_ttl_seconds,
        qr_rotation_seconds: form.qr_rotation_seconds,
        qr_token_validity_seconds: form.qr_token_validity_seconds,
      });
    setSaving(false);
    if (error) { toast('error', 'Could not save settings.'); return; }
    toast('success', 'Settings saved.');
  }

  if (loading || !form) {
    return <main className="page"><div className="card p-10 text-center text-sm text-slate-400">Loading…</div></main>;
  }

  return (
    <main className="page max-w-xl">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Defaults applied to every new attendance session.</p>
      </div>

      <div className="card p-6 flex flex-col gap-4">
        <div>
          <label className="label">Course Name</label>
          <input className="input-base" value={form.course_name} onChange={(e) => setForm({ ...form, course_name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">GPS Radius (metres)</label>
            <input type="number" min={10} className="input-base" value={form.gps_radius_meters} onChange={(e) => setForm({ ...form, gps_radius_meters: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Override Code Validity (seconds)</label>
            <input type="number" min={30} className="input-base" value={form.override_code_ttl_seconds} onChange={(e) => setForm({ ...form, override_code_ttl_seconds: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">QR Screen Refresh (minutes)</label>
            <input
              type="number" min={1} step={1} className="input-base"
              value={Math.round(form.qr_rotation_seconds / 60)}
              onChange={(e) => setForm({ ...form, qr_rotation_seconds: Number(e.target.value) * 60 })}
            />
            <p className="text-[11px] text-slate-400 mt-1">How often the QR shown on screen visually refreshes.</p>
          </div>
          <div>
            <label className="label">Scanned QR Valid For (minutes)</label>
            <input
              type="number" min={1} step={1} className="input-base"
              value={Math.round(form.qr_token_validity_seconds / 60)}
              onChange={(e) => setForm({ ...form, qr_token_validity_seconds: Number(e.target.value) * 60 })}
            />
            <p className="text-[11px] text-slate-400 mt-1">Grace period after a student scans, so filling out first-time registration doesn't time out.</p>
          </div>
        </div>
        <button onClick={handleSave} disabled={saving} className="btn-primary w-full h-11 mt-2">{saving ? 'Saving…' : 'Save Settings'}</button>
      </div>
    </main>
  );
}
