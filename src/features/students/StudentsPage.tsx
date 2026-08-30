import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../services/supabase';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../components/ui/Toast';
import { pctColor } from '../../lib/utils';
import type { Staff, Student, StudentAttendanceSummary, StudentStatus, ParticipantType } from '../../types';

interface Props { staff: Staff; courseName: string; }

const PAGE_SIZE = 20;
const UNASSIGNED = '__unassigned__';
const emptyForm = { roll_number: '', name: '', role_type: 'student' as ParticipantType, department: '', program: '', group_label: '' };

export function StudentsPage({ staff, courseName }: Props) {
  const [students, setStudents] = useState<Student[]>([]);
  const [summaries, setSummaries] = useState<Record<string, StudentAttendanceSummary>>({});
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<ParticipantType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StudentStatus | 'all'>('active');
  const [groupFilter, setGroupFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [minPct, setMinPct] = useState('');
  const [maxPct, setMaxPct] = useState('');
  const [groupChoices, setGroupChoices] = useState<string[]>([]);
  const [deptChoices, setDeptChoices] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Student | null>(null);
  const [viewing, setViewing] = useState<Student | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkGroup, setBulkGroup] = useState('');

  useEffect(() => {
    supabase.from('students').select('group_label, department').eq('status', 'active').then(({ data }) => {
      setGroupChoices(Array.from(new Set((data ?? []).map((d) => d.group_label).filter(Boolean) as string[])).sort());
      setDeptChoices(Array.from(new Set((data ?? []).map((d) => d.department).filter(Boolean) as string[])).sort());
    });
  }, []);

  const loadSummaries = useCallback(async () => {
    const { data: summaryRows } = await supabase.rpc('student_attendance_summary', { p_course_name: courseName });
    const map: Record<string, StudentAttendanceSummary> = {};
    (summaryRows ?? []).forEach((s: StudentAttendanceSummary) => {
      map[s.roll_number] = s;
      map[s.roll_number.toUpperCase()] = s;
    });
    setSummaries(map);
  }, [courseName]);


  const pctFilterActive = minPct !== '' || maxPct !== '';

  const load = useCallback(async () => {
    try {
      setLoading(true);

      let pctSummaryMap: Record<string, StudentAttendanceSummary> | null = null;
      let query = supabase.from('students').select('*', { count: 'exact' }).order('roll_number');
      if (statusFilter !== 'all') query = query.eq('status', statusFilter);
      if (roleFilter !== 'all') query = query.eq('role_type', roleFilter);
      if (search.trim()) query = query.or(`roll_number.ilike.%${search}%,name.ilike.%${search}%`);
      if (groupFilter === UNASSIGNED) query = query.is('group_label', null);
      else if (groupFilter) query = query.eq('group_label', groupFilter);
      if (deptFilter) query = query.eq('department', deptFilter);
      if (pctFilterActive) {
        const { data: summaryRows } = await supabase.rpc('student_attendance_summary', { p_course_name: courseName });
        pctSummaryMap = {};
        (summaryRows as StudentAttendanceSummary[] ?? []).forEach((s) => { pctSummaryMap![s.roll_number] = s; });
        const min = minPct === '' ? -Infinity : Number(minPct);
        const max = maxPct === '' ? Infinity : Number(maxPct);
        const qualifying = Object.values(pctSummaryMap)
          .filter((s) => s.attendance_percentage >= min && s.attendance_percentage <= max)
          .map((s) => s.roll_number);
        query = query.in('roll_number', qualifying.length > 0 ? qualifying : ['__none__']);
      }

      const { data, count } = await query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      setStudents(data ?? []);
      setTotal(count ?? 0);
      setSelected(new Set());
      if (pctSummaryMap) setSummaries(pctSummaryMap);
      else await loadSummaries();
    } catch (err) {
      console.error('[StudentsPage] Error loading participants:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, roleFilter, groupFilter, deptFilter, pctFilterActive, minPct, maxPct, page, courseName, loadSummaries]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const channelId = `students_summary_watch_${courseName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, () => loadSummaries())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, () => loadSummaries())
      .subscribe();

    const interval = setInterval(() => {
      loadSummaries();
    }, 6000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [loadSummaries, courseName]);

  async function handleSoftDelete(student: Student) {
    if (!window.confirm(`Remove ${student.name} (${student.roll_number})? This can be restored later.`)) return;
    const { error } = await supabase.from('students').update({ status: 'deleted', updated_by: staff.id }).eq('id', student.id);
    if (error) { toast('error', 'Could not remove entry.'); return; }
    toast('success', 'Entry removed.');
    load();
  }

  async function handleRestore(student: Student) {
    const { error } = await supabase.from('students').update({ status: 'active', updated_by: staff.id }).eq('id', student.id);
    if (error) { toast('error', 'Could not restore entry.'); return; }
    toast('success', 'Entry restored.');
    load();
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === students.length ? new Set() : new Set(students.map((s) => s.id))));
  }

  async function handleBulkAssignGroup() {
    if (selected.size === 0 || !bulkGroup.trim()) return;
    const { error } = await supabase
      .from('students')
      .update({ group_label: bulkGroup.trim().toUpperCase(), updated_by: staff.id })
      .in('id', Array.from(selected));
    if (error) { toast('error', 'Could not assign group.'); return; }
    toast('success', `Assigned ${selected.size} participant(s) to Group ${bulkGroup.trim().toUpperCase()}.`);
    setBulkGroup('');
    load();
  }

  return (
    <main className="page">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Participants Roster</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{total} {roleFilter === 'all' ? 'participants' : roleFilter === 'faculty' ? 'faculty / staff' : 'students'} · Attendance % shown for {courseName}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)} className="btn-secondary btn-sm">Import CSV</button>
          <button onClick={() => setShowAdd(true)} className="btn-primary btn-sm">+ Add Participant</button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          className="input-base max-w-xs"
          placeholder="Search Roll / Emp ID or name…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        />
        <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value as ParticipantType | 'all'); setPage(0); }} className="input-base w-auto">
          <option value="all">All Roles</option>
          <option value="student">Students</option>
          <option value="faculty">Faculty / Staff</option>
        </select>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as StudentStatus | 'all'); setPage(0); }} className="input-base w-auto">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="graduated">Graduated</option>
          <option value="deleted">Removed</option>
          <option value="all">All Statuses</option>
        </select>
        <select value={groupFilter} onChange={(e) => { setGroupFilter(e.target.value); setPage(0); }} className="input-base w-auto">
          <option value="">All Groups</option>
          <option value={UNASSIGNED}>Unassigned</option>
          {groupChoices.map((g) => <option key={g} value={g}>Group {g}</option>)}
        </select>
        <select value={deptFilter} onChange={(e) => { setDeptFilter(e.target.value); setPage(0); }} className="input-base w-auto">
          <option value="">All Schools / Centres</option>
          {deptChoices.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {(roleFilter !== 'all' || groupFilter || deptFilter || pctFilterActive) && (
          <button
            onClick={() => { setRoleFilter('all'); setGroupFilter(''); setDeptFilter(''); setMinPct(''); setMaxPct(''); setPage(0); }}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Clear filters
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="card p-3 flex items-center gap-3 bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/20">
          <span className="text-sm font-medium text-blue-900 dark:text-blue-300">{selected.size} selected</span>
          <input
            className="input-base w-32"
            placeholder="Group e.g. B"
            value={bulkGroup}
            onChange={(e) => setBulkGroup(e.target.value)}
            maxLength={3}
          />
          <button onClick={handleBulkAssignGroup} disabled={!bulkGroup.trim()} className="btn-primary btn-sm">Assign Group</button>
          <button onClick={() => setSelected(new Set())} className="btn-ghost btn-sm">Clear selection</button>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="data-table min-w-[760px]">
          <thead>
            <tr>
              <th><input type="checkbox" checked={selected.size > 0 && selected.size === students.length} onChange={toggleSelectAll} /></th>
              <th>Roll / Emp ID</th><th>Name</th><th>Role</th><th>School / Centre</th><th>Program</th><th>Group</th><th>Attendance %</th><th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="text-center py-10 text-slate-400 text-sm">Loading…</td></tr>
            ) : students.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-10 text-slate-400 text-sm">No participants found.</td></tr>
            ) : (
              students.map((s) => {
                const summary = summaries[s.roll_number] || summaries[s.roll_number.toUpperCase()];
                return (

                  <tr key={s.id} onClick={() => setViewing(s)} className="cursor-pointer">
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
                    <td className="font-mono font-medium">{s.roll_number}</td>
                    <td className="font-medium">{s.name}</td>
                    <td>
                      <span className={s.role_type === 'faculty' ? 'badge-blue' : 'badge-slate'}>
                        {s.role_type === 'faculty' ? 'Faculty / Staff' : 'Student'}
                      </span>
                    </td>
                    <td className="text-slate-500 dark:text-slate-400 text-xs">{s.department || '—'}</td>
                    <td className="text-slate-500 dark:text-slate-400 text-xs">{s.program || '—'}</td>
                    <td>{s.group_label ? <span className="badge-blue">{s.group_label}</span> : <span className="text-slate-300 dark:text-slate-600 text-xs">Unassigned</span>}</td>
                    <td>
                      {summary ? (
                        <span className={`font-semibold ${pctColor(summary.attendance_percentage)}`}>{summary.attendance_percentage}%</span>
                      ) : '—'}
                    </td>
                    <td><span className="badge-slate">{s.status}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setEditing(s)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">Edit</button>
                        {s.status === 'deleted' ? (
                          <button onClick={() => handleRestore(s)} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">Restore</button>
                        ) : (
                          <button onClick={() => handleSoftDelete(s)} className="text-xs text-red-600 hover:text-red-700 font-medium">Remove</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="btn-outline btn-sm disabled:opacity-40">Previous</button>
          <span className="text-xs text-slate-400">Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}</span>
          <button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)} className="btn-outline btn-sm disabled:opacity-40">Next</button>
        </div>
      )}

      <StudentFormModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        staff={staff}
        onSaved={() => { setShowAdd(false); load(); }}
      />
      <StudentFormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        staff={staff}
        student={editing}
        onSaved={() => { setEditing(null); load(); }}
      />
      <ImportModal open={showImport} onClose={() => setShowImport(false)} staff={staff} onImported={() => { setShowImport(false); load(); }} />
      <StudentDetailModal
        open={!!viewing}
        onClose={() => setViewing(null)}
        student={viewing}
        summary={viewing ? summaries[viewing.roll_number] : undefined}
        courseName={courseName}
        onEdit={() => { setEditing(viewing); setViewing(null); }}
      />
    </main>
  );
}

