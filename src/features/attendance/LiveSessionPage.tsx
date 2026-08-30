import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../services/supabase';
import { callFunction } from '../../lib/api';
import { QRCodeCanvas } from 'qrcode.react';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../components/ui/Toast';
import { AttendanceTable } from '../../components/shared/AttendanceTable';
import { ManualAttendanceModal } from '../../components/shared/ManualAttendanceModal';
import { timeAgo, formatTime } from '../../lib/utils';
import { SESSION_TYPE_PRESETS } from '../../types';
import type { Staff, Session, AttendanceRecord, GpsOverrideRequest, CourseSettings, ActivityRound } from '../../types';

interface Props { staff: Staff; courseName: string; onCourseChange?: (course: string) => void; }

export function LiveSessionPage({ staff, courseName, onCourseChange }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [overrides, setOverrides] = useState<GpsOverrideRequest[]>([]);
  const [settings, setSettings] = useState<CourseSettings | null>(null);
  const [qrToken, setQrToken] = useState('');
  const [qrExpiresAt, setQrExpiresAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [overrideCode, setOverrideCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [groupChoices, setGroupChoices] = useState<string[]>([]);
  const [roundChoices, setRoundChoices] = useState<ActivityRound[]>([]);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from('sessions').select('*').eq('status', 'active').order('created_at', { ascending: false });
    setSessions(data ?? []);
    setSelectedId((prev) => (prev && data?.some((s) => s.id === prev) ? prev : data?.[0]?.id ?? null));
  }, []);

  const handleSessionStarted = useCallback((newSession?: Session, token?: string) => {
    if (newSession) {
      setSessions((prev) => [newSession, ...prev.filter((s) => s.id !== newSession.id)]);
      setSelectedId(newSession.id);
      if (token) setQrToken(token);
      if (newSession.course_name && onCourseChange) {
        onCourseChange(newSession.course_name);
      }
    }
    loadSessions();
  }, [loadSessions, onCourseChange]);

  const loadPickerData = useCallback(async () => {
    const [{ data: groups }, { data: roundSessions }] = await Promise.all([
      supabase.from('students').select('group_label').eq('status', 'active').not('group_label', 'is', null),
      supabase.from('sessions').select('round_id').eq('course_name', courseName).not('round_id', 'is', null),
    ]);
    setGroupChoices(Array.from(new Set((groups ?? []).map((g) => g.group_label as string))).sort());
    const roundIds = Array.from(new Set((roundSessions ?? []).map((s) => s.round_id as string)));
    if (roundIds.length === 0) { setRoundChoices([]); return; }
    const { data: rounds } = await supabase.from('activity_rounds').select('*').in('id', roundIds).order('created_at', { ascending: false }).limit(30);
    setRoundChoices(rounds ?? []);
  }, [courseName]);

  useEffect(() => {
    supabase.from('course_settings').select('*').single().then(({ data }) => setSettings(data));
    loadSessions();
    loadPickerData();
    const channel = supabase
      .channel('live_sessions_list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, loadSessions)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadSessions, loadPickerData]);

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    const [{ data: r }, { data: o }] = await Promise.all([
      supabase.from('attendance_records').select('*').eq('session_id', sessionId).order('marked_at', { ascending: false }),
      // Fetch all GPS flagged entries (pending = old flow, auto_allowed = new always-through flow) so instructors can review
      supabase.from('gps_override_requests').select('*').eq('session_id', sessionId).in('status', ['pending', 'auto_allowed']).order('requested_at', { ascending: false }),
    ]);
    setRecords(r ?? []);
    setOverrides(o ?? []);
  }, []);

  useEffect(() => {
    if (!selectedId) { setRecords([]); setOverrides([]); return; }
    loadSessionDetail(selectedId);

    const channel = supabase
      .channel(`live_session_${selectedId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, () => loadSessionDetail(selectedId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gps_override_requests' }, () => loadSessionDetail(selectedId))
      .subscribe();

    const pollInterval = setInterval(() => {
      loadSessionDetail(selectedId);
    }, 3000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
    };
  }, [selectedId, loadSessionDetail]);

  useEffect(() => {
    if (!selected) { setQrToken(''); setQrExpiresAt(null); return; }
    let cancelled = false;

    async function rotate() {
      try {
        const res = await callFunction<{ qrToken: string; expiresAt: string }>('session-qr-rotate', { sessionId: selected!.id });
        if (cancelled) return;
        setQrToken(res.qrToken);
        setQrExpiresAt(new Date(res.expiresAt).getTime());
      } catch {
        /* transient failure — next tick will retry */
      }
    }
    rotate();
    const seconds = settings?.qr_rotation_seconds || 300;
    const interval = setInterval(rotate, seconds * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selected?.id, settings?.qr_rotation_seconds]);

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown(qrExpiresAt ? Math.max(0, Math.round((qrExpiresAt - Date.now()) / 1000)) : 0);
    }, 250);
    return () => clearInterval(t);
  }, [qrExpiresAt]);

  async function handleEndSession() {
    if (!selected) return;
    if (!window.confirm('End this session? Students will no longer be able to mark attendance for it.')) return;
    
    const targetId = selected.id;

    // Optimistic UI update — 0ms immediate UI transition
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== targetId);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });

    try {
      await supabase.from('sessions').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', targetId);
      toast('info', 'Session ended.');
    } catch {
      toast('error', 'Could not end session.');
    } finally {
      loadSessions();
    }
  }

  async function handleResolveOverride(o: GpsOverrideRequest, action: 'approve' | 'reject') {
    try {
      await callFunction('override-resolve', { requestId: o.id, action });
      toast(action === 'approve' ? 'success' : 'info', `Request ${action === 'approve' ? 'approved' : 'rejected'}.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not resolve request.');
    }
  }

  async function handleGenerateCode() {
    if (!selected) return;
    try {
      const res = await callFunction<{ code: string; expiresAt: string }>('override-code-generate', { sessionId: selected.id });
      setOverrideCode(res);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not generate code.');
    }
  }

  const qrUrl = qrToken ? `${window.location.origin}${window.location.pathname}?attend=${encodeURIComponent(qrToken)}` : '';
  const presentCount = records.length;
  const manualCount = records.filter((r) => r.method === 'manual').length;
  const overrideCount = records.filter((r) => r.method === 'override_code' || r.method === 'instructor_approved').length;

  if (sessions.length === 0) {
    return (
      <main className="page">
        <StartSessionPanel staff={staff} onStarted={handleSessionStarted} defaultRadius={settings?.gps_radius_meters ?? 100} defaultCourseName={courseName} groupChoices={groupChoices} roundChoices={roundChoices} onPickerDataChanged={loadPickerData} />
      </main>
    );
  }

  return (
    <main className={`page ${fullscreen ? 'fixed inset-0 z-50 bg-white dark:bg-[#0d1117] flex flex-col items-center justify-center p-6' : ''}`}>
      {!fullscreen && (
        <>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    s.id === selectedId
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-white dark:bg-[#161b22] border-slate-200 dark:border-[#30363d] text-slate-600 dark:text-slate-300 hover:border-blue-300'
                  }`}
                >
                  {s.course_name} · {s.session_type}{s.group_filter ? ` (Group ${s.group_filter})` : ''} · {formatTime(s.created_at)}
                </button>
              ))}
              <button onClick={() => setShowStart(true)} className="btn-outline btn-sm">+ Start Another</button>
            </div>
            {selected && (
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => setShowManual(true)} className="btn-secondary btn-sm">Manual Attendance</button>
                <button onClick={handleGenerateCode} className="btn-secondary btn-sm">Generate Code</button>
                <button onClick={() => setFullscreen(true)} className="btn-secondary btn-sm">Full Screen QR</button>
                <button onClick={handleEndSession} className="btn-danger btn-sm">End Session</button>
              </div>
            )}
          </div>

          {overrideCode && (
            <div className="card p-4 bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/20 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-900 dark:text-blue-300 uppercase tracking-wide">Override Code</p>
                <p className="text-3xl font-bold font-mono tracking-[0.3em] text-blue-900 dark:text-blue-200 mt-1">{overrideCode.code}</p>
                <p className="text-xs text-blue-700 dark:text-blue-400 mt-1">Valid until {formatTime(overrideCode.expiresAt)} · read this out to affected students</p>
              </div>
              <button onClick={() => setOverrideCode(null)} className="btn-ghost btn-sm">Dismiss</button>
            </div>
          )}
        </>
      )}

      {selected &&
        (fullscreen ? (
          <div className="flex flex-col items-center gap-8 relative w-full h-full justify-center">
            <button onClick={() => setFullscreen(false)} className="absolute top-4 right-4 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
              <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            <div className="text-center">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-2">{selected.course_name} — {selected.session_type}</h1>
              <p className="text-xl text-slate-500">Scan to mark attendance</p>
            </div>
            <div className={`p-8 rounded-[3rem] border-4 transition-all duration-300 ${countdown <= 5 ? 'border-red-400 scale-[1.02]' : 'border-slate-200'}`}>
              {qrUrl && <QRCodeCanvas value={qrUrl} size={420} level="H" fgColor="#0f172a" bgColor="#ffffff" />}
            </div>
            <div className="flex items-center gap-3">
              <div className={`w-4 h-4 rounded-full ${countdown <= 5 ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
              <span className="text-xl text-slate-500 font-tabular font-medium">Refreshes in {countdown}s · {presentCount} present</span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card p-6 flex flex-col items-center gap-4">
              <div className="text-center">
                <p className="font-semibold text-slate-900 dark:text-slate-100">Scan to Join</p>
                <p className="text-xs text-slate-400 mt-0.5">{selected.course_name} · {selected.session_type}{selected.group_filter ? ` · Group ${selected.group_filter}` : ' · General'}</p>
              </div>
              <div className={`p-4 rounded-3xl border-2 transition-all duration-300 ${countdown <= 5 ? 'border-red-400' : 'border-slate-200 dark:border-[#30363d]'}`}>
                {qrUrl && <QRCodeCanvas value={qrUrl} size={220} level="H" fgColor="#0f172a" bgColor="#ffffff" />}
              </div>
              <p className="text-sm text-slate-500 font-tabular">Refreshes in {countdown}s</p>
              <p className="text-xs text-slate-400">{selected.radius_meters}m radius · {selected.session_date}</p>
            </div>

            <div className="lg:col-span-2 flex flex-col gap-6">
              <div className="grid grid-cols-3 gap-3">
                <StatMini label="Present" value={presentCount} color="text-emerald-600" />
                <StatMini label="Manual" value={manualCount} color="text-purple-600" />
                <StatMini label="Override" value={overrideCount} color="text-blue-600" />
              </div>

              {overrides.length > 0 && (
                <div className="card border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5">
                  <div className="px-5 py-3 border-b border-amber-200/60 dark:border-amber-500/20 font-semibold text-amber-900 dark:text-amber-400 text-sm">
                    GPS Flagged Entries ({overrides.length})
                    <span className="ml-2 font-normal text-amber-700 dark:text-amber-500 text-xs">— attendance was recorded; review only</span>
                  </div>
                  <div className="divide-y divide-amber-100 dark:divide-amber-500/10">
                    {overrides.map((o) => (
                      <div key={o.id} className="flex justify-between items-center p-4">
                        <div>
                          <p className="font-semibold text-slate-900 dark:text-slate-100 text-sm">{o.roll_number}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            {o.reason === 'outside_radius'
                              ? `${o.distance_meters != null ? `${Math.round(o.distance_meters)}m away` : 'Outside radius'}`
                              : o.reason === 'gps_denied'
                              ? 'Location permission denied'
                              : 'Location unavailable'}
                            {' '}·{' '}
                            <span className={`font-medium ${o.status === 'auto_allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                              {o.status === 'auto_allowed' ? 'Auto-allowed ✓' : 'Pending approval'}
                            </span>
                          </p>
                        </div>
                        {o.status === 'pending' && (
                          <div className="flex gap-2">
                            <button onClick={() => handleResolveOverride(o, 'approve')} className="btn-success btn-sm">Approve</button>
                            <button onClick={() => handleResolveOverride(o, 'reject')} className="btn-danger btn-sm">Reject</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <AttendanceTable staff={staff} records={records} onChanged={() => loadSessionDetail(selected.id)} />
            </div>
          </div>
        ))}

      <Modal open={showStart} onClose={() => setShowStart(false)} title="Start Another Session" size="sm">
        <StartSessionPanel staff={staff} embedded onStarted={(s, t) => { setShowStart(false); handleSessionStarted(s, t); }} defaultRadius={settings?.gps_radius_meters ?? 100} defaultCourseName={courseName} groupChoices={groupChoices} roundChoices={roundChoices} onPickerDataChanged={loadPickerData} />
      </Modal>

      {selected && (
        <ManualAttendanceModal open={showManual} onClose={() => setShowManual(false)} session={selected} onMarked={() => loadSessionDetail(selected.id)} />
      )}
    </main>
  );
}

function StatMini({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card p-4 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[10px] text-slate-500 font-medium uppercase mt-1 tracking-wide">{label}</p>
    </div>
  );
}

function StartSessionPanel({
  staff, onStarted, defaultRadius, defaultCourseName, groupChoices, roundChoices, onPickerDataChanged, embedded,
}: {
  staff: Staff; onStarted: (session?: Session, qrToken?: string) => void; defaultRadius: number; defaultCourseName: string;
  groupChoices: string[]; roundChoices: ActivityRound[]; onPickerDataChanged: () => void; embedded?: boolean;
}) {
  const [courseChoice, setCourseChoice] = useState<'default' | 'custom'>('default');
  const [customCourse, setCustomCourse] = useState('');
  const [typeChoice, setTypeChoice] = useState<string>('Lecture');
  const [customType, setCustomType] = useState('');
  const [allowOverride, setAllowOverride] = useState(true);
  const [audience, setAudience] = useState<'general' | 'group'>('general');
  const [groupChoice, setGroupChoice] = useState<string>('');
  const [customGroup, setCustomGroup] = useState('');
  const [roundChoice, setRoundChoice] = useState<string>('none');
  const [newRoundName, setNewRoundName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const courseName = courseChoice === 'custom' ? customCourse.trim() : defaultCourseName;
    const sessionType = typeChoice === 'Other' ? customType.trim() : typeChoice;
    const groupFilter = audience === 'group' ? (groupChoice === '__custom__' ? customGroup.trim().toUpperCase() : groupChoice) : '';
    if (!courseName) { setError('Please name the course.'); return; }
    if (!sessionType) { setError('Please name the session type.'); return; }
    if (audience === 'group' && !groupFilter) { setError('Please pick or type a group.'); return; }
    if (roundChoice === '__new__' && !newRoundName.trim()) { setError('Please name the new round.'); return; }
    if (!navigator.geolocation) { setError('This device does not support location services.'); return; }
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await callFunction<{ session: Session; qrToken: string }>('session-start', {
            sessionType,
            courseName,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            radiusMeters: defaultRadius,
            allowGpsOverride: allowOverride,
            groupFilter: groupFilter || undefined,
            roundId: roundChoice !== 'none' && roundChoice !== '__new__' ? roundChoice : undefined,
            newRoundName: roundChoice === '__new__' ? newRoundName.trim() : undefined,
          });
          toast('success', 'Session started.');
          onStarted(res.session, res.qrToken);
          onPickerDataChanged();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not start the session.');
        } finally {
          setLoading(false);
        }
      },
      () => { setError('We need your current location to anchor the GPS radius for this session.'); setLoading(false); },
      { enableHighAccuracy: true, timeout: 12000 },
    );
  }

  return (
    <div className={embedded ? '' : 'card p-6 max-w-md mx-auto'}>
      {!embedded && (
        <>
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">No Active Session</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Start one to generate a QR code for {staff.name.split(' ')[0]}'s class.</p>
        </>
      )}
      <form onSubmit={handleStart} className="flex flex-col gap-4 mt-4">
        <div>
          <label className="label">Course</label>
          <select value={courseChoice} onChange={(e) => setCourseChoice(e.target.value as 'default' | 'custom')} className="input-base">
            <option value="default">{defaultCourseName}</option>
            <option value="custom">Custom…</option>
          </select>
          {courseChoice === 'custom' && (
            <input
              value={customCourse}
              onChange={(e) => setCustomCourse(e.target.value)}
              placeholder="Course name"
              className="input-base mt-2"
              autoFocus
            />
          )}
        </div>
        <div>
          <label className="label">Session Type</label>
          <select value={typeChoice} onChange={(e) => setTypeChoice(e.target.value)} className="input-base">
            {SESSION_TYPE_PRESETS.map((t) => <option key={t} value={t}>{t}</option>)}
            <option value="Other">Other…</option>
          </select>
          {typeChoice === 'Other' && (
            <input
              value={customType}
              onChange={(e) => setCustomType(e.target.value)}
              placeholder="e.g. Guest Lecture, Field Trip"
              className="input-base mt-2"
              autoFocus
            />
          )}
        </div>
        <div>
          <label className="label">Audience</label>
          <select value={audience} onChange={(e) => setAudience(e.target.value as 'general' | 'group')} className="input-base">
            <option value="general">General — everyone can attend</option>
            <option value="group">Specific group</option>
          </select>
          {audience === 'group' && (
            <div className="mt-2 flex flex-col gap-2">
              <select value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)} className="input-base">
                <option value="">Select a group…</option>
                {groupChoices.map((g) => <option key={g} value={g}>Group {g}</option>)}
                <option value="__custom__">New group…</option>
              </select>
              {groupChoice === '__custom__' && (
                <input value={customGroup} onChange={(e) => setCustomGroup(e.target.value)} placeholder="e.g. I" maxLength={3} className="input-base" autoFocus />
              )}
              <p className="text-[11px] text-slate-400">Anyone can still scan and attend — this only affects who this session counts against in reports.</p>
            </div>
          )}
        </div>
        {audience === 'group' && (
          <div>
            <label className="label">Part of a round? (optional)</label>
            <select value={roundChoice} onChange={(e) => setRoundChoice(e.target.value)} className="input-base">
              <option value="none">No — counts on its own</option>
              {roundChoices.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              <option value="__new__">+ New round…</option>
            </select>
            {roundChoice === '__new__' && (
              <input value={newRoundName} onChange={(e) => setNewRoundName(e.target.value)} placeholder="e.g. Yoga — Week 3" className="input-base mt-2" autoFocus />
            )}
            <p className="text-[11px] text-slate-400 mt-1">
              A round lets a student who misses their own group's day still get credit by attending a different group's session in the same round — as long as they attend at least one before every session in the round has ended.
            </p>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input type="checkbox" checked={allowOverride} onChange={(e) => setAllowOverride(e.target.checked)} className="rounded" />
          Allow GPS override requests for this session
        </label>
        {error && <div className="px-4 py-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-700 dark:text-red-400 text-xs">{error}</div>}
        <button type="submit" disabled={loading} className="btn-primary w-full h-11">
          {loading ? 'Getting your location…' : 'Generate QR & Start'}
        </button>
      </form>
    </div>
  );
}
