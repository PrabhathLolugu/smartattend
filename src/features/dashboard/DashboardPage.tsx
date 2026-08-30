import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { supabase } from '../../services/supabase';
import { getGreeting } from '../../lib/utils';
import { StatusBadge } from '../../components/ui/StatusBadge';
import type { Staff, Session, StudentAttendanceSummary } from '../../types';

interface Props {
  staff: Staff;
  onNavigate: (tab: string) => void;
  onOpenSession: (sessionId: string) => void;
  courseName: string;
}

// Validated categorical slots (blue / orange / aqua / yellow / …)
const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const AXIS_INK = '#94a3b8';
const GRID = '#e2e8f0';

const METHOD_LABEL: Record<string, string> = {
  gps: 'QR Scan (Clean)',
  gps_flagged: 'QR Scan (Flagged)',
  override_code: 'Override Code',
  instructor_approved: 'Staff Approved',
  manual: 'Manual Entry',
};

export function DashboardPage({ staff, onNavigate, onOpenSession, courseName }: Props) {
  const [todaySessions, setTodaySessions] = useState<Session[]>([]);
  const [allCourseSessions, setAllCourseSessions] = useState<Session[]>([]);
  const [allRecords, setAllRecords] = useState<{ session_id: string; status: string; method: string }[]>([]);
  const [totalStudents, setTotalStudents] = useState(0);
  const [summaries, setSummaries] = useState<StudentAttendanceSummary[]>([]);
  const [demographics, setDemographics] = useState<{ department: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState<Date>(new Date());

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);

      const [
        { data: sessionRows },
        { data: roster },
        { data: summaryRows },
      ] = await Promise.all([
        supabase
          .from('sessions')
          .select('*')
          .ilike('course_name', courseName)
          .order('created_at', { ascending: false }),
        supabase
          .from('students')
          .select('department')
          .eq('status', 'active'),
        supabase
          .rpc('student_attendance_summary', { p_course_name: courseName }),
      ]);

      const sessions = sessionRows ?? [];
      setAllCourseSessions(sessions);
      setSummaries((summaryRows as StudentAttendanceSummary[]) ?? []);
      setTotalStudents(roster?.length ?? 0);

      // Today's sessions = sessions scheduled for today OR sessions currently active
      const todayList = sessions.filter((s) => s.session_date === today || s.status === 'active');
      setTodaySessions(todayList);

      // Demographics tally
      const dept: Record<string, number> = {};
      (roster ?? []).forEach((r) => {
        const key = (r.department as string | null)?.trim() || 'Unspecified';
        dept[key] = (dept[key] ?? 0) + 1;
      });
      setDemographics(
        Object.entries(dept)
          .map(([department, count]) => ({ department, count }))
          .sort((a, b) => b.count - a.count)
      );

      // Fetch attendance records for all sessions in this course
      const allIds = sessions.map((s) => s.id);
      if (allIds.length > 0) {
        const { data: records } = await supabase
          .from('attendance_records')
          .select('session_id, status, method')
          .in('session_id', allIds)
          .limit(30000);
        setAllRecords(records ?? []);
      } else {
        setAllRecords([]);
      }
      setLastSynced(new Date());
    } catch (err) {
      console.error('[DashboardPage] Error loading dashboard stats:', err);
    } finally {
      setLoading(false);
    }
  }, [courseName]);

  useEffect(() => {
    load();
    const channelId = `dashboard_${courseName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, () => load())
      .subscribe();

    // Heartbeat polling fallback to guarantee real-time updates
    const pollInterval = setInterval(() => {
      load();
    }, 4000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
    };
  }, [load, courseName]);

  const activeSessions = useMemo(
    () => allCourseSessions.filter((s) => s.status === 'active'),
    [allCourseSessions]
  );

  const sessionsHeldCount = useMemo(
    () => allCourseSessions.filter((s) => s.status === 'ended').length,
    [allCourseSessions]
  );

  const todayRecords = useMemo(() => {
    const todayIds = new Set(todaySessions.map((s) => s.id));
    return allRecords.filter((r) => todayIds.has(r.session_id));
  }, [todaySessions, allRecords]);

  const methodTally = useMemo(() => {
    const method: Record<string, number> = {};
    allRecords.forEach((r) => {
      const key = r.method || 'unknown';
      method[key] = (method[key] ?? 0) + 1;
    });
    return method;
  }, [allRecords]);

  const overrideTotal = useMemo(() => {
    return allRecords.filter(
      (r) =>
        r.status === 'override' ||
        r.method === 'override_code' ||
        r.method === 'instructor_approved' ||
        r.method === 'gps_flagged'
    ).length;
  }, [allRecords]);

  const manualTotal = useMemo(() => {
    return allRecords.filter((r) => r.status === 'manual' || r.method === 'manual').length;
  }, [allRecords]);

  const excusedTotal = useMemo(() => {
    return allRecords.filter((r) => r.status === 'excused').length;
  }, [allRecords]);

  const overallPct = useMemo(() => {
    const totalPresent = summaries.reduce((sum, s) => sum + s.present_count, 0);
    const totalSlots = summaries.reduce((sum, s) => sum + s.total_sessions, 0);
    if (totalSlots > 0) {
      return Math.round((totalPresent / totalSlots) * 1000) / 10;
    }
    // Fallback: If sessions are held or active, calculate from records / (totalStudents * totalSessions)
    if (totalStudents > 0 && allCourseSessions.length > 0) {
      const presentRecords = allRecords.filter((r) => r.status !== 'excused').length;
      const expectedTotal = totalStudents * allCourseSessions.length;
      return Math.min(100, Math.round((presentRecords / expectedTotal) * 1000) / 10);
    }
    return 0;
  }, [summaries, totalStudents, allCourseSessions.length, allRecords]);

  const groupChart = useMemo(() => {
    const byGroup: Record<string, { sum: number; n: number }> = {};
    summaries.forEach((s) => {
      if (!s.group_label) return;
      byGroup[s.group_label] ??= { sum: 0, n: 0 };
      byGroup[s.group_label].sum += s.attendance_percentage;
      byGroup[s.group_label].n += 1;
    });
    return Object.entries(byGroup)
      .map(([group, { sum, n }]) => ({ group, pct: Math.round((sum / n) * 10) / 10 }))
      .sort((a, b) => a.group.localeCompare(b.group));
  }, [summaries]);

  const methodChart = useMemo(() => {
    return Object.entries(methodTally).map(([method, value]) => ({
      name: METHOD_LABEL[method] ?? method.replace('_', ' '),
      value,
    }));
  }, [methodTally]);

  const trendChart = useMemo(() => {
    const endedOrActiveGeneral = allCourseSessions.filter((s) => !s.group_filter);
    const perSession: Record<string, number> = {};
    allRecords.forEach((r) => {
      perSession[r.session_id] = (perSession[r.session_id] ?? 0) + 1;
    });
    const byDate: Record<string, number> = {};
    endedOrActiveGeneral.forEach((s) => {
      byDate[s.session_date] = (byDate[s.session_date] ?? 0) + (perSession[s.id] ?? 0);
    });
    return Object.entries(byDate)
      .map(([session_date, count]) => ({
        date: new Date(session_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        pct: totalStudents > 0 ? Math.min(100, Math.round((count / totalStudents) * 1000) / 10) : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);
  }, [allCourseSessions, allRecords, totalStudents]);

  const deptChart = useMemo(() => {
    if (demographics.length <= 8) return demographics;
    const top = demographics.slice(0, 7);
    const rest = demographics.slice(7).reduce((sum, d) => sum + d.count, 0);
    return [...top, { department: 'Other', count: rest }];
  }, [demographics]);

  return (
    <main className="page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {getGreeting()}, {staff.name.split(' ')[0]}.
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Sync
            </span>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {courseName} · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button onClick={() => onNavigate('live_session')} className="btn-primary btn-sm flex items-center gap-1.5">
            {activeSessions.length > 0 ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                </span>
                {activeSessions.length} Live Now
              </>
            ) : (
              'Start Attendance'
            )}
          </button>
          <button onClick={() => onNavigate('students')} className="btn-secondary btn-sm">Participants</button>
          <button onClick={() => onNavigate('reports')} className="btn-secondary btn-sm">Reports</button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="section-title">Overall Stats — {courseName}</p>
          <span className="text-[11px] text-slate-400 font-mono">
            Synced {lastSynced.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Total Participants" value={totalStudents} color="text-slate-900 dark:text-slate-100" />
          <StatCard
            label="Sessions Held"
            value={activeSessions.length > 0 ? `${sessionsHeldCount} (${activeSessions.length} live)` : sessionsHeldCount}
            color="text-slate-900 dark:text-slate-100"
          />
          <StatCard label="Overall Attendance %" value={`${overallPct}%`} color="text-emerald-600 dark:text-emerald-400" />
          <StatCard label="Excused" value={excusedTotal} color="text-amber-600 dark:text-amber-400" />
          <StatCard label="Override Entries" value={overrideTotal} color="text-blue-600 dark:text-blue-400" />
          <StatCard label="Manual Entries" value={manualTotal} color="text-purple-600 dark:text-purple-400" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Attendance Trend" subtitle="Day-wise attendance %, general sessions">
          {trendChart.length === 0 ? (
            <EmptyChart text="No sessions recorded yet." />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={trendChart} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={false} tickLine={false} width={36} domain={[0, 100]} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(v: number) => [`${v}%`, 'Attendance']}
                />
                <Bar dataKey="pct" fill={CAT[0]} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="How Attendance Was Marked" subtitle="Across every session this course, to date">
          {methodChart.length === 0 ? (
            <EmptyChart text="No attendance recorded yet." />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={methodChart}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={2}
                  stroke="#fff"
                  strokeWidth={2}
                >
                  {methodChart.map((_, i) => (
                    <Cell key={i} fill={CAT[i % CAT.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12, color: AXIS_INK }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Attendance by Group" subtitle="Average % per assigned group">
          {groupChart.length === 0 ? (
            <EmptyChart text="No participants have been assigned a group yet." />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={groupChart} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="group" tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={false} tickLine={false} width={36} domain={[0, 100]} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(v: number) => [`${v}%`, 'Avg. Attendance']}
                  labelFormatter={(l) => `Group ${l}`}
                />
                <Bar dataKey="pct" fill={CAT[0]} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Roster by School / Centre" subtitle="Active participants, all courses">
          {deptChart.length === 0 ? (
            <EmptyChart text="No students enrolled yet." />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={deptChart} layout="vertical" margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                <CartesianGrid horizontal={false} stroke={GRID} />
                <XAxis type="number" tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="department" tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={false} tickLine={false} width={110} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(v: number) => [v, 'Students']}
                />
                <Bar dataKey="count" fill={CAT[0]} radius={[0, 4, 4, 0]} maxBarSize={20} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      <div className="card">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-[#21262d] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Today's & Active Sessions</p>
            {activeSessions.length > 0 && (
              <span className="badge-green text-[10px] py-0.5">{activeSessions.length} active</span>
            )}
          </div>
          <p className="text-[11px] text-slate-400">Click a session to view real-time attendee records</p>
        </div>
        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">Loading sessions…</div>
        ) : todaySessions.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">No sessions recorded for today yet.</div>
        ) : (
          <div className="divide-y divide-slate-50 dark:divide-[#21262d]">
            {todaySessions.map((s) => {
              const count = todayRecords.filter((r) => r.session_id === s.id).length;
              return (
                <button
                  key={s.id}
                  onClick={() => onOpenSession(s.id)}
                  className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 dark:hover:bg-[#161b22]/60 transition-colors text-left"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2">
                      {s.course_name} · {s.session_type}
                      {s.group_filter && <span className="text-slate-400 font-normal"> · Group {s.group_filter}</span>}
                      {s.status === 'active' && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                          Live
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {new Date(s.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · {s.session_date}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-tabular">{count}</span>
                      <span className="text-xs text-slate-400 ml-1">present</span>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-[#21262d]">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
        <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function EmptyChart({ text }: { text: string }) {
  return <div className="h-[260px] flex items-center justify-center text-sm text-slate-400">{text}</div>;
}

function StatCard({
  label, value, color,
}: { label: string; value: number | string; color: string }) {
  return (
    <div className="stat-card text-left">
      <p className={`text-2xl font-bold font-tabular ${color}`}>{value}</p>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">{label}</p>
    </div>
  );
}