function StudentDetailModal({
  open, onClose, student, summary, courseName, onEdit,
}: { open: boolean; onClose: () => void; student: Student | null; summary?: StudentAttendanceSummary; courseName: string; onEdit: () => void }) {
  if (!student) return null;
  return (
    <Modal open={open} onClose={onClose} title={student.name} subtitle={`${student.roll_number} · ${courseName}`} size="sm">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={student.role_type === 'faculty' ? 'badge-blue' : 'badge-slate'}>
            {student.role_type === 'faculty' ? 'Faculty / Staff' : 'Student'}
          </span>
          {student.group_label ? <span className="badge-blue">Group {student.group_label}</span> : <span className="badge-slate">Unassigned group</span>}
          <span className="badge-slate">{student.status}</span>
        </div>

        {summary && (
          <div className="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-[#161b22] border border-slate-200/60 dark:border-[#30363d] text-center">
            <div>
              <p className="text-[10px] text-blue-600 dark:text-blue-400 font-semibold uppercase">Theory %</p>
              <p className={`text-base font-bold font-tabular ${pctColor(summary.theory_percentage ?? summary.attendance_percentage)}`}>
                {summary.theory_percentage ?? summary.attendance_percentage}%
              </p>
            </div>
            <div>
              <p className="text-[10px] text-purple-600 dark:text-purple-400 font-semibold uppercase">Yoga/Pract. %</p>
              <p className={`text-base font-bold font-tabular ${pctColor(summary.practical_percentage ?? summary.attendance_percentage)}`}>
                {summary.practical_percentage ?? summary.attendance_percentage}%
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 font-semibold uppercase">Overall %</p>
              <p className={`text-base font-bold font-tabular ${pctColor(summary.attendance_percentage)}`}>
                {summary.attendance_percentage}%
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <DetailField label={student.role_type === 'faculty' ? 'Employee ID' : 'Roll Number'} value={student.roll_number} />
          <DetailField label="Name" value={student.name} />
          <DetailField label="School / Centre" value={student.department} />
          {student.role_type !== 'faculty' && <DetailField label="Program" value={student.program} />}
          <DetailField label="Group" value={student.group_label} />
          <DetailField label="Status" value={student.status} />
        </div>
        {summary && (
          <div className="grid grid-cols-4 gap-2 pt-3 border-t border-slate-100 dark:border-[#21262d]">
            <MiniStat label="Present" value={summary.present_count} />
            <MiniStat label="Excused" value={summary.excused_count} />
            <MiniStat label="Manual" value={summary.manual_count} />
            <MiniStat label="Override" value={summary.override_count} />
          </div>
        )}
        <button onClick={onEdit} className="btn-secondary w-full h-10">Edit Details</button>
      </div>
    </Modal>
  );
}

function DetailField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-[11px] text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5">{value || <span className="text-slate-300 dark:text-slate-600">—</span>}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="text-lg font-bold text-slate-900 dark:text-slate-100 font-tabular">{value}</p>
      <p className="text-[10px] text-slate-400 uppercase tracking-wide">{label}</p>
    </div>
  );
}

