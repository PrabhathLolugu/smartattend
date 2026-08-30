import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../services/supabase';
import { callFunction } from '../../lib/api';
import { toast } from '../../components/ui/Toast';
import { Modal } from '../../components/ui/Modal';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { AttendanceTable } from '../../components/shared/AttendanceTable';
import { ManualAttendanceModal } from '../../components/shared/ManualAttendanceModal';
import { pctColor, formatDate, formatDateTime, getSessionCategory, getSessionCategoryLabel, getCategoryBadgeClass } from '../../lib/utils';
import { SESSION_TYPE_PRESETS } from '../../types';
import type { Staff, Session, Student, StudentAttendanceSummary, AttendanceRecord, SessionCategory } from '../../types';

interface Props { staff: Staff; courseName: string; focusSessionId?: string | null; onFocusHandled?: () => void; }

const todayISO = () => new Date().toISOString().slice(0, 10);

interface SortState { key: string; dir: 'asc' | 'desc'; }

function compareValues(av: unknown, bv: unknown): number {
  const a = av ?? '';
  const b = bv ?? '';
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function sortRows<T>(rows: T[], sort: SortState): T[] {
  return [...rows].sort((a, b) => {
    const av = (a as Record<string, unknown>)[sort.key];
    const bv = (b as Record<string, unknown>)[sort.key];
    const cmp = compareValues(av, bv);
    return sort.dir === 'asc' ? cmp : -cmp;
  });
}

function Th({ label, sortKey, sort, onSort, className }: { label: string; sortKey: string; sort: SortState; onSort: (key: string) => void; className?: string }) {
  const active = sort.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className={`cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-300 ${className ?? ''}`}>
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[9px] ${active ? 'text-blue-600' : 'text-slate-300 dark:text-slate-600'}`}>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '▲'}
        </span>
      </span>
    </th>
  );
}

export function ReportsPage({ staff, courseName, focusSessionId, onFocusHandled }: Props) {
  const [tab, setTab] = useState<'students' | 'sessions' | 'day'>('students');
  const [categoryView, setCategoryView] = useState<'all' | 'theory' | 'practical'>('all');
  const [sessionCategoryFilter, setSessionCategoryFilter] = useState<'all' | 'theory_lecture' | 'yoga_practical'>('all');
  const [sessions, setSessions] = useState<(Session & { presentCount: number })[]>([]);
  const [summaries, setSummaries] = useState<StudentAttendanceSummary[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [openSession, setOpenSession] = useState<Session | null>(null);
  const [openStudent, setOpenStudent] = useState<StudentAttendanceSummary | null>(null);

  const [studentSearch, setStudentSearch] = useState('');
  const [sessionFrom, setSessionFrom] = useState('');
  const [sessionTo, setSessionTo] = useState('');
  const [dayDate, setDayDate] = useState(todayISO());
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [studentSort, setStudentSort] = useState<SortState>({ key: 'roll_number', dir: 'asc' });
  const [sessionSort, setSessionSort] = useState<SortState>({ key: 'session_date', dir: 'desc' });

  function toggleStudentSort(key: string) {
    setStudentSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }
  function toggleSessionSort(key: string) {
    setSessionSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [{ data: summaryRows }, { data: sessionRows }, { data: studentRows }] = await Promise.all([
        supabase.rpc('student_attendance_summary', { p_course_name: courseName }),
        supabase
          .from('sessions')
          .select('*, attendance_records(count)')
          .ilike('course_name', courseName)
          .order('session_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(500),
        supabase.from('students').select('*').eq('status', 'active').order('roll_number'),
      ]);

      const loadedSessions = (sessionRows ?? []).map((s) => {
        const countData = s.attendance_records as unknown as [{ count: number }] | undefined;
        const presentCount = countData?.[0]?.count ?? 0;
        return { ...s, presentCount };
      });
      setSessions(loadedSessions);
      setStudents(studentRows ?? []);

      // Fetch attendance records specifically for these sessions to avoid cross-course truncation
      const sessionIds = loadedSessions.map((s) => s.id);
      const { data: recordsData } = sessionIds.length > 0
        ? await supabase
            .from('attendance_records')
            .select('session_id, student_id, roll_number, status, method')
            .in('session_id', sessionIds)
            .limit(50000)
        : { data: [] };

      // Index records by student_id AND upper-case roll_number
      const recordsByStudentKey = new Map<string, typeof recordsData>();
      (recordsData ?? []).forEach((r) => {
        if (r.student_id) {
          const list = recordsByStudentKey.get(r.student_id) || [];
          list.push(r);
          recordsByStudentKey.set(r.student_id, list);
        }
        if (r.roll_number) {
          const rollKey = `roll:${r.roll_number.trim().toUpperCase()}`;
          const list = recordsByStudentKey.get(rollKey) || [];
          list.push(r);
          recordsByStudentKey.set(rollKey, list);
        }
      });

      // Group sessions into standalone vs activity rounds to handle parallel session rounds
      const standaloneSessions: typeof loadedSessions = [];
      const roundMap = new Map<string, typeof loadedSessions>();
      loadedSessions.forEach((s) => {
        if (s.round_id) {
          const list = roundMap.get(s.round_id) || [];
          list.push(s);
          roundMap.set(s.round_id, list);
        } else {
          standaloneSessions.push(s);
        }
      });

      const rawSummaries = (summaryRows as StudentAttendanceSummary[]) ?? [];
      const enriched: StudentAttendanceSummary[] = (studentRows ?? []).map((st) => {
        const raw = rawSummaries.find((r) => r.student_id === st.id || r.roll_number.toUpperCase() === st.roll_number.toUpperCase());

        // Get unique attendance records for this student across both ID and Roll matching
        const recsFromId = recordsByStudentKey.get(st.id) || [];
        const recsFromRoll = recordsByStudentKey.get(`roll:${st.roll_number.trim().toUpperCase()}`) || [];
        const studentRecsMap = new Map<string, NonNullable<typeof recordsData>[number]>();
        [...recsFromId, ...recsFromRoll].forEach((r) => {
          if (r) studentRecsMap.set(r.session_id, r);
        });

        let tTotal = 0;
        let tPres = 0;
        let pTotal = 0;
        let pPres = 0;
        let excusedCount = 0;
        let manualCount = 0;
        let overrideCount = 0;

        // 1. Standalone Sessions (accounting for group filters and parallel sessions)
        standaloneSessions.forEach((s) => {
          const applicable = !s.group_filter || s.group_filter === st.group_label;
          const rec = studentRecsMap.get(s.id);
          const attended = rec && ['present', 'manual', 'override'].includes(rec.status);
          const isExcused = rec && rec.status === 'excused';
          const cat = getSessionCategory(s.session_type);

          if (isExcused) excusedCount += 1;

          if (!applicable && !attended) return;

          if (cat === 'theory_lecture') {
            tTotal += 1;
            if (attended) {
              tPres += 1;
              if (rec.method === 'manual' || rec.status === 'manual') manualCount += 1;
              if (['override_code', 'instructor_approved', 'gps_flagged'].includes(rec.method) || rec.status === 'override') overrideCount += 1;
            }
          } else {
            pTotal += 1;
            if (attended) {
              pPres += 1;
              if (rec.method === 'manual' || rec.status === 'manual') manualCount += 1;
              if (['override_code', 'instructor_approved', 'gps_flagged'].includes(rec.method) || rec.status === 'override') overrideCount += 1;
            }
          }
        });

        // 2. Activity Rounds (parallel sessions in same round count as 1 slot)
        roundMap.forEach((roundSessions) => {
          const cat = getSessionCategory(roundSessions[0]?.session_type);
          const appliesToStudent = roundSessions.some((s) => !s.group_filter || s.group_filter === st.group_label);
          const attendedAny = roundSessions.some((s) => {
            const rec = studentRecsMap.get(s.id);
            return rec && ['present', 'manual', 'override'].includes(rec.status);
          });
          const excusedAny = roundSessions.some((s) => {
            const rec = studentRecsMap.get(s.id);
            return rec && rec.status === 'excused';
          });

          if (excusedAny && !attendedAny) excusedCount += 1;
          if (!appliesToStudent && !attendedAny) return;

          if (cat === 'theory_lecture') {
            tTotal += 1;
            if (attendedAny) tPres += 1;
          } else {
            pTotal += 1;
            if (attendedAny) pPres += 1;
          }
        });

        const totalHeld = tTotal + pTotal;
        const totalPres = tPres + pPres;

        const theoryPct = tTotal === 0 ? (tPres > 0 ? 100 : 0) : Math.round((tPres / tTotal) * 1000) / 10;
        const practicalPct = pTotal === 0 ? (pPres > 0 ? 100 : 0) : Math.round((pPres / pTotal) * 1000) / 10;
        const overallPct = totalHeld === 0 ? (totalPres > 0 ? 100 : 0) : Math.round((totalPres / totalHeld) * 1000) / 10;

        return {
          student_id: st.id,
          roll_number: st.roll_number,
          name: st.name,
          role_type: st.role_type,
          department: st.department,
          program: st.program,
          group_label: st.group_label,
          present_count: totalPres,
          excused_count: raw?.excused_count ?? excusedCount,
          manual_count: raw?.manual_count ?? manualCount,
          override_count: raw?.override_count ?? overrideCount,
          total_sessions: totalHeld,
          attendance_percentage: overallPct,
          theory_present_count: tPres,
          theory_total_sessions: tTotal,
          theory_percentage: theoryPct,
          practical_present_count: pPres,
          practical_total_sessions: pTotal,
          practical_percentage: practicalPct,
        };
      });

      setSummaries(enriched);
    } catch (err) {
      console.error('[ReportsPage] Error loading reports:', err);
    } finally {
      setLoading(false);
    }
  }, [courseName]);


  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!focusSessionId) return;
    const match = sessions.find((s) => s.id === focusSessionId);
    if (match) {
      setTab('sessions');
      setOpenSession(match);
      onFocusHandled?.();
      return;
    }
    if (!loading) {
      supabase.from('sessions').select('*').eq('id', focusSessionId).maybeSingle().then(({ data }) => {
        if (data) { setTab('sessions'); setOpenSession(data); }
        onFocusHandled?.();
      });
    }
  }, [focusSessionId, sessions, loading, onFocusHandled]);

  useEffect(() => {
    const channelId = `reports_watch_${courseName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, () => load())
      .subscribe();

    const interval = setInterval(() => {
      load();
    }, 5000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [load, courseName]);

  const filteredSummaries = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    const base = q ? summaries.filter((s) => s.roll_number.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) : summaries;
    return sortRows(base, studentSort);
  }, [summaries, studentSearch, studentSort]);

  const filteredSessions = useMemo(() => {
    const base = sessions.filter((s) => {
      const matchDate = (!sessionFrom || s.session_date >= sessionFrom) && (!sessionTo || s.session_date <= sessionTo);
      const cat = getSessionCategory(s.session_type);
      const matchCat = sessionCategoryFilter === 'all' || cat === sessionCategoryFilter;
      return matchDate && matchCat;
    });
    return sortRows(base, sessionSort);
  }, [sessions, sessionFrom, sessionTo, sessionCategoryFilter, sessionSort]);

  const categoryStats = useMemo(() => {
    const theorySessions = sessions.filter((s) => getSessionCategory(s.session_type) === 'theory_lecture');
    const practicalSessions = sessions.filter((s) => getSessionCategory(s.session_type) === 'yoga_practical');

    const totalStudentsCount = summaries.length || 1;
    const avgTheoryPct = Math.round(
      summaries.reduce((sum, s) => sum + (s.theory_percentage ?? 0), 0) / totalStudentsCount * 10
    ) / 10;
    const avgPracticalPct = Math.round(
      summaries.reduce((sum, s) => sum + (s.practical_percentage ?? 0), 0) / totalStudentsCount * 10
    ) / 10;
    const avgOverallPct = Math.round(
      summaries.reduce((sum, s) => sum + (s.attendance_percentage ?? 0), 0) / totalStudentsCount * 10
    ) / 10;

    return {
      theorySessionsCount: theorySessions.length,
      practicalSessionsCount: practicalSessions.length,
      avgTheoryPct,
      avgPracticalPct,
      avgOverallPct,
    };
  }, [sessions, summaries]);

  async function handleExcelExport() {
    setExporting(true);
    try {
      const res = await callFunction<{ url: string }>('excel-sync', {
        courseName,
        fromDate: exportFrom || undefined,
        toDate: exportTo || undefined,
      });
      window.open(res.url, '_blank');
      toast('success', 'Attendance.xlsx is ready.');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  function handleCsvExport() {
    const header = [
      'Roll Number',
      'Name',
      'Group',
      'Theory Present',
      'Theory Total',
      'Theory Attendance %',
      'Yoga/Practical Present',
      'Yoga/Practical Total',
      'Yoga/Practical Attendance %',
      'Overall Present',
      'Excused',
      'Manual',
      'Override',
      'Total Sessions',
      'Overall Attendance %',
    ];
    const rows = filteredSummaries.map((s) => [
      s.roll_number,
      s.name,
      s.group_label ?? '',
      s.theory_present_count ?? 0,
      s.theory_total_sessions ?? 0,
      `${s.theory_percentage ?? 0}%`,
      s.practical_present_count ?? 0,
      s.practical_total_sessions ?? 0,
      `${s.practical_percentage ?? 0}%`,
      s.present_count,
      s.excused_count,
      s.manual_count,
      s.override_count,
      s.total_sessions,
      `${s.attendance_percentage}%`,
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${courseName.replace(/[^a-zA-Z0-9_-]/g, '_')}_attendance_report.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="page">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Reports — {courseName}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Separate attendance % for Theory/Lecture vs Yoga/Practical classes.</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} className="input-base w-auto text-xs" title="Export from date (optional)" />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} className="input-base w-auto text-xs" title="Export to date (optional)" />
          <button onClick={handleCsvExport} className="btn-secondary btn-sm">Export CSV</button>
          <button onClick={handleExcelExport} disabled={exporting} className="btn-primary btn-sm">
            {exporting ? 'Preparing…' : 'Download Excel'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card p-4 border-l-4 border-l-blue-500 bg-gradient-to-br from-blue-50/30 to-transparent dark:from-blue-950/10">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">📖 Theory & Lecture Set</span>
            <span className="text-[11px] font-medium text-slate-400">{categoryStats.theorySessionsCount} sessions</span>
          </div>
          <p className="text-2xl font-bold font-tabular text-blue-600 dark:text-blue-400 mt-1.5">{categoryStats.avgTheoryPct}%</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Average Theory & Lecture Attendance</p>
        </div>

        <div className="card p-4 border-l-4 border-l-purple-500 bg-gradient-to-br from-purple-50/30 to-transparent dark:from-purple-950/10">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-purple-700 dark:text-purple-400">🧘 Yoga & Practical Set</span>
            <span className="text-[11px] font-medium text-slate-400">{categoryStats.practicalSessionsCount} sessions</span>
          </div>
          <p className="text-2xl font-bold font-tabular text-purple-600 dark:text-purple-400 mt-1.5">{categoryStats.avgPracticalPct}%</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Average Yoga & Practical Attendance</p>
        </div>

        <div className="card p-4 border-l-4 border-l-emerald-500 bg-gradient-to-br from-emerald-50/30 to-transparent dark:from-emerald-950/10">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">📊 Overall Combined</span>
            <span className="text-[11px] font-medium text-slate-400">{sessions.length} total sessions</span>
          </div>
          <p className="text-2xl font-bold font-tabular text-emerald-600 dark:text-emerald-400 mt-1.5">{categoryStats.avgOverallPct}%</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Total Course Attendance</p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200 dark:border-[#21262d]">
        {(['students', 'sessions', 'day'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            {t === 'students' ? 'By Student' : t === 'sessions' ? 'By Session' : 'By Day'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-10 text-center text-sm text-slate-400">Loading reports data…</div>
      ) : tab === 'students' ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <input
              className="input-base max-w-xs"
              placeholder="Search roll number or name…"
              value={studentSearch}
              onChange={(e) => setStudentSearch(e.target.value)}
            />
            <div className="flex items-center bg-slate-100 dark:bg-[#161b22] p-1 rounded-xl border border-slate-200/80 dark:border-[#30363d]">
              <button
                onClick={() => setCategoryView('all')}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
                  categoryView === 'all'
                    ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                All Sets Overview
              </button>
              <button
                onClick={() => setCategoryView('theory')}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
                  categoryView === 'theory'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-blue-600'
                }`}
              >
                📖 Theory & Lecture
              </button>
              <button
                onClick={() => setCategoryView('practical')}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all ${
                  categoryView === 'practical'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-purple-600'
                }`}
              >
                🧘 Yoga & Practical
              </button>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="data-table min-w-[880px]">
              <thead>
                <tr>
                  <Th label="Roll / Emp ID" sortKey="roll_number" sort={studentSort} onSort={toggleStudentSort} />
                  <Th label="Name" sortKey="name" sort={studentSort} onSort={toggleStudentSort} />
                  <Th label="Group" sortKey="group_label" sort={studentSort} onSort={toggleStudentSort} />

                  {categoryView === 'all' && (
                    <>
                      <Th label="Theory (P/Total)" sortKey="theory_present_count" sort={studentSort} onSort={toggleStudentSort} className="bg-blue-50/40 dark:bg-blue-950/10 text-blue-900 dark:text-blue-300" />
                      <Th label="Theory %" sortKey="theory_percentage" sort={studentSort} onSort={toggleStudentSort} className="bg-blue-50/40 dark:bg-blue-950/10 text-blue-900 dark:text-blue-300" />
                      <Th label="Yoga/Pract. (P/Total)" sortKey="practical_present_count" sort={studentSort} onSort={toggleStudentSort} className="bg-purple-50/40 dark:bg-purple-950/10 text-purple-900 dark:text-purple-300" />
                      <Th label="Yoga/Pract. %" sortKey="practical_percentage" sort={studentSort} onSort={toggleStudentSort} className="bg-purple-50/40 dark:bg-purple-950/10 text-purple-900 dark:text-purple-300" />
                      <Th label="Overall %" sortKey="attendance_percentage" sort={studentSort} onSort={toggleStudentSort} />
                    </>
                  )}

                  {categoryView === 'theory' && (
                    <>
                      <Th label="Theory Present" sortKey="theory_present_count" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Theory Total" sortKey="theory_total_sessions" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Theory %" sortKey="theory_percentage" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Excused" sortKey="excused_count" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Manual" sortKey="manual_count" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Override" sortKey="override_count" sort={studentSort} onSort={toggleStudentSort} />
                    </>
                  )}

                  {categoryView === 'practical' && (
                    <>
                      <Th label="Yoga/Pract. Present" sortKey="practical_present_count" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Yoga/Pract. Total" sortKey="practical_total_sessions" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Yoga/Pract. %" sortKey="practical_percentage" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Excused" sortKey="excused_count" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Manual" sortKey="manual_count" sort={studentSort} onSort={toggleStudentSort} />
                      <Th label="Override" sortKey="override_count" sort={studentSort} onSort={toggleStudentSort} />
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredSummaries.length === 0 ? (
                  <tr><td colSpan={10} className="text-center py-10 text-slate-400 text-sm">No matching students.</td></tr>
                ) : filteredSummaries.map((s) => (
                  <tr key={s.student_id} onClick={() => setOpenStudent(s)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-[#161b22]/60">
                    <td className="font-mono font-medium">{s.roll_number}</td>
                    <td className="font-medium">{s.name}</td>
                    <td>{s.group_label ? <span className="badge-blue">{s.group_label}</span> : <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>}</td>

                    {categoryView === 'all' && (
                      <>
                        <td className="bg-blue-50/20 dark:bg-blue-950/5 font-tabular">
                          <span className="font-semibold text-blue-700 dark:text-blue-300">{s.theory_present_count ?? 0}</span>
                          <span className="text-slate-400 text-xs"> / {s.theory_total_sessions ?? 0}</span>
                        </td>
                        <td className="bg-blue-50/20 dark:bg-blue-950/5">
                          <span className={`font-semibold ${pctColor(s.theory_percentage ?? 0)}`}>{s.theory_percentage ?? 0}%</span>
                        </td>
                        <td className="bg-purple-50/20 dark:bg-purple-950/5 font-tabular">
                          <span className="font-semibold text-purple-700 dark:text-purple-300">{s.practical_present_count ?? 0}</span>
                          <span className="text-slate-400 text-xs"> / {s.practical_total_sessions ?? 0}</span>
                        </td>
                        <td className="bg-purple-50/20 dark:bg-purple-950/5">
                          <span className={`font-semibold ${pctColor(s.practical_percentage ?? 0)}`}>{s.practical_percentage ?? 0}%</span>
                        </td>
                        <td>
                          <span className={`font-bold ${pctColor(s.attendance_percentage)}`}>{s.attendance_percentage}%</span>
                        </td>
                      </>
                    )}

                    {categoryView === 'theory' && (
                      <>
                        <td className="font-semibold text-blue-700 dark:text-blue-300 font-tabular">{s.theory_present_count ?? 0}</td>
                        <td className="text-slate-400 font-tabular">{s.theory_total_sessions ?? 0}</td>
                        <td>
                          <span className={`font-bold ${pctColor(s.theory_percentage ?? 0)}`}>{s.theory_percentage ?? 0}%</span>
                        </td>
                        <td className="text-purple-500 font-tabular">{s.excused_count}</td>
                        <td className="font-tabular">{s.manual_count}</td>
                        <td className="font-tabular">{s.override_count}</td>
                      </>
                    )}

                    {categoryView === 'practical' && (
                      <>
                        <td className="font-semibold text-purple-700 dark:text-purple-300 font-tabular">{s.practical_present_count ?? 0}</td>
                        <td className="text-slate-400 font-tabular">{s.practical_total_sessions ?? 0}</td>
                        <td>
                          <span className={`font-bold ${pctColor(s.practical_percentage ?? 0)}`}>{s.practical_percentage ?? 0}%</span>
                        </td>
                        <td className="text-purple-500 font-tabular">{s.excused_count}</td>
                        <td className="font-tabular">{s.manual_count}</td>
                        <td className="font-tabular">{s.override_count}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : tab === 'sessions' ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs text-slate-500 font-medium">Category:</label>
              <select
                value={sessionCategoryFilter}
                onChange={(e) => setSessionCategoryFilter(e.target.value as typeof sessionCategoryFilter)}
                className="input-base w-auto text-xs"
              >
                <option value="all">All Categories</option>
                <option value="theory_lecture">📖 Theory & Lecture</option>
                <option value="yoga_practical">🧘 Yoga & Practical</option>
              </select>

              <label className="text-xs text-slate-500 font-medium ml-2">From</label>
              <input type="date" value={sessionFrom} onChange={(e) => setSessionFrom(e.target.value)} className="input-base w-auto text-xs" />
              <label className="text-xs text-slate-500 font-medium">To</label>
              <input type="date" value={sessionTo} onChange={(e) => setSessionTo(e.target.value)} className="input-base w-auto text-xs" />
              {(sessionFrom || sessionTo || sessionCategoryFilter !== 'all') && (
                <button onClick={() => { setSessionFrom(''); setSessionTo(''); setSessionCategoryFilter('all'); }} className="text-xs text-blue-600 font-medium">Clear</button>
              )}
            </div>
            <span className="text-xs text-slate-400 font-mono">{filteredSessions.length} session(s)</span>
          </div>

          <div className="card overflow-x-auto">
            <table className="data-table min-w-[740px]">
              <thead>
                <tr>
                  <Th label="Date" sortKey="session_date" sort={sessionSort} onSort={toggleSessionSort} />
                  <Th label="Course" sortKey="course_name" sort={sessionSort} onSort={toggleSessionSort} />
                  <Th label="Type" sortKey="session_type" sort={sessionSort} onSort={toggleSessionSort} />
                  <th>Category</th>
                  <Th label="Section" sortKey="group_filter" sort={sessionSort} onSort={toggleSessionSort} />
                  <Th label="Status" sortKey="status" sort={sessionSort} onSort={toggleSessionSort} />
                  <Th label="Present" sortKey="presentCount" sort={sessionSort} onSort={toggleSessionSort} />
                </tr>
              </thead>
              <tbody>
                {filteredSessions.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-10 text-slate-400 text-sm">No sessions found matching filters.</td></tr>
                ) : filteredSessions.map((s) => {
                  const cat = getSessionCategory(s.session_type);
                  return (
                    <tr key={s.id} onClick={() => setOpenSession(s)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-[#161b22]/60">
                      <td>{formatDate(s.session_date)}</td>
                      <td>{s.course_name}</td>
                      <td className="font-medium">{s.session_type}</td>
                      <td>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold ${getCategoryBadgeClass(cat)}`}>
                          {cat === 'yoga_practical' ? '🧘 Yoga & Practical' : '📖 Theory & Lecture'}
                        </span>
                      </td>
                      <td className="text-slate-400">{s.group_filter ? `Group ${s.group_filter}` : 'All'}</td>
                      <td><span className={s.status === 'active' ? 'badge-green' : 'badge-slate'}>{s.status}</span></td>
                      <td className="font-semibold font-tabular">{s.presentCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Date</label>
            <input type="date" value={dayDate} onChange={(e) => setDayDate(e.target.value)} className="input-base w-auto" />
          </div>
          {/* @ts-ignore */}
          <DayAttendanceView date={dayDate} students={students} courseName={courseName} />
        </>
      )}

      {openSession && (
        <SessionDetailModal staff={staff} session={openSession} onClose={() => setOpenSession(null)} onChanged={load} />
      )}
      {openStudent && (
        <StudentDetailModal staff={staff} summary={openStudent} courseName={courseName} onClose={() => setOpenStudent(null)} onChanged={load} />
      )}
    </main>
  );
}

function SessionDetailModal({
  staff,
  session,
  onClose,
  onChanged,
}: {
  staff: Staff;
  session: Session;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState(session);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showManual, setShowManual] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('attendance_records')
        .select('*, student:students(name, department, group_label)')
        .eq('session_id', current.id)
        .order('marked_at', { ascending: false });

      if (error || !data) {
        const { data: plainData } = await supabase
          .from('attendance_records')
          .select('*')
          .eq('session_id', current.id)
          .order('marked_at', { ascending: false });
        setRecords((plainData as AttendanceRecord[]) ?? []);
      } else {
        setRecords((data as unknown as AttendanceRecord[]) ?? []);
      }
    } catch (err) {
      console.error('[SessionDetailModal] Error loading records:', err);
    } finally {
      setLoading(false);
    }
  }, [current.id]);

  useEffect(() => {
    load();
  }, [load]);

  function handleChanged() {
    load();
    onChanged();
  }

  function handleEdited(updated: Session) {
    setCurrent(updated);
    setShowEdit(false);
    onChanged();
  }

  async function handleDelete() {
    const count = records.length;
    const warning = count > 0
      ? ` This will permanently remove it and all ${count} attendance record${count === 1 ? '' : 's'} tied to it.`
      : '';
    if (!window.confirm(`Delete this session?${warning} This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await callFunction('session-delete', { sessionId: current.id });
      toast('success', 'Session deleted.');
      onChanged();
      onClose();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not delete the session.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${current.course_name} — ${current.session_type}`}
      subtitle={`${formatDateTime(current.created_at)} · ${current.group_filter ? `Group ${current.group_filter}` : 'All groups'} · ${current.status}`}
      footer={
        <>
          {staff.role === 'admin' && (
            <button onClick={handleDelete} disabled={deleting} className="btn-danger btn-sm mr-auto">
              {deleting ? 'Deleting…' : 'Delete Session'}
            </button>
          )}
          <button onClick={() => setShowEdit(true)} className="btn-secondary btn-sm">Edit Session</button>
          <button onClick={() => setShowManual(true)} className="btn-secondary btn-sm">+ Add Student</button>
        </>
      }
    >
      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400">Loading attendee records…</div>
      ) : (
        <AttendanceTable
          staff={staff}
          records={records}
          onChanged={handleChanged}
          title={`Session Attendees (${records.length})`}
          emptyText="No attendance recorded for this session."
        />
      )}
      <ManualAttendanceModal open={showManual} onClose={() => setShowManual(false)} session={current} onMarked={handleChanged} />
      <EditSessionModal open={showEdit} onClose={() => setShowEdit(false)} session={current} onSaved={handleEdited} />
    </Modal>
  );
}

function EditSessionModal({
  open,
  onClose,
  session,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  session: Session;
  onSaved: (updated: Session) => void;
}) {
  const [courseName, setCourseName] = useState(session.course_name);
  const [sessionType, setSessionType] = useState(session.session_type);
  const [sessionDate, setSessionDate] = useState(session.session_date);
  const [audience, setAudience] = useState<'general' | 'group'>(session.group_filter ? 'group' : 'general');
  const [groupFilter, setGroupFilter] = useState(session.group_filter ?? '');
  const [radiusMeters, setRadiusMeters] = useState(session.radius_meters);
  const [allowOverride, setAllowOverride] = useState(session.allow_gps_override);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [groupChoices, setGroupChoices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setCourseName(session.course_name);
    setSessionType(session.session_type);
    setSessionDate(session.session_date);
    setAudience(session.group_filter ? 'group' : 'general');
    setGroupFilter(session.group_filter ?? '');
    setRadiusMeters(session.radius_meters);
    setAllowOverride(session.allow_gps_override);
    setNotes(session.notes ?? '');
    setError('');
    supabase
      .from('students')
      .select('group_label')
      .eq('status', 'active')
      .not('group_label', 'is', null)
      .then(({ data }) => {
        setGroupChoices(Array.from(new Set((data ?? []).map((g) => g.group_label as string))).sort());
      });
  }, [open, session]);

  async function handleSave() {
    setError('');
    const finalCourse = courseName.trim();
    const finalType = sessionType.trim();
    const finalGroup = audience === 'group' ? groupFilter.trim().toUpperCase() : '';
    if (!finalCourse) {
      setError('Please name the course.');
      return;
    }
    if (!finalType) {
      setError('Please name the session type.');
      return;
    }
    if (audience === 'group' && !finalGroup) {
      setError('Please pick or type a group.');
      return;
    }
    if (!sessionDate) {
      setError('Please pick a date.');
      return;
    }
    setLoading(true);
    try {
      const res = await callFunction<{ session: Session }>('session-edit', {
        sessionId: session.id,
        courseName: finalCourse,
        sessionType: finalType,
        sessionDate,
        groupFilter: finalGroup || undefined,
        notes: notes.trim() || undefined,
        radiusMeters,
        allowGpsOverride: allowOverride,
      });
      toast('success', 'Session updated.');
      onSaved(res.session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the session.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit Session" subtitle="Fix a mistake — course, type, date, audience, or GPS settings." size="sm">
      <div className="flex flex-col gap-4">
        <div>
          <label className="label">Course</label>
          <input className="input-base" value={courseName} onChange={(e) => setCourseName(e.target.value)} />
        </div>
        <div>
          <label className="label">Session Type</label>
          <input className="input-base" value={sessionType} onChange={(e) => setSessionType(e.target.value)} list="edit-session-type-presets" />
          <datalist id="edit-session-type-presets">
            {SESSION_TYPE_PRESETS.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
        <div>
          <label className="label">Date</label>
          <input type="date" className="input-base" value={sessionDate} onChange={(e) => setSessionDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Audience</label>
          <select value={audience} onChange={(e) => setAudience(e.target.value as 'general' | 'group')} className="input-base">
            <option value="general">General — everyone can attend</option>
            <option value="group">Specific group</option>
          </select>
          {audience === 'group' && (
            <div className="mt-2">
              <input
                className="input-base"
                placeholder="e.g. I"
                maxLength={3}
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                list="edit-session-group-choices"
              />
              <datalist id="edit-session-group-choices">
                {groupChoices.map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">GPS Radius (m)</label>
            <input type="number" min={10} className="input-base" value={radiusMeters} onChange={(e) => setRadiusMeters(Number(e.target.value))} />
          </div>
          <div className="flex items-end pb-2.5">
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <input type="checkbox" checked={allowOverride} onChange={(e) => setAllowOverride(e.target.checked)} className="rounded" />
              Allow GPS override
            </label>
          </div>
        </div>
        <div>
          <label className="label">Notes</label>
          <input className="input-base" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
        {error && <div className="px-4 py-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-700 dark:text-red-400 text-xs">{error}</div>}
        <button onClick={handleSave} disabled={loading} className="btn-primary w-full h-11">
          {loading ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </Modal>
  );
}

interface MergedDay {
  session: Session;
  record: AttendanceRecord | null;
}

function StudentDetailModal({
  staff,
  summary,
  courseName,
  onClose,
  onChanged,
}: {
  staff: Staff;
  summary: StudentAttendanceSummary;
  courseName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<MergedDay[]>([]);
  const [modalCategoryFilter, setModalCategoryFilter] = useState<'all' | 'theory_lecture' | 'yoga_practical'>('all');
  const [profile, setProfile] = useState<Student | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<AttendanceRecord['status']>('present');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [
        { data: allSessions },
        { data: myRecords },
        { data: studentRow },
      ] = await Promise.all([
        supabase
          .from('sessions')
          .select('*')
          .ilike('course_name', courseName)
          .order('session_date', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase
          .from('attendance_records')
          .select('*')
          .or(`student_id.eq.${summary.student_id},roll_number.ilike.${summary.roll_number.trim()}`),
        supabase
          .from('students')
          .select('*')
          .eq('id', summary.student_id)
          .maybeSingle(),
      ]);

      const recordBySession = new Map((myRecords ?? []).map((r) => [r.session_id, r]));
      const applicable = (allSessions ?? []).filter((s) => !s.group_filter || s.group_filter === summary.group_label || recordBySession.has(s.id));
      setRows(applicable.map((s) => ({ session: s, record: recordBySession.get(s.id) ?? null })));
      setProfile(studentRow ?? null);

    } catch (err) {
      console.error('[StudentDetailModal] Error loading student records:', err);
    } finally {
      setLoading(false);
    }
  }, [summary.student_id, summary.roll_number, summary.group_label, courseName]);

  useEffect(() => {
    load();
  }, [load]);

  function handleChanged() {
    load();
    onChanged();
  }

  async function saveEdit(record: AttendanceRecord) {
    setBusyId(record.id);
    try {
      await callFunction('attendance-edit', { recordId: record.id, status: editStatus, notes: record.notes ?? null });
      toast('success', 'Attendance updated.');
      setEditingId(null);
      handleChanged();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not update attendance.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(record: AttendanceRecord) {
    if (!window.confirm('Remove this attendance record?')) return;
    setBusyId(record.id);
    try {
      await callFunction('attendance-delete', { recordId: record.id });
      toast('success', 'Attendance record removed.');
      handleChanged();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not delete attendance record.');
    } finally {
      setBusyId(null);
    }
  }

  const EDITABLE: AttendanceRecord['status'][] = ['present', 'manual', 'override', 'excused'];

  const filteredRows = useMemo(() => {
    if (modalCategoryFilter === 'all') return rows;
    return rows.filter((r) => getSessionCategory(r.session.session_type) === modalCategoryFilter);
  }, [rows, modalCategoryFilter]);

  const theoryRowsCount = useMemo(() => rows.filter((r) => getSessionCategory(r.session.session_type) === 'theory_lecture').length, [rows]);
  const practicalRowsCount = useMemo(() => rows.filter((r) => getSessionCategory(r.session.session_type) === 'yoga_practical').length, [rows]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={summary.name}
      subtitle={`${summary.roll_number} · ${summary.group_label ? `Group ${summary.group_label}` : 'No group'}`}
    >
      {profile && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mb-4 pb-4 border-b border-slate-100 dark:border-[#21262d]">
          <ProfileField label="Roll / Emp ID" value={profile.roll_number} />
          <ProfileField label="Role" value={profile.role_type === 'faculty' ? 'Faculty / Staff' : 'Student'} />
          <ProfileField label="School / Centre" value={profile.department} />
          {profile.role_type !== 'faculty' && <ProfileField label="Program" value={profile.program} />}
        </div>
      )}

      {/* Two Separate Attendance % Badges: Theory vs Yoga/Practical */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="p-3 rounded-xl border border-blue-200/80 dark:border-blue-500/20 bg-blue-50/50 dark:bg-blue-950/20">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">📖 Theory & Lecture</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-xl font-bold text-blue-700 dark:text-blue-300 font-tabular">
              {summary.theory_percentage ?? 0}%
            </span>
            <span className="text-xs text-slate-500 font-tabular">
              ({summary.theory_present_count ?? 0} / {summary.theory_total_sessions ?? 0} attended)
            </span>
          </div>
        </div>

        <div className="p-3 rounded-xl border border-purple-200/80 dark:border-purple-500/20 bg-purple-50/50 dark:bg-purple-950/20">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-purple-700 dark:text-purple-400">🧘 Yoga & Practical</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-xl font-bold text-purple-700 dark:text-purple-300 font-tabular">
              {summary.practical_percentage ?? 0}%
            </span>
            <span className="text-xs text-slate-500 font-tabular">
              ({summary.practical_present_count ?? 0} / {summary.practical_total_sessions ?? 0} attended)
            </span>
          </div>
        </div>

        <div className="p-3 rounded-xl border border-slate-200 dark:border-[#30363d] bg-slate-50 dark:bg-[#161b22]/50">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">📊 Overall Attendance</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className={`text-xl font-bold font-tabular ${pctColor(summary.attendance_percentage)}`}>
              {summary.attendance_percentage}%
            </span>
            <span className="text-xs text-slate-500 font-tabular">
              ({summary.present_count} / {summary.total_sessions} total)
            </span>
          </div>
        </div>
      </div>

      {/* Category Filter Pills */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setModalCategoryFilter('all')}
          className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors ${
            modalCategoryFilter === 'all'
              ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
              : 'bg-slate-100 dark:bg-[#21262d] text-slate-600 dark:text-slate-400'
          }`}
        >
          All Sessions ({rows.length})
        </button>
        <button
          onClick={() => setModalCategoryFilter('theory_lecture')}
          className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors ${
            modalCategoryFilter === 'theory_lecture'
              ? 'bg-blue-600 text-white'
              : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
          }`}
        >
          📖 Theory & Lecture ({theoryRowsCount})
        </button>
        <button
          onClick={() => setModalCategoryFilter('yoga_practical')}
          className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors ${
            modalCategoryFilter === 'yoga_practical'
              ? 'bg-purple-600 text-white'
              : 'bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300'
          }`}
        >
          🧘 Yoga & Practical ({practicalRowsCount})
        </button>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400">Loading student attendance log…</div>
      ) : filteredRows.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-400">No sessions match this category filter for this student.</div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Course</th>
                <th>Type & Category</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ session, record }) => {
                const cat = getSessionCategory(session.session_type);
                return (
                  <tr key={session.id}>
                    <td>{formatDate(session.session_date)}</td>
                    <td>{session.course_name}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900 dark:text-slate-100">{session.session_type}</span>
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${getCategoryBadgeClass(cat)}`}>
                          {cat === 'yoga_practical' ? '🧘 Practical' : '📖 Theory'}
                        </span>
                      </div>
                    </td>
                    <td>
                      {record ? (
                        editingId === record.id ? (
                          <select
                            value={editStatus}
                            onChange={(e) => setEditStatus(e.target.value as AttendanceRecord['status'])}
                            className="text-xs border border-slate-200 dark:border-[#30363d] rounded-lg px-2 py-1 bg-white dark:bg-[#0d1117]"
                          >
                            {EDITABLE.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        ) : (
                          <StatusBadge status={record.status} />
                        )
                      ) : (
                        <span className="badge-red">Absent</span>
                      )}
                    </td>
                    <td>
                      {record && (
                        <div className="flex gap-2 justify-end">
                          {editingId === record.id ? (
                            <>
                              <button onClick={() => saveEdit(record)} disabled={busyId === record.id} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">Save</button>
                              <button onClick={() => setEditingId(null)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => { setEditingId(record.id); setEditStatus(record.status); }} className="text-xs text-blue-600 hover:text-blue-700 font-medium">Edit</button>
                              {staff.role === 'admin' && (
                                <button onClick={() => handleDelete(record)} disabled={busyId === record.id} className="text-xs text-red-600 hover:text-red-700 font-medium">Delete</button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function ProfileField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-[11px] text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5">{value || <span className="text-slate-300 dark:text-slate-600">—</span>}</p>
    </div>
  );
}

function DayAttendanceView({ date, students, courseName }: { date: string; students: Student[]; courseName: string }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [dayCategoryFilter, setDayCategoryFilter] = useState<'all' | 'theory_lecture' | 'yoga_practical'>('all');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const { data: sess } = await supabase
          .from('sessions')
          .select('*')
          .eq('session_date', date)
          .ilike('course_name', courseName)
          .order('created_at');
        if (cancelled) return;
        setSessions(sess ?? []);
        if (sess?.length) {
          const { data: recs } = await supabase
            .from('attendance_records')
            .select('*')
            .in('session_id', sess.map((s) => s.id))
            .limit(20000);
          if (!cancelled) setRecords(recs ?? []);
        } else {
          setRecords([]);
        }
      } catch (err) {
        console.error('[DayAttendanceView] Error loading day records:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date, courseName]);

  const filteredSessions = useMemo(() => {
    if (dayCategoryFilter === 'all') return sessions;
    return sessions.filter((s) => getSessionCategory(s.session_type) === dayCategoryFilter);
  }, [sessions, dayCategoryFilter]);

  const filteredStudents = useMemo(() => {
    if (!search.trim()) return students;
    const q = search.toLowerCase();
    return students.filter((s) => s.roll_number.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [students, search]);

  if (loading) return <div className="card p-10 text-center text-sm text-slate-400">Loading date attendance…</div>;
  if (sessions.length === 0) return <div className="card p-10 text-center text-sm text-slate-400">No sessions found on this date for {courseName}.</div>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input className="input-base max-w-xs" placeholder="Search roll number or name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500 font-medium">Filter Sessions:</label>
          <select
            value={dayCategoryFilter}
            onChange={(e) => setDayCategoryFilter(e.target.value as typeof dayCategoryFilter)}
            className="input-base w-auto text-xs"
          >
            <option value="all">All ({sessions.length})</option>
            <option value="theory_lecture">📖 Theory & Lecture</option>
            <option value="yoga_practical">🧘 Yoga & Practical</option>
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Roll / ID</th>
              <th>Name</th>
              {filteredSessions.map((s) => {
                const cat = getSessionCategory(s.session_type);
                return (
                  <th key={s.id}>
                    <p className="font-semibold">{s.course_name} · {s.session_type}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${getCategoryBadgeClass(cat)}`}>
                        {cat === 'yoga_practical' ? '🧘 Practical' : '📖 Theory'}
                      </span>
                      <span className="text-[10px] text-slate-400 font-normal">{s.group_filter ? `Group ${s.group_filter}` : 'General'}</span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredStudents.map((student) => (
              <tr key={student.id}>
                <td className="font-mono font-medium">{student.roll_number}</td>
                <td>{student.name}</td>
                {filteredSessions.map((s) => {
                  const applicable = !s.group_filter || s.group_filter === student.group_label;
                  const record = records.find(
                    (r) =>
                      r.session_id === s.id &&
                      (r.student_id === student.id || r.roll_number?.toUpperCase() === student.roll_number?.toUpperCase())
                  );
                  return (
                    <td key={s.id}>
                      {!applicable ? (
                        <span className="text-slate-300 dark:text-slate-600">—</span>
                      ) : record ? (
                        <StatusBadge status={record.status} />
                      ) : (
                        <span className="badge-red">Absent</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

