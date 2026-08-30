import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../services/supabase';
import { callFunction } from '../../lib/api';
import { QRCodeCanvas } from 'qrcode.react';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../components/ui/Toast';
import { AttendanceTable } from '../../components/shared/AttendanceTable';
import { ManualAttendanceModal } from '../../components/shared/ManualAttendanceModal';
import { formatTime } from '../../lib/utils';
import { SESSION_TYPE_PRESETS } from '../../types';
import type { Staff, Session, AttendanceRecord, GpsOverrideRequest, CourseSettings, ActivityRound } from '../../types';

interface Props {
  staff: Staff;
  courseName: string;
  onCourseChange?: (course: string) => void;
}

export function LiveSessionPage({ staff, courseName, onCourseChange }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [overrides, setOverrides] = useState<GpsOverrideRequest[]>([]);
  const [targetRosterCount, setTargetRosterCount] = useState<number>(0);
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
  const [lastSynced, setLastSynced] = useState<Date>(new Date());

  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('sessions')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      const activeList = data ?? [];
      setSessions(activeList);
      setSelectedId((prev) => {
        if (prev && activeList.some((s) => s.id === prev)) return prev;
        const matching = activeList.find((s) => s.course_name?.trim().toLowerCase() === courseName?.trim().toLowerCase());
        return matching?.id ?? activeList[0]?.id ?? null;
      });
    } catch (err) {
      console.error('[LiveSessionPage] Error loading active sessions:', err);
    }
  }, [courseName]);

  const handleSessionStarted = useCallback(
    (newSession?: Session, token?: string) => {
      if (newSession) {
        setSessions((prev) => [newSession, ...prev.filter((s) => s.id !== newSession.id)]);
        setSelectedId(newSession.id);
        if (token) setQrToken(token);
        if (newSession.course_name && onCourseChange) {
          onCourseChange(newSession.course_name);
        }
      }
      loadSessions();
    },
    [loadSessions, onCourseChange]
  );

  const loadPickerData = useCallback(async () => {
    try {
      const [{ data: groups }, { data: roundSessions }] = await Promise.all([
        supabase.from('students').select('group_label').eq('status', 'active').not('group_label', 'is', null),
        supabase.from('sessions').select('round_id').ilike('course_name', courseName).not('round_id', 'is', null),
      ]);
      setGroupChoices(Array.from(new Set((groups ?? []).map((g) => g.group_label as string))).sort());
      const roundIds = Array.from(new Set((roundSessions ?? []).map((s) => s.round_id as string)));
      if (roundIds.length === 0) {
        setRoundChoices([]);
        return;
      }
      const { data: rounds } = await supabase
        .from('activity_rounds')
        .select('*')
        .in('id', roundIds)
        .order('created_at', { ascending: false })
        .limit(30);
      setRoundChoices(rounds ?? []);
    } catch (err) {
      console.error('[LiveSessionPage] Error loading picker data:', err);
    }
  }, [courseName]);

  useEffect(() => {
    supabase.from('course_settings').select('*').single().then(({ data }) => setSettings(data));
    loadSessions();
    loadPickerData();

    const channel = supabase
      .channel('live_sessions_list_watch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, () => loadSessions())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadSessions, loadPickerData]);

  // Load target roster count for the active session (by group or whole course)
  useEffect(() => {
    async function loadRoster() {
      if (!selected) {
        setTargetRosterCount(0);
        return;
      }
      let query = supabase.from('students').select('*', { count: 'exact', head: true }).eq('status', 'active');
      if (selected.group_filter) {
        query = query.eq('group_label', selected.group_filter);
      }
      const { count } = await query;
      setTargetRosterCount(count ?? 0);
    }
    loadRoster();
  }, [selected]);

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    try {
      const [{ data: r }, { data: o }] = await Promise.all([
        supabase
          .from('attendance_records')
          .select('*, student:students(name, department, group_label)')
          .eq('session_id', sessionId)
          .order('marked_at', { ascending: false }),
        supabase
          .from('gps_override_requests')
          .select('*')
          .eq('session_id', sessionId)
          .in('status', ['pending', 'auto_allowed'])
          .order('requested_at', { ascending: false }),
      ]);
      setRecords((r as unknown as AttendanceRecord[]) ?? []);
      setOverrides(o ?? []);
      setLastSynced(new Date());
    } catch (err) {
      console.error('[LiveSessionPage] Error loading session detail:', err);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setRecords([]);
      setOverrides([]);
      return;
    }
    loadSessionDetail(selectedId);

    const channelId = `live_session_${selectedId.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, () => loadSessionDetail(selectedId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gps_override_requests' }, () => loadSessionDetail(selectedId))
      .subscribe();

    // High-frequency polling heartbeat to guarantee instant real-time sync
    const pollInterval = setInterval(() => {
      loadSessionDetail(selectedId);
    }, 2500);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
    };
  }, [selectedId, loadSessionDetail]);

  // QR rotation
  useEffect(() => {
    if (!selected) {
      setQrToken('');
      setQrExpiresAt(null);
      return;
    }
    let cancelled = false;

    async function rotate() {
      try {
        const res = await callFunction<{ qrToken: string; expiresAt: string }>('session-qr-rotate', {
          sessionId: selected!.id,
        });
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
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selected?.id, settings?.qr_rotation_seconds]);

  // Countdown timer
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

    // Optimistic UI update
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== targetId);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });

    try {
      await supabase
        .from('sessions')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', targetId);
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
      if (selectedId) loadSessionDetail(selectedId);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not resolve request.');
    }
  }

  async function handleGenerateCode() {
    if (!selected) return;
    try {
      const res = await callFunction<{ code: string; expiresAt: string }>('override-code-generate', {
        sessionId: selected.id,
      });
      setOverrideCode(res);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not generate code.');
    }
  }

  const qrUrl = qrToken ? `${window.location.origin}${window.location.pathname}?attend=${encodeURIComponent(qrToken)}` : '';
  const presentCount = records.length;
  const cleanGpsCount = records.filter((r) => r.method === 'gps' && !r.gps_flag).length;
  const gpsFlaggedCount = records.filter((r) => r.method === 'gps_flagged' || r.gps_flag != null).length;
  const overrideCount = records.filter(
    (r) => r.method === 'override_code' || r.method === 'instructor_approved' || r.status === 'override'
  ).length;
  const manualCount = records.filter((r) => r.method === 'manual' || r.status === 'manual').length;

  const attendancePct = targetRosterCount > 0 ? Math.round((presentCount / targetRosterCount) * 1000) / 10 : 0;

  if (sessions.length === 0) {
    return (
      <main className="page">
        <StartSessionPanel
          staff={staff}
          onStarted={handleSessionStarted}
          defaultRadius={settings?.gps_radius_meters ?? 100}
          defaultCourseName={courseName}
          groupChoices={groupChoices}
          roundChoices={roundChoices}
          onPickerDataChanged={loadPickerData}
        />
      </main>
    );
  }

  return (
    <main
      className={`page ${
        fullscreen ? 'fixed inset-0 z-50 bg-white dark:bg-[#0d1117] flex flex-col items-center justify-center p-6' : ''
      }`}
    >
      {!fullscreen && (
        <>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all flex items-center gap-1.5 ${
                    s.id === selectedId
                      ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
                      : 'bg-white dark:bg-[#161b22] border-slate-200 dark:border-[#30363d] text-slate-600 dark:text-slate-300 hover:border-blue-300'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>
                    {s.course_name} · {s.session_type}
                    {s.group_filter ? ` (Group ${s.group_filter})` : ''} · {formatTime(s.created_at)}
                  </span>
                </button>
              ))}
              <button onClick={() => setShowStart(true)} className="btn-outline btn-sm">
                + Start Another
              </button>
            </div>
            {selected && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Live Syncing
                </span>
                <button onClick={() => setShowManual(true)} className="btn-secondary btn-sm">
                  Manual Entry
                </button>
                <button onClick={handleGenerateCode} className="btn-secondary btn-sm">
                  Generate Code
                </button>
                <button onClick={() => setFullscreen(true)} className="btn-secondary btn-sm">
                  Full Screen QR
                </button>
                <button onClick={handleEndSession} className="btn-danger btn-sm">
                  End Session
                </button>
              </div>
            )}
          </div>

          {overrideCode && (
            <div className="card p-4 bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/20 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-900 dark:text-blue-300 uppercase tracking-wide">
                  Override Code
                </p>
                <p className="text-3xl font-bold font-mono tracking-[0.3em] text-blue-900 dark:text-blue-200 mt-1">
                  {overrideCode.code}
                </p>
                <p className="text-xs text-blue-700 dark:text-blue-400 mt-1">
                  Valid until {formatTime(overrideCode.expiresAt)} · read this out to affected students
                </p>
              </div>
              <button onClick={() => setOverrideCode(null)} className="btn-ghost btn-sm">
                Dismiss
              </button>
            </div>
          )}
        </>
      )}

      {selected &&
        (fullscreen ? (
          <div className="flex flex-col items-center gap-6 relative w-full h-full justify-center text-center">
            <button
              onClick={() => setFullscreen(false)}
              className="absolute top-4 right-4 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 p-2"
              title="Close Full Screen"
            >
              <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 mb-3">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Live Attendance Active
              </span>
              <h1 className="text-4xl sm:text-5xl font-bold text-slate-900 dark:text-white">
                {selected.course_name} — {selected.session_type}
              </h1>
              <p className="text-lg text-slate-500 mt-1">
                {selected.group_filter ? `Group ${selected.group_filter} · ` : ''}Scan QR code with your phone camera
              </p>
            </div>
            <div
              className={`p-8 bg-white rounded-[3rem] shadow-2xl border-4 transition-all duration-300 ${
                countdown <= 5 ? 'border-red-400 scale-[1.02]' : 'border-slate-200 dark:border-[#30363d]'
              }`}
            >
              {qrUrl && <QRCodeCanvas value={qrUrl} size={380} level="H" fgColor="#0f172a" bgColor="#ffffff" />}
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-4 text-slate-600 dark:text-slate-300">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${countdown <= 5 ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
                <span className="text-lg font-tabular font-medium">Refreshes in {countdown}s</span>
              </div>
              <span className="hidden sm:inline text-slate-300">|</span>
              <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 font-tabular">
                {presentCount} Present
                {targetRosterCount > 0 ? ` (${attendancePct}%)` : ''}
              </span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card p-6 flex flex-col items-center gap-4 text-center">
              <div>
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <p className="font-semibold text-slate-900 dark:text-slate-100">Scan to Mark Attendance</p>
                </div>
                <p className="text-xs text-slate-400">
                  {selected.course_name} · {selected.session_type}
                  {selected.group_filter ? ` · Group ${selected.group_filter}` : ' · General'}
                </p>
              </div>
              <div
                className={`p-4 bg-white rounded-3xl border-2 transition-all duration-300 shadow-sm ${
                  countdown <= 5 ? 'border-red-400 scale-[1.01]' : 'border-slate-200 dark:border-[#30363d]'
                }`}
              >
                {qrUrl && <QRCodeCanvas value={qrUrl} size={210} level="H" fgColor="#0f172a" bgColor="#ffffff" />}
              </div>
              <div className="flex flex-col items-center gap-1">
                <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 font-tabular flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${countdown <= 5 ? 'bg-red-500' : 'bg-emerald-500'}`} />
                  Rotates in {countdown}s
                </p>
                <p className="text-[11px] text-slate-400">
                  {selected.radius_meters}m radius · {selected.session_date}
                </p>
              </div>
            </div>

            <div className="lg:col-span-2 flex flex-col gap-6">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatMini
                  label="Present"
                  value={targetRosterCount > 0 ? `${presentCount}/${targetRosterCount}` : presentCount}
                  subtitle={targetRosterCount > 0 ? `${attendancePct}%` : undefined}
                  color="text-emerald-600 dark:text-emerald-400"
                />
                <StatMini
                  label="QR Verified"
                  value={cleanGpsCount}
                  subtitle="Clean GPS"
                  color="text-blue-600 dark:text-blue-400"
                />
                <StatMini
                  label="GPS Flagged"
                  value={gpsFlaggedCount}
                  subtitle={overrides.length > 0 ? `${overrides.length} review` : 'Auto-allowed'}
                  color="text-amber-600 dark:text-amber-400"
                />
                <StatMini
                  label="Override/Manual"
                  value={overrideCount + manualCount}
                  subtitle={`${overrideCount} code, ${manualCount} man`}
                  color="text-purple-600 dark:text-purple-400"
                />
              </div>

              {overrides.length > 0 && (
                <div className="card border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5">
                  <div className="px-5 py-3 border-b border-amber-200/60 dark:border-amber-500/20 font-semibold text-amber-900 dark:text-amber-400 text-sm flex items-center justify-between">
                    <span>GPS Flagged Entries ({overrides.length})</span>
                    <span className="font-normal text-amber-700 dark:text-amber-500 text-xs">
                      Attendance recorded · Instructor review
                    </span>
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
                            {' · '}
                            <span
                              className={`font-medium ${
                                o.status === 'auto_allowed'
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-amber-600 dark:text-amber-400'
                              }`}
                            >
                              {o.status === 'auto_allowed' ? 'Auto-allowed ✓' : 'Pending approval'}
                            </span>
                          </p>
                        </div>
                        {o.status === 'pending' && (
                          <div className="flex gap-2">
                            <button onClick={() => handleResolveOverride(o, 'approve')} className="btn-success btn-sm">
                              Approve
                            </button>
                            <button onClick={() => handleResolveOverride(o, 'reject')} className="btn-danger btn-sm">
                              Reject
                            </button>
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
        <StartSessionPanel
          staff={staff}
          embedded
          onStarted={(s, t) => {
            setShowStart(false);
            handleSessionStarted(s, t);
          }}
          defaultRadius={settings?.gps_radius_meters ?? 100}
          defaultCourseName={courseName}
          groupChoices={groupChoices}
          roundChoices={roundChoices}
          onPickerDataChanged={loadPickerData}
        />
      </Modal>

      {selected && (
        <ManualAttendanceModal
          open={showManual}
          onClose={() => setShowManual(false)}
          session={selected}
          onMarked={() => loadSessionDetail(selected.id)}
        />
      )}
    </main>
  );
}

function StatMini({
  label,
  value,
  subtitle,
  color,
}: {
  label: string;
  value: number | string;
  subtitle?: string;
  color: string;
}) {
  return (
    <div className="card p-3.5 text-center">
      <p className={`text-2xl font-bold font-tabular leading-tight ${color}`}>{value}</p>
      <p className="text-[10px] text-slate-500 font-medium uppercase mt-1 tracking-wide">{label}</p>
      {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function StartSessionPanel({
  staff,
  onStarted,
  defaultRadius,
  defaultCourseName,
  groupChoices,
  roundChoices,
  onPickerDataChanged,
  embedded,
}: {
  staff: Staff;
  onStarted: (session?: Session, qrToken?: string) => void;
  defaultRadius: number;
  defaultCourseName: string;
  groupChoices: string[];
  roundChoices: ActivityRound[];
  onPickerDataChanged: () => void;
  embedded?: boolean;
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
    if (!courseName) {
      setError('Please name the course.');
      return;
    }
    if (!sessionType) {
      setError('Please name the session type.');
      return;
    }
    if (audience === 'group' && !groupFilter) {
      setError('Please pick or type a group.');
      return;
    }
    if (roundChoice === '__new__' && !newRoundName.trim()) {
      setError('Please name the new round.');
      return;
    }
    if (!navigator.geolocation) {
      setError('This device does not support location services.');
      return;
    }
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
      () => {
        setError('We need your current location to anchor the GPS radius for this session.');
        setLoading(false);
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }

  return (
    <div className={embedded ? '' : 'card p-6 max-w-md mx-auto'}>
      {!embedded && (
        <>
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">No Active Session</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Start one to generate a QR code for {staff.name.split(' ')[0]}'s class.
          </p>
        </>
      )}
      <form onSubmit={handleStart} className="flex flex-col gap-4 mt-4">
        <div>
          <label className="label">Course</label>
          <select
            value={courseChoice}
            onChange={(e) => setCourseChoice(e.target.value as 'default' | 'custom')}
            className="input-base"
          >
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
            {SESSION_TYPE_PRESETS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
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
          <select
            value={audience}
            onChange={(e) => setAudience(e.target.value as 'general' | 'group')}
            className="input-base"
          >
            <option value="general">General — everyone can attend</option>
            <option value="group">Specific group</option>
          </select>
          {audience === 'group' && (
            <div className="mt-2 flex flex-col gap-2">
              <select value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)} className="input-base">
                <option value="">Select a group…</option>
                {groupChoices.map((g) => (
                  <option key={g} value={g}>
                    Group {g}
                  </option>
                ))}
                <option value="__custom__">New group…</option>
              </select>
              {groupChoice === '__custom__' && (
                <input
                  value={customGroup}
                  onChange={(e) => setCustomGroup(e.target.value)}
                  placeholder="e.g. I"
                  maxLength={3}
                  className="input-base"
                  autoFocus
                />
              )}
              <p className="text-[11px] text-slate-400">
                Anyone can still scan and attend — this only affects who this session counts against in reports.
              </p>
            </div>
          )}
        </div>
        {audience === 'group' && (
          <div>
            <label className="label">Part of a round? (optional)</label>
            <select value={roundChoice} onChange={(e) => setRoundChoice(e.target.value)} className="input-base">
              <option value="none">No — counts on its own</option>
              {roundChoices.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              <option value="__new__">+ New round…</option>
            </select>
            {roundChoice === '__new__' && (
              <input
                value={newRoundName}
                onChange={(e) => setNewRoundName(e.target.value)}
                placeholder="e.g. Yoga — Week 3"
                className="input-base mt-2"
                autoFocus
              />
            )}
            <p className="text-[11px] text-slate-400 mt-1">
              A round lets a student who misses their own group's day still get credit by attending a different group's
              session in the same round — as long as they attend at least one before every session in the round has ended.
            </p>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={allowOverride}
            onChange={(e) => setAllowOverride(e.target.checked)}
            className="rounded"
          />
          Allow GPS override requests for this session
        </label>
        {error && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-700 dark:text-red-400 text-xs">
            {error}
          </div>
        )}
        <button type="submit" disabled={loading} className="btn-primary w-full h-11">
          {loading ? 'Getting your location…' : 'Generate QR & Start'}
        </button>
      </form>
    </div>
  );
}