function StudentFormModal({
  open, onClose, staff, student, onSaved,
}: { open: boolean; onClose: () => void; staff: Staff; student?: Student | null; onSaved: () => void }) {
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (student) {
      setForm({
        roll_number: student.roll_number,
        name: student.name,
        role_type: student.role_type ?? 'student',
        department: student.department ?? '',
        program: student.program ?? '',
        group_label: student.group_label ?? '',
      });
    } else {
      setForm(emptyForm);
    }
    setError('');
  }, [student, open]);

  async function handleSave() {
    if (!form.roll_number.trim() || !form.name.trim()) {
      setError(form.role_type === 'faculty' ? 'Employee ID and Name are required.' : 'Roll Number and Name are required.');
      return;
    }
    setLoading(true);
    setError('');
    const payload = {
      roll_number: form.roll_number.trim().toUpperCase(),
      name: form.name.trim(),
      role_type: form.role_type,
      department: form.department.trim() || null,
      program: form.role_type === 'student' ? (form.program.trim() || null) : null,
      group_label: form.group_label.trim().toUpperCase() || null,
    };

    const { error: dbErr } = student
      ? await supabase.from('students').update({ ...payload, updated_by: staff.id }).eq('id', student.id)
      : await supabase.from('students').insert({ ...payload, created_by: staff.id });

    setLoading(false);
    if (dbErr) {
      setError(dbErr.code === '23505' ? 'This ID / Roll number is already registered.' : 'Could not save. Please try again.');
      return;
    }
    toast('success', student ? 'Entry updated.' : 'Entry added.');
    onSaved();
  }

  return (
    <Modal open={open} onClose={onClose} title={student ? 'Edit Participant' : 'Add Participant'} size="md">
      <div className="flex bg-slate-200 dark:bg-[#161b22] p-1 rounded-xl mb-4">
        <button
          type="button"
          onClick={() => setForm((f) => ({ ...f, role_type: 'student' }))}
          className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors ${form.role_type === 'student' ? 'bg-white dark:bg-blue-600 text-blue-600 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'}`}
        >
          🎓 Student
        </button>
        <button
          type="button"
          onClick={() => setForm((f) => ({ ...f, role_type: 'faculty' }))}
          className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors ${form.role_type === 'faculty' ? 'bg-white dark:bg-blue-600 text-blue-600 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'}`}
        >
          🏛️ Faculty / Staff
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label={form.role_type === 'faculty' ? 'Employee ID *' : 'Roll Number *'}
          value={form.roll_number}
          onChange={(v) => setForm((f) => ({ ...f, roll_number: v }))}
          disabled={!!student}
        />
        <Field label="Full Name *" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
        <Field label="School / Centre" value={form.department} onChange={(v) => setForm((f) => ({ ...f, department: v }))} />
        {form.role_type === 'student' && (
          <Field label="Program (e.g. B.Tech, M.Tech)" value={form.program} onChange={(v) => setForm((f) => ({ ...f, program: v }))} />
        )}
        <Field label="Group (e.g. B)" value={form.group_label} onChange={(v) => setForm((f) => ({ ...f, group_label: v }))} />
      </div>
      {error && <div className="mt-3 px-4 py-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-700 dark:text-red-400 text-xs">{error}</div>}
      <button onClick={handleSave} disabled={loading} className="btn-primary w-full h-11 mt-5">{loading ? 'Saving…' : 'Save'}</button>
    </Modal>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input-base" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

