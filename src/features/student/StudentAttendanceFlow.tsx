import React, { useEffect, useRef, useState } from 'react';
import { callFunction, type ApiError } from '../../lib/api';
import { CameraScanner } from '../../components/shared/CameraScanner';
import type { Student, Session, AttendanceRecord, ParticipantType } from '../../types';

type Step =
  | 'need_token'
  | 'gps'
  | 'roll'
  | 'confirm'
  | 'enroll'
  | 'submitting'
  | 'success'
  | 'duplicate'
  | 'error';

interface Props {
  initialToken?: string | null;
  onBack?: () => void;
}

interface Position {
  lat: number;
  lng: number;
  accuracy: number;
}

interface EnrollForm {
  name: string;
  roleType: ParticipantType;
  department: string; // School / Centre
  program: string;    // B.Tech, M.Tech, Ph.D., etc.
}

const SCHOOL_PRESETS = [
  'School of Computing & Electrical Engineering (SCEE)',
  'School of Mechanical & Materials Engineering (SMME)',
  'School of Basic Sciences (SBS)',
  'School of Humanities & Social Sciences (SHSS)',
  'School of Bioscience & Bioengineering (SBB)',
  'School of Chemical Sciences (SCS)',
  'Indian Knowledge System and Mental Health Applications (IKSMHA)',
];

const PROGRAM_PRESETS = [
  'B.Tech',
  'M.Tech',
  'Ph.D.',
  'M.Sc.',
  'M.S.',
  'B.Sc.',
  'Dual Degree',
];

const emptyEnrollForm: EnrollForm = {
  name: '', roleType: 'student', department: SCHOOL_PRESETS[0], program: 'B.Tech',
};

// How long to wait for GPS before proceeding anyway (ms)
const GPS_TIMEOUT_MS = 8000;

