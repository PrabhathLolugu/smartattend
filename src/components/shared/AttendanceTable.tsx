import React, { useState } from 'react';
import { callFunction } from '../../lib/api';
import { StatusBadge } from '../ui/StatusBadge';
import { toast } from '../ui/Toast';
import { timeAgo, statusLabel } from '../../lib/utils';
import type { Staff, AttendanceRecord } from '../../types';

const EDITABLE_STATUSES: AttendanceRecord['status'][] = ['present', 'manual', 'override', 'excused'];

function methodBadge(r: AttendanceRecord) {
  if (r.method === 'gps') {
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200/50 dark:border-emerald-500/20">QR (Verified)</span>;
  }
  if (r.method === 'gps_flagged' || r.gps_flag) {
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-200/50 dark:border-amber-500/20">QR (Flagged)</span>;
  }
  if (r.method === 'override_code') {
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-200/50 dark:border-blue-500/20">Override Code</span>;
  }
  if (r.method === 'instructor_approved') {
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-cyan-50 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-200/50 dark:border-cyan-500/20">Staff Approved</span>;
  }
  if (r.method === 'manual') {
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-200/50 dark:border-purple-500/20">Manual Entry</span>;
  }
  return <span className="text-slate-400 text-xs">{String(r.method ?? '').replace('_', ' ')}</span>;
}

export function AttendanceTable({
  staff,
  records,
  onChanged,
  title = 'Live Attendance Log',
  emptyText = 'No one has marked attendance yet.',
}: {
  staff: Staff;
  records: (AttendanceRecord & {
    student?: { name?: string; department?: string; group_label?: string } | null;
    students?: { name?: string; department?: string; group_label?: string } | null;
    device_fingerprint?: string | null;
  })[];
  onChanged: () => void;
  title?: string;
  emptyText?: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<AttendanceRecord['status']>('present');
  const [busyId, setBusyId] = useState<string | null>(null);

  function startEdit(r: AttendanceRecord) {
    setEditingId(r.id);
    setEditStatus(r.status);
  }

  async function saveEdit(r: AttendanceRecord) {
    setBusyId(r.id);
    try {
      await callFunction('attendance-edit', { recordId: r.id, status: editStatus, notes: r.notes ?? null });
      toast('success', 'Attendance updated.');
      setEditingId(null);
      onChanged();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not update attendance.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(r: AttendanceRecord) {
    if (!window.confirm(`Remove ${r.roll_number}'s attendance record for this session?`)) return;
    setBusyId(r.id);
    try {
      await callFunction('attendance-delete', { recordId: r.id });
      toast('success', 'Attendance record removed.');
      onChanged();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not delete attendance record.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card flex-1">
      {title && (
        <div className="px-5 py-4 border-b border-slate-100 dark:border-[#21262d] flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-sm text-slate-900 dark:text-slate-100">
            <span>{title}</span>
            <span className="badge-blue text-[10px] py-0.5">{records.length} records</span>
          </div>
          <span className="text-[11px] text-slate-400">Updates live</span>
        </div>
      )}
      <div className="max-h-96 overflow-y-auto">
        {records.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">{emptyText}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Status</th>
                <th>Method</th>
                <th>Device</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const studentName = r.student?.name || r.students?.name;
                const studentDept = r.student?.department || r.students?.department;

                return (
                  <tr key={r.id}>
                    <td>
                      <div>
                        <p className="font-semibold text-slate-900 dark:text-slate-100 leading-tight">{r.roll_number}</p>
                        {studentName ? (
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate max-w-[160px] sm:max-w-xs">
                            {studentName} {studentDept ? `· ${studentDept.split('(')[1]?.replace(')', '') || studentDept}` : ''}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      {editingId === r.id ? (
                        <select
                          value={editStatus}
                          onChange={(e) => setEditStatus(e.target.value as AttendanceRecord['status'])}
                          className="text-xs border border-slate-200 dark:border-[#30363d] rounded-lg px-2 py-1 bg-white dark:bg-[#0d1117]"
                        >
                          {EDITABLE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {statusLabel(s)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <StatusBadge status={r.status} />
                      )}
                    </td>
                    <td>{methodBadge(r)}</td>
                    <td>
                      {r.device_fingerprint ? (
                        <span
                          className="font-mono text-[10px] bg-slate-100 dark:bg-[#21262d] text-slate-500 dark:text-slate-400 px-1.5 py-0.5 rounded"
                          title={r.device_fingerprint}
                        >
                          {r.device_fingerprint.slice(0, 8)}
                        </span>
                      ) : (
                        <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">{timeAgo(r.marked_at)}</td>
                    <td>
                      <div className="flex gap-2 justify-end">
                        {editingId === r.id ? (
                          <>
                            <button
                              onClick={() => saveEdit(r)}
                              disabled={busyId === r.id}
                              className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
                            >
                              Save
                            </button>
                            <button onClick={() => setEditingId(null)} className="text-xs text-slate-400 hover:text-slate-600">
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEdit(r)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                              Edit
                            </button>
                            {staff.role === 'admin' && (
                              <button
                                onClick={() => handleDelete(r)}
                                disabled={busyId === r.id}
                                className="text-xs text-red-600 hover:text-red-700 font-medium"
                              >
                                Delete
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
