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

interface SessionStatsRow {
  session_id: string;
  course_name: string;
  session_date: string;
  session_type: string;
  group_filter: string | null;
  status: string;
  created_at: string;
  present_count: number;
  excused_count: number;
  manual_count: number;
  override_count: number;
  gps_clean_count: number;
  gps_flagged_count: number;
}

export function DashboardPage({ staff, onNavigate, onOpenSession, courseName }: Props) {
  const [todaySessions, setTodaySessions] = useState<Session[]>([]);
  const [allCourseSessions, setAllCourseSessions] = useState<Session[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStatsRow[]>([]);
  const [totalStudents, setTotalStudents] = useState(0);
  const [summaries, setSummaries] = useState<StudentAttendanceSummary[]>([]);
  const [demographics, setDemographics] = useState<{ department: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState<Date>(new Date());

  const load = useCallback(async (isInitial = false) => {
    try {
      if (isInitial) setLoading(true);
      const today = new Date().toISOString().slice(0, 10);

      const [
        { data: sessionRows },
        { data: roster },
        { data: summaryRows },
        { data: statsRows },
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
        supabase
          .rpc('get_course_session_stats', { p_course_name: courseName }),
      ]);

      const sessions = sessionRows ?? [];
      setAllCourseSessions(sessions);
      const parsedSummaries: StudentAttendanceSummary[] = (summaryRows ?? []).map((r: any) => ({
        ...r,
        present_count: Number(r.present_count ?? 0),
        excused_count: Number(r.excused_count ?? 0),
        manual_count: Number(r.manual_count ?? 0),
        override_count: Number(r.override_count ?? 0),
        total_sessions: Number(r.total_sessions ?? 0),
        attendance_percentage: Number(r.attendance_percentage ?? 0),
        theory_present_count: Number(r.theory_present_count ?? 0),
        theory_total_sessions: Number(r.theory_total_sessions ?? 0),
        theory_percentage: Number(r.theory_percentage ?? 0),
        practical_present_count: Number(r.practical_present_count ?? 0),
        practical_total_sessions: Number(r.practical_total_sessions ?? 0),
        practical_percentage: Number(r.practical_percentage ?? 0),
      }));
      setSummaries(parsedSummaries);
      setTotalStudents(roster?.length ?? 0);

      const parsedStats: SessionStatsRow[] = (statsRows ?? []).map((r: any) => ({
        ...r,
        present_count: Number(r.present_count ?? 0),
        excused_count: Number(r.excused_count ?? 0),
        manual_count: Number(r.manual_count ?? 0),
        override_count: Number(r.override_count ?? 0),
        gps_clean_count: Number(r.gps_clean_count ?? 0),
        gps_flagged_count: Number(r.gps_flagged_count ?? 0),
      }));
      setSessionStats(parsedStats);

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

      setLastSynced(new Date());
    } catch (err) {
      console.error('[DashboardPage] Error loading dashboard stats:', err);
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [courseName]);

  useEffect(() => {
    load(true);
    const channelId = `dashboard_${courseName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, () => load(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, () => load(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, () => load(false))
      .subscribe();

    // Heartbeat polling fallback to guarantee real-time updates silently
    const pollInterval = setInterval(() => {
      load(false);
    }, 8000);

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

  const overrideTotal = useMemo(() => {
    return sessionStats.reduce((sum, s) => sum + s.override_count, 0);
  }, [sessionStats]);

  const manualTotal = useMemo(() => {
    return sessionStats.reduce((sum, s) => sum + s.manual_count, 0);
  }, [sessionStats]);

  const excusedTotal = useMemo(() => {
    return sessionStats.reduce((sum, s) => sum + s.excused_count, 0);
  }, [sessionStats]);


  const overallPct = useMemo(() => {
    const totalPresent = summaries.reduce((sum, s) => sum + s.present_count, 0);
    const totalSlots = summaries.reduce((sum, s) => sum + s.total_sessions, 0);
    if (totalSlots > 0) {
      return Math.round((totalPresent / totalSlots) * 1000) / 10;
    }
    // Fallback: If sessions are held or active, calculate from sessionStats / (totalStudents * totalSessions)
    if (totalStudents > 0 && allCourseSessions.length > 0) {
      const presentRecords = sessionStats.reduce((sum, s) => sum + s.present_count, 0);
      const expectedTotal = totalStudents * allCourseSessions.length;
      return Math.min(100, Math.round((presentRecords / expectedTotal) * 1000) / 10);
    }
    return 0;
  }, [summaries, totalStudents, allCourseSessions.length, sessionStats]);


  const [trendCategory, setTrendCategory] = useState<'theory' | 'practical' | 'all'>('theory');
  const [selectedGroup, setSelectedGroup] = useState<string>('all');

  const groupRosterCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    summaries.forEach((s) => {
      const g = s.group_label || 'Unassigned';
      counts[g] = (counts[g] ?? 0) + 1;
    });
    return counts;
  }, [summaries]);

  const categoryStats = useMemo(() => {
    const theorySessions = allCourseSessions.filter((s) => {
      const t = (s.session_type || '').toLowerCase();
      return !(t.includes('yoga') || t.includes('yiga') || t.includes('practical') || t.includes('pract') || t.includes('lab') || t.includes('activity') || t.includes('meditation'));
    });
    const practicalSessions = allCourseSessions.filter((s) => {
      const t = (s.session_type || '').toLowerCase();
      return (t.includes('yoga') || t.includes('yiga') || t.includes('practical') || t.includes('pract') || t.includes('lab') || t.includes('activity') || t.includes('meditation'));
    });

    const totalStudentsCount = summaries.length || 1;
    const avgTheoryPct = Math.round(
      summaries.reduce((sum, s) => sum + (s.theory_percentage ?? 0), 0) / totalStudentsCount * 10
    ) / 10;
    const avgPracticalPct = Math.round(
      summaries.reduce((sum, s) => sum + (s.practical_percentage ?? 0), 0) / totalStudentsCount * 10
    ) / 10;

    // Student distribution in Theory
    const theoryHigh = summaries.filter((s) => (s.theory_percentage ?? 0) >= 85).length;
    const theoryMid = summaries.filter((s) => (s.theory_percentage ?? 0) >= 75 && (s.theory_percentage ?? 0) < 85).length;
    const theoryLow = summaries.filter((s) => (s.theory_percentage ?? 0) < 75).length;

    // Group-wise Yoga & Practical stats
    const groupPracticalStats: Record<string, { studentCount: number; sumPct: number; sessionsHeld: number }> = {};
    summaries.forEach((s) => {
      if (!s.group_label) return;
      groupPracticalStats[s.group_label] ??= { studentCount: 0, sumPct: 0, sessionsHeld: 0 };
      groupPracticalStats[s.group_label].studentCount += 1;
      groupPracticalStats[s.group_label].sumPct += (s.practical_percentage ?? 0);
    });

    // Count sessions held per group
    practicalSessions.forEach((s) => {
      if (s.group_filter && groupPracticalStats[s.group_filter]) {
        groupPracticalStats[s.group_filter].sessionsHeld += 1;
      }
    });

    const groupPracticalList = Object.entries(groupPracticalStats)
      .map(([group, data]) => ({
        group,
        studentCount: data.studentCount,
        sessionsHeld: data.sessionsHeld,
        avgPct: data.studentCount > 0 ? Math.round((data.sumPct / data.studentCount) * 10) / 10 : 0,
      }))
      .sort((a, b) => a.group.localeCompare(b.group));

    return {
      theorySessionsCount: theorySessions.length,
      practicalSessionsCount: practicalSessions.length,
      avgTheoryPct,
      avgPracticalPct,
      theoryHigh,
      theoryMid,
      theoryLow,
      groupPracticalList,
    };
  }, [allCourseSessions, summaries]);

  // Full-data chronological session attendance trend
  const sessionTrendData = useMemo(() => {
    const isPracticalType = (type: string) => {
      const t = (type || '').toLowerCase();
      return (
        t.includes('yoga') ||
        t.includes('yiga') ||
        t.includes('practical') ||
        t.includes('pract') ||
        t.includes('lab') ||
        t.includes('activity') ||
        t.includes('meditation')
      );
    };

    let filtered = sessionStats;
    if (trendCategory === 'theory') {
      filtered = sessionStats.filter((s) => !isPracticalType(s.session_type));
    } else if (trendCategory === 'practical') {
      filtered = sessionStats.filter((s) => isPracticalType(s.session_type));
      if (selectedGroup !== 'all') {
        filtered = filtered.filter((s) => !s.group_filter || s.group_filter === selectedGroup);
      }
    }

    return filtered.map((s) => {
      const isPract = isPracticalType(s.session_type);
      const targetRoster = s.group_filter ? (groupRosterCounts[s.group_filter] || 45) : (totalStudents || 388);
      const present = s.present_count;
      const pct = targetRoster > 0 ? Math.min(100, Math.round((present / targetRoster) * 1000) / 10) : 0;
      const dateStr = new Date(s.session_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
      const label = s.group_filter ? `${dateStr} (Grp ${s.group_filter})` : dateStr;

      return {
        id: s.session_id,
        date: dateStr,
        label,
        type: s.session_type,
        group: s.group_filter || 'All Students',
        isPractical: isPract,
        present,
        targetRoster,
        pct,
      };
    });
  }, [sessionStats, trendCategory, selectedGroup, groupRosterCounts, totalStudents]);

  const groupChart = useMemo(() => {
    return categoryStats.groupPracticalList.map((g) => ({
      group: `Group ${g.group}`,
      pct: g.avgPct,
      sessions: g.sessionsHeld,
      count: g.studentCount,
    }));
  }, [categoryStats.groupPracticalList]);

  const methodChart = useMemo(() => {
    const clean = sessionStats.reduce((sum, s) => sum + s.gps_clean_count, 0);
    const flagged = sessionStats.reduce((sum, s) => sum + s.gps_flagged_count, 0);
    const override = sessionStats.reduce((sum, s) => sum + s.override_count, 0);
    const manual = sessionStats.reduce((sum, s) => sum + s.manual_count, 0);

    const res = [];
    if (clean > 0) res.push({ name: 'QR Scan (Verified)', value: clean });
    if (flagged > 0) res.push({ name: 'QR Scan (Flagged)', value: flagged });
    if (override > 0) res.push({ name: 'Override Code / Approved', value: override });
    if (manual > 0) res.push({ name: 'Manual Entry', value: manual });
    return res;
  }, [sessionStats]);


  const deptChart = useMemo(() => {
    if (demographics.length <= 8) return demographics;
    const top = demographics.slice(0, 7);
    const rest = demographics.slice(7).reduce((sum, d) => sum + d.count, 0);
    return [...top, { department: 'Other', count: rest }];
  }, [demographics]);

  return (
    <main className="page space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            {getGreeting()}, {staff.name.split(' ')[0]}.
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Course <span className="font-semibold text-slate-700 dark:text-slate-200">{courseName}</span> · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
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
          <button onClick={() => onNavigate('reports')} className="btn-secondary btn-sm">Full Reports</button>
        </div>
      </div>

      {/* ── TOP HERO SECTION: THEORY & LECTURE CLASSES (MAIN FOCUS) ── */}
      <div className="card p-5 border-2 border-blue-200/80 dark:border-blue-500/30 bg-gradient-to-br from-blue-50/50 via-white to-blue-50/20 dark:from-blue-950/20 dark:via-[#161b22] dark:to-transparent shadow-sm">
        <div className="flex items-center justify-between gap-4 flex-wrap pb-4 border-b border-blue-100 dark:border-blue-900/30">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white text-lg shadow-sm">
              📖
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Theory & Lecture Classes (Main Attendance)</h2>
              <p className="text-xs text-slate-500">Core lecture attendance benchmarks across all {totalStudents} enrolled students</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200">
            Primary Academic Metric
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4">
          <div className="bg-white/80 dark:bg-[#1c2128] p-3.5 rounded-xl border border-blue-100 dark:border-[#30363d]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Class Average</p>
            <p className="text-3xl font-extrabold text-blue-700 dark:text-blue-300 font-tabular mt-1">{categoryStats.avgTheoryPct}%</p>
            <p className="text-[11px] text-slate-400 mt-0.5">Average across all students</p>
          </div>

          <div className="bg-white/80 dark:bg-[#1c2128] p-3.5 rounded-xl border border-blue-100 dark:border-[#30363d]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Theory Sessions Held</p>
            <p className="text-3xl font-extrabold text-slate-800 dark:text-slate-100 font-tabular mt-1">{categoryStats.theorySessionsCount}</p>
            <p className="text-[11px] text-slate-400 mt-0.5">Full cohort theory lectures</p>
          </div>

          <div className="bg-white/80 dark:bg-[#1c2128] p-3.5 rounded-xl border border-blue-100 dark:border-[#30363d]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Good Standing (≥85%)</p>
            <p className="text-3xl font-extrabold text-emerald-600 dark:text-emerald-400 font-tabular mt-1">{categoryStats.theoryHigh}</p>
            <p className="text-[11px] text-slate-400 mt-0.5">Students with ≥ 85% Theory attendance</p>
          </div>

          <div className="bg-white/80 dark:bg-[#1c2128] p-3.5 rounded-xl border border-blue-100 dark:border-[#30363d]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">Needs Attention (&lt;75%)</p>
            <p className="text-3xl font-extrabold text-amber-600 dark:text-amber-400 font-tabular mt-1">{categoryStats.theoryLow}</p>
            <p className="text-[11px] text-slate-400 mt-0.5">Students below 75% threshold</p>
          </div>
        </div>
      </div>

      {/* ── SECOND SECTION: GROUP-WISE YOGA & PRACTICAL BREAKDOWN ── */}
      <div className="card p-5 border border-purple-200/70 dark:border-purple-500/20 bg-gradient-to-br from-purple-50/30 via-white to-transparent dark:from-purple-950/10 dark:via-[#161b22]">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-purple-600 flex items-center justify-center text-white text-base shadow-sm">
              🧘
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Yoga & Practical Classes (Group-Wise Breakdown)</h2>
                <span className="badge-purple font-semibold text-xs">{categoryStats.avgPracticalPct}% Avg</span>
              </div>
              <p className="text-xs text-slate-500">{categoryStats.practicalSessionsCount} practical & yoga sessions conducted across sections</p>
            </div>
          </div>
        </div>

        {/* Group-wise Cards Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
          {categoryStats.groupPracticalList.map((g) => (
            <div
              key={g.group}
              className="p-3 rounded-xl bg-white dark:bg-[#1c2128] border border-purple-100 dark:border-[#30363d] text-center hover:border-purple-300 transition-all shadow-xs"
            >
              <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-bold bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
                Group {g.group}
              </span>
              <p className="text-xl font-bold font-tabular text-slate-800 dark:text-slate-100 mt-1.5">
                {g.avgPct}%
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5">{g.sessionsHeld} sess · {g.studentCount} stu</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── OVERALL OVERVIEW SUMMARY ROW ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="section-title">Course Total & Log Metrics</p>
          <span className="text-[11px] text-slate-400 font-mono">
            Synced {lastSynced.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Participants" value={totalStudents} subtitle="Enrolled in roster" color="text-slate-900 dark:text-slate-100" />
          <StatCard label="Total Course Sessions" value={allCourseSessions.length} subtitle={`${categoryStats.theorySessionsCount} theory · ${categoryStats.practicalSessionsCount} practical`} color="text-slate-900 dark:text-slate-100" />
          <StatCard label="Combined Attendance %" value={`${overallPct}%`} subtitle="Full aggregate attendance" color="text-emerald-600 dark:text-emerald-400" />
          <StatCard label="Override / Manual Records" value={overrideTotal + manualTotal} subtitle={`${overrideTotal} overrides · ${manualTotal} manual`} color="text-blue-600 dark:text-blue-400" />
        </div>
      </div>

      {/* ── PLOTS & CHARTS WITH COMPLETE DATA ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Full-data Chronological Attendance Trend Chart */}
        <ChartCard
          title="Session-by-Session Attendance Trend"
          subtitle="Accurate attendance % calculated per session's target audience"
        >
          <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
            <div className="flex bg-slate-100 dark:bg-[#161b22] p-1 rounded-xl border border-slate-200 dark:border-[#30363d]">
              <button
                onClick={() => { setTrendCategory('theory'); setSelectedGroup('all'); }}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
                  trendCategory === 'theory' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 dark:text-slate-400 hover:text-blue-600'
                }`}
              >
                📖 Theory Classes ({categoryStats.theorySessionsCount})
              </button>
              <button
                onClick={() => setTrendCategory('practical')}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
                  trendCategory === 'practical' ? 'bg-purple-600 text-white shadow-xs' : 'text-slate-600 dark:text-slate-400 hover:text-purple-600'
                }`}
              >
                🧘 Yoga/Practical ({categoryStats.practicalSessionsCount})
              </button>
              <button
                onClick={() => { setTrendCategory('all'); setSelectedGroup('all'); }}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
                  trendCategory === 'all' ? 'bg-slate-800 text-white shadow-xs' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                All ({allCourseSessions.length})
              </button>
            </div>

            {trendCategory === 'practical' && (
              <select
                value={selectedGroup}
                onChange={(e) => setSelectedGroup(e.target.value)}
                className="input-base text-xs py-1 w-auto"
              >
                <option value="all">All Groups</option>
                {categoryStats.groupPracticalList.map((g) => (
                  <option key={g.group} value={g.group}>Group {g.group}</option>
                ))}
              </select>
            )}
          </div>

          {sessionTrendData.length === 0 ? (
            <EmptyChart text="No sessions found for this category." />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={sessionTrendData} margin={{ top: 8, right: 12, left: -12, bottom: 20 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: AXIS_INK }} angle={-25} textAnchor="end" height={40} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={false} tickLine={false} width={36} domain={[0, 100]} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(v: number, _name: string, item: any) => [
                    `${v}% (${item.payload.present}/${item.payload.targetRoster} students)`,
                    `${item.payload.type} (Audience: ${item.payload.group})`,
                  ]}
                />
                <Bar
                  dataKey="pct"
                  fill={trendCategory === 'theory' ? '#2563eb' : trendCategory === 'practical' ? '#9333ea' : '#0284c7'}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Group-Wise Yoga & Practical Comparison Chart */}
        <ChartCard title="Yoga & Practical Attendance by Group" subtitle="Average attendance % achieved per assigned group">
          {groupChart.length === 0 ? (
            <EmptyChart text="No groups recorded yet." />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={groupChart} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="group" tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: AXIS_INK }} axisLine={false} tickLine={false} width={36} domain={[0, 100]} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(v: number, _name: string, item: any) => [
                    `${v}% avg (${item.payload.sessions} sessions held)`,
                    'Yoga/Practical Attendance',
                  ]}
                />
                <Bar dataKey="pct" fill="#9333ea" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Attendance Verification Method Distribution */}
        <ChartCard title="How Attendance Was Marked" subtitle="Across every session in this course to date">
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
                  isAnimationActive={false}
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

        {/* Demographics by School / Centre */}
        <ChartCard title="Roster by School / Centre" subtitle="Active participants across departments">
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
                <Bar dataKey="count" fill={CAT[0]} radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false} />
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
        {loading && todaySessions.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">Loading sessions…</div>
        ) : todaySessions.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">No sessions recorded for today yet.</div>
        ) : (
          <div className="divide-y divide-slate-50 dark:divide-[#21262d]">
            {todaySessions.map((s) => {
              const count = sessionStats.find((st) => st.session_id === s.id)?.present_count ?? 0;
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
  label, value, subtitle, color,
}: { label: string; value: number | string; subtitle?: string; color: string }) {
  return (
    <div className="stat-card text-left">
      <p className="text-[11px] text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className={`text-2xl font-bold font-tabular mt-1 ${color}`}>{value}</p>
      {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}