export function StudentAttendanceFlow({ initialToken, onBack }: Props) {
  const [step, setStep] = useState<Step>(initialToken ? 'gps' : 'need_token');
  const [showScanner, setShowScanner] = useState(false);
  const [token, setToken] = useState<string | null>(initialToken ?? null);

  const [gpsLoading, setGpsLoading] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [gpsDenied, setGpsDenied] = useState(false);

  const [roleType, setRoleType] = useState<ParticipantType>('student');
  const [roll, setRoll] = useState('');
  const [rollLoading, setRollLoading] = useState(false);
  const [student, setStudent] = useState<Student | null>(null);
  const [enrollForm, setEnrollForm] = useState<EnrollForm>(emptyEnrollForm);
  const [customDept, setCustomDept] = useState('');
  const [customProg, setCustomProg] = useState('');

  const [error, setError] = useState('');
  const [result, setResult] = useState<{ record?: AttendanceRecord; session?: Session } | null>(null);
  const [duplicateInfo, setDuplicateInfo] = useState<{ markedAt?: string; status?: string } | null>(null);

  const rollRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const savedRoll = localStorage.getItem('sa_student_roll');
    if (savedRoll && !roll) setRoll(savedRoll);
  }, []);

  useEffect(() => {
    if (step === 'roll') rollRef.current?.focus();
  }, [step]);

  // Auto-start GPS when we land on the gps step
  useEffect(() => {
    if (step === 'gps') {
      requestGps();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function extractToken(scanned: string): string {
    try {
      const url = new URL(scanned);
      const t = url.searchParams.get('attend');
      if (t) return t;
    } catch {
      /* not a URL — treat the raw scanned text as the token */
    }
    return scanned.trim();
  }

  function handleScanResult(data: string) {
    setShowScanner(false);
    setToken(extractToken(data));
    setStep('gps');
  }

  function proceedToRoll() {
    setGpsLoading(false);
    setStep('roll');
  }

  function requestGps() {
    setGpsLoading(true);
    setError('');

    if (!navigator.geolocation) {
      // GPS API not available — proceed silently
      setPosition(null);
      setGpsDenied(false);
      proceedToRoll();
      return;
    }

    // Timeout fallback — if GPS takes too long, proceed without it
    const timeoutId = setTimeout(() => {
      setPosition(null);
      setGpsDenied(false);
      proceedToRoll();
    }, GPS_TIMEOUT_MS);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timeoutId);
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setGpsDenied(false);
        proceedToRoll();
      },
      (err) => {
        clearTimeout(timeoutId);
        setPosition(null);
        setGpsDenied(err.code === err.PERMISSION_DENIED);
        // GPS denied or unavailable — still proceed to roll number entry
        proceedToRoll();
      },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS - 500, maximumAge: 0 },
    );
  }

  async function handleRollSubmit() {
    const cleaned = roll.trim().toUpperCase();
    if (!cleaned) {
      setError(roleType === 'faculty' ? 'Please enter your Employee ID.' : 'Please enter your roll number.');
      return;
    }
    setRoll(cleaned);
    setRollLoading(true);
    setError('');
    try {
      const res = await callFunction<{
        exists: boolean;
        student?: Student;
        alreadyMarked?: boolean;
        markedAt?: string;
      }>('student-check', {
        rollNumber: cleaned,
        qrToken: token,
      });

      if (res.alreadyMarked) {
        setDuplicateInfo({ markedAt: res.markedAt, status: 'present' });
        setStep('duplicate');
      } else if (res.exists && res.student) {
        setStudent(res.student);
        setEnrollForm({
          name: res.student.name,
          roleType: res.student.role_type ?? roleType,
          department: res.student.department ?? SCHOOL_PRESETS[0],
          program: res.student.program ?? 'B.Tech',
        });
        setStep('confirm');
      } else {
        setEnrollForm({
          name: '',
          roleType,
          department: SCHOOL_PRESETS[0],
          program: 'B.Tech',
        });
        setStep('enroll');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setRollLoading(false);
    }
  }

  async function handleEnrollSubmit() {
    if (!enrollForm.name.trim()) { setError('Please enter your full name.'); return; }
    const dept = enrollForm.department === '__custom__' ? customDept.trim() : enrollForm.department;
    const prog = enrollForm.program === '__custom__' ? customProg.trim() : enrollForm.program;

    if (!dept) { setError('Please specify your School / Centre.'); return; }
    if (enrollForm.roleType === 'student' && !prog) { setError('Please specify your Program.'); return; }

    setRollLoading(true);
    setError('');
    try {
      const res = await callFunction<{ student?: Student; error?: string; code?: string }>('student-enroll', {
        rollNumber: roll,
        name: enrollForm.name.trim(),
        roleType: enrollForm.roleType,
        department: dept,
        program: enrollForm.roleType === 'student' ? prog : undefined,
      });
      if (res.student) {
        // Use the enrolled student directly (don't rely on stale state)
        await submitAttendanceForStudent(res.student);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed.';
      const code = (e as ApiError)?.code;
      if (code === 'already_registered' || message.toLowerCase().includes('already registered')) {
        try {
          const check = await callFunction<{ exists: boolean; student?: Student }>('student-check', { rollNumber: roll });
          if (check.exists && check.student) {
            setStudent(check.student);
            setStep('confirm');
            setRollLoading(false);
            return;
          }
        } catch {
          /* ignore */
        }
      }
      setError(message);
      setRollLoading(false);
    }
  }

  async function submitAttendance() {
    return submitAttendanceForStudent(student);
  }

  async function submitAttendanceForStudent(resolvedStudent: Student | null) {
    if (!token) return;
    setStep('submitting');
    setError('');
    try {
      const res = await callFunction<{
        record?: AttendanceRecord;
        session?: Session;
        duplicate?: boolean;
        markedAt?: string;
        status?: string;
      }>('attendance-submit', {
        qrToken: token,
        rollNumber: roll,
        lat: position?.lat,
        lng: position?.lng,
        accuracy: position?.accuracy,
        gpsDenied,
      });

      if (res.duplicate) {
        setDuplicateInfo({ markedAt: res.markedAt, status: res.status });
        setStep('duplicate');
      } else if (res.record) {
        localStorage.setItem('sa_student_roll', roll);
        if (resolvedStudent) setStudent(resolvedStudent);
        setResult({ record: res.record, session: res.session });
        setStep('success');
      } else {
        setError('Something went wrong. Please try again.');
        setStep('error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setStep('error');
    }
  }

  async function handleConfirm() {
    setRollLoading(true);
    await submitAttendance();
    setRollLoading(false);
  }

  function reset() {
    setRoll('');
    setStudent(null);
    setEnrollForm(emptyEnrollForm);
    setError('');
    setResult(null);
    setDuplicateInfo(null);
    setStep('roll');
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0d1117] flex flex-col items-center justify-center p-4">
      {showScanner && <CameraScanner onScan={handleScanResult} onClose={() => setShowScanner(false)} />}

      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <span className="font-bold text-slate-900 dark:text-slate-100 text-lg">SmartAttend</span>
        </div>

        {step === 'need_token' && (
          <div className="animate-slide-up text-center">
            <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Mark Attendance</h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Scan the QR code shown in class / event.</p>
            <button onClick={() => setShowScanner(true)} className="btn-primary w-full h-12 mt-6">Scan QR Code</button>
            {onBack && (
              <button onClick={onBack} className="mt-4 w-full text-center text-sm text-slate-400 hover:text-slate-600 transition-colors">
                ← Back to staff login
              </button>
            )}
          </div>
        )}

        {step === 'gps' && (
          <div className="flex flex-col items-center gap-4 py-16 animate-fade-in">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-600 dark:text-slate-400 text-sm font-medium">Getting your location…</p>
            <p className="text-slate-400 dark:text-slate-500 text-xs">This only takes a moment.</p>
          </div>
        )}

        {step === 'roll' && (
          <div className="animate-slide-up">
            <div className="flex bg-slate-200 dark:bg-[#161b22] p-1 rounded-xl mb-6">
              <button
                type="button"
                onClick={() => { setRoleType('student'); setError(''); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${roleType === 'student' ? 'bg-white dark:bg-blue-600 text-blue-600 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'}`}
              >
                🎓 Student
              </button>
              <button
                type="button"
                onClick={() => { setRoleType('faculty'); setError(''); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${roleType === 'faculty' ? 'bg-white dark:bg-blue-600 text-blue-600 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'}`}
              >
                🏛️ Faculty / Staff
              </button>
            </div>

            <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              {roleType === 'faculty' ? 'Enter Employee ID' : 'Enter Roll Number'}
            </h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
              {roleType === 'faculty' ? 'Enter your employee / staff ID.' : 'Enter your student roll number.'}
            </p>
            <div className="mt-6 flex flex-col gap-4">
              <input
                ref={rollRef}
                className="input-base text-lg tracking-widest text-center h-14 font-mono font-bold"
                placeholder={roleType === 'faculty' ? 'EMP1024' : 'B23CS001'}
                value={roll}
                onChange={(e) => { setRoll(e.target.value.toUpperCase()); setError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && handleRollSubmit()}
                autoCapitalize="characters"
                autoFocus
              />
              {error && <ErrorBox message={error} />}
              <button onClick={handleRollSubmit} disabled={rollLoading} className="btn-primary w-full h-12">
                {rollLoading ? 'Finding…' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {step === 'confirm' && student && (
          <div className="animate-slide-up">
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">Confirm Your Details</h2>
            <div className="mt-4 card p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-900 dark:text-slate-100">{student.name}</p>
                <span className="badge-blue uppercase text-[10px]">{student.role_type === 'faculty' ? 'Faculty / Staff' : 'Student'}</span>
              </div>
              <p className="text-xs text-slate-500 font-mono">{student.roll_number}</p>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {student.department && <span className="badge-slate">{student.department}</span>}
                {student.program && <span className="badge-slate">{student.program}</span>}
              </div>
            </div>

            {error && <ErrorBox message={error} className="mt-3" />}
            <div className="mt-6 flex flex-col gap-2">
              <button onClick={handleConfirm} disabled={rollLoading} className="btn-primary w-full h-12">
                {rollLoading ? 'Marking attendance…' : 'Confirm & Mark Attendance'}
              </button>
              <button onClick={reset} className="btn-ghost w-full text-xs">
                Not you? Use a different {roleType === 'faculty' ? 'Employee ID' : 'roll number'}
              </button>
            </div>
          </div>
        )}

        {step === 'enroll' && (
          <div className="animate-slide-up">
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">First Time Here?</h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
              Add details for <span className="font-mono font-semibold">{roll}</span> ({enrollForm.roleType === 'faculty' ? 'Faculty / Staff' : 'Student'}).
            </p>
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <label className="label">Full Name *</label>
                <input className="input-base" placeholder="Dr. Alex Rivera" value={enrollForm.name} onChange={(e) => setEnrollForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
              </div>

              <div>
                <label className="label">School / Centre *</label>
                <select
                  className="input-base text-xs"
                  value={enrollForm.department}
                  onChange={(e) => setEnrollForm((f) => ({ ...f, department: e.target.value }))}
                >
                  {SCHOOL_PRESETS.map((s) => <option key={s} value={s}>{s}</option>)}
                  <option value="__custom__">Other…</option>
                </select>
                {enrollForm.department === '__custom__' && (
                  <input
                    className="input-base mt-2"
                    placeholder="Enter School / Centre name"
                    value={customDept}
                    onChange={(e) => setCustomDept(e.target.value)}
                  />
                )}
              </div>

              {enrollForm.roleType === 'student' && (
                <div>
                  <label className="label">Program *</label>
                  <select
                    className="input-base"
                    value={enrollForm.program}
                    onChange={(e) => setEnrollForm((f) => ({ ...f, program: e.target.value }))}
                  >
                    {PROGRAM_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                    <option value="__custom__">Other…</option>
                  </select>
                  {enrollForm.program === '__custom__' && (
                    <input
                      className="input-base mt-2"
                      placeholder="e.g. M.Sc. Data Science"
                      value={customProg}
                      onChange={(e) => setCustomProg(e.target.value)}
                    />
                  )}
                </div>
              )}
            </div>
            {error && <ErrorBox message={error} className="mt-3" />}
            <button onClick={handleEnrollSubmit} disabled={rollLoading} className="btn-primary w-full h-12 mt-5">
              {rollLoading ? 'Saving…' : 'Register & Mark Attendance'}
            </button>
          </div>
        )}

        {step === 'submitting' && (
          <div className="flex flex-col items-center gap-4 py-16 animate-fade-in">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-600 dark:text-slate-400 text-sm font-medium">Marking your attendance…</p>
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center gap-4 py-8 text-center animate-scale-in">
            <div className="w-16 h-16 rounded-full bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">Attendance Recorded</p>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{roll} · {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</p>
            </div>
            <button onClick={reset} className="btn-secondary w-full">Done</button>
          </div>
        )}

        {step === 'duplicate' && (
          <div className="flex flex-col items-center gap-4 py-8 text-center animate-scale-in">
            <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-[#21262d] flex items-center justify-center">
              <svg className="w-8 h-8 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <div>
              <p className="text-xl font-bold text-slate-900 dark:text-slate-100">Attendance Already Submitted</p>
              {duplicateInfo?.markedAt && (
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                  Recorded at {new Date(duplicateInfo.markedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>
            <button onClick={reset} className="btn-secondary w-full">Close</button>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center gap-4 py-8 text-center animate-scale-in">
            <div className="w-16 h-16 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01"/></svg>
            </div>
            <div>
              <p className="text-xl font-bold text-slate-900 dark:text-slate-100">Something Went Wrong</p>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{error}</p>
            </div>
            <button onClick={reset} className="btn-secondary w-full">Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorBox({ message, className = '' }: { message: string; className?: string }) {
  return (
    <div className={`flex items-start gap-2 px-4 py-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-700 dark:text-red-400 text-xs ${className}`}>
      {message}
    </div>
  );
}