interface ParsedRow { roll_number: string; name: string; role_type?: ParticipantType; department?: string; program?: string; group_label?: string; error?: string; }

function parseCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const splitLine = (line: string) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);

  const rollIdx = col('roll_number') !== -1 ? col('roll_number') : col('roll');
  const nameIdx = col('name');
  const groupIdx = col('group') !== -1 ? col('group') : col('group_label');
  if (rollIdx === -1 || nameIdx === -1) return [];

  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const roleVal = cells[col('role_type')] || cells[col('type')];
    const row: ParsedRow = {
      roll_number: (cells[rollIdx] || '').toUpperCase(),
      name: cells[nameIdx] || '',
      role_type: roleVal?.toLowerCase().includes('fac') ? 'faculty' : 'student',
      department: cells[col('department')] || cells[col('school')] || undefined,
      program: cells[col('program')] || undefined,
      group_label: groupIdx !== -1 ? (cells[groupIdx] || undefined)?.toUpperCase() : undefined,
    };
    if (!row.roll_number || !row.name) row.error = 'Missing Roll/Emp ID or name';
    return row;
  });
}

function ImportModal({ open, onClose, staff, onImported }: { open: boolean; onClose: () => void; staff: Staff; onImported: () => void }) {
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setRows(parseCsv(String(reader.result)));
    reader.readAsText(file);
  }

  async function handleImport() {
    const valid = rows.filter((r) => !r.error);
    if (valid.length === 0) { setError('No valid rows to import.'); return; }
    setLoading(true);
    setError('');
    const { error: dbErr } = await supabase.from('students').upsert(
      valid.map((r) => ({
        roll_number: r.roll_number, name: r.name, role_type: r.role_type ?? 'student',
        department: r.department || null, program: r.program || null,
        group_label: r.group_label || null, created_by: staff.id,
      })),
      { onConflict: 'roll_number', ignoreDuplicates: true },
    );
    setLoading(false);
    if (dbErr) { setError('Import failed: ' + dbErr.message); return; }
    toast('success', `Imported ${valid.length} participants.`);
    setRows([]);
    onImported();
  }

  return (
    <Modal open={open} onClose={onClose} title="Import Participants" subtitle="CSV with columns: roll_number, name, role_type, department, program, group" size="lg">
      <input type="file" accept=".csv" onChange={handleFile} className="text-sm" />
      {rows.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-slate-500 mb-2">
            {rows.filter((r) => !r.error).length} valid · {rows.filter((r) => r.error).length} skipped
          </p>
          <div className="max-h-64 overflow-y-auto border border-slate-100 dark:border-[#21262d] rounded-xl">
            <table className="data-table">
              <thead><tr><th>Roll / Emp ID</th><th>Name</th><th>Role</th><th>School / Centre</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="font-mono">{r.roll_number || '—'}</td>
                    <td>{r.name || '—'}</td>
                    <td>{r.role_type === 'faculty' ? 'Faculty / Staff' : 'Student'}</td>
                    <td>{r.department || '—'}</td>
                    <td>{r.error ? <span className="badge-red">{r.error}</span> : <span className="badge-green">Ready</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {error && <div className="mt-3 px-4 py-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-700 dark:text-red-400 text-xs">{error}</div>}
      <button onClick={handleImport} disabled={loading || rows.length === 0} className="btn-primary w-full h-11 mt-5">
        {loading ? 'Importing…' : `Import ${rows.filter((r) => !r.error).length || ''} Participants`}
      </button>
    </Modal>
  );
}
