import React, { useEffect, useState } from 'react';
import { useAuth, signOut } from './lib/auth';
import { supabase } from './services/supabase';
import { LoginPage } from './features/auth/LoginPage';
import { StudentAttendanceFlow } from './features/student/StudentAttendanceFlow';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { LiveSessionPage } from './features/attendance/LiveSessionPage';
import { StudentsPage } from './features/students/StudentsPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { AdminPage } from './features/admin/AdminPage';
import { AuditPage } from './features/admin/AuditPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { JoinGroupQRPage } from './features/groups/JoinGroupQRPage';
import { StudentJoinGroupFlow } from './features/student/StudentJoinGroupFlow';
import { TopBar } from './components/layout/TopBar';
import { Sidebar } from './components/layout/Sidebar';
import { ToastProvider } from './components/ui/Toast';

const MOBILE_NAV = [
  { id: 'dashboard', label: 'Home', icon: '⊞' },
  { id: 'live_session', label: 'Live', icon: '●' },
  { id: 'students', label: 'Participants', icon: '👥' },
  { id: 'reports', label: 'Reports', icon: '📊' },
  { id: 'groups', label: 'Join Group', icon: '🔗' },
];

export default function App() {
  const { loading, staff, session } = useAuth();
  const [studentMode, setStudentMode] = useState(false);
  const [joinGroupMode, setJoinGroupMode] = useState(false);
  const [attendToken, setAttendToken] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [defaultCourseName, setDefaultCourseName] = useState('IC181');
  const [currentCourse, setCurrentCourseState] = useState(() => localStorage.getItem('sa_current_course') || 'IC181');
  const [knownCourses, setKnownCourses] = useState<string[]>([]);
  const [liveSessionCount, setLiveSessionCount] = useState(0);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);

  function openSession(sessionId: string) {
    setFocusSessionId(sessionId);
    setActiveTab('reports');
  }

  function setCurrentCourse(course: string) {
    setCurrentCourseState(course);
    localStorage.setItem('sa_current_course', course);
  }

  const loadKnownCourses = React.useCallback(async () => {
    const { data } = await supabase.from('sessions').select('course_name');
    const names = new Set((data ?? []).map((s) => s.course_name).filter(Boolean));
    names.add('IC181');
    names.add(defaultCourseName);
    setKnownCourses(Array.from(names).sort());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultCourseName]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('attend');
    if (token) {
      setAttendToken(token);
      setStudentMode(true);
    }
    if (params.get('join_group') === '1') {
      setJoinGroupMode(true);
    }
  }, []);

  useEffect(() => {
    if (!staff) return;

    supabase.from('course_settings').select('course_name').single().then(({ data }) => {
      if (data?.course_name) {
        setDefaultCourseName(data.course_name);
        const stored = localStorage.getItem('sa_current_course');
        if (!stored || stored === 'General Class') {
          setCurrentCourse(data.course_name);
        }
      }
    });


    async function refreshLiveCount() {
      const { count } = await supabase.from('sessions').select('*', { count: 'exact', head: true }).eq('status', 'active');
      setLiveSessionCount(count ?? 0);
    }
    refreshLiveCount();
    loadKnownCourses();

    const channel = supabase
      .channel('app_sessions_watch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, () => { refreshLiveCount(); loadKnownCourses(); })
      .subscribe();

    const interval = setInterval(() => {
      refreshLiveCount();
    }, 5000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [staff, currentCourse, loadKnownCourses]);

  async function handleLogout() {
    await signOut();
    setActiveTab('dashboard');
  }

  // Direct QR deep link — always takes priority, staff or not.
  if (studentMode) {
    return (
      <>
        <StudentAttendanceFlow initialToken={attendToken} onBack={attendToken ? undefined : () => setStudentMode(false)} />
        <ToastProvider />
      </>
    );
  }

  if (joinGroupMode) {
    return (
      <>
        <StudentJoinGroupFlow onBack={() => setJoinGroupMode(false)} />
        <ToastProvider />
      </>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0d1117]">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <LoginPage onLoggedIn={() => setActiveTab('dashboard')} />
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 flex-wrap justify-center px-4 max-w-full">
          <button onClick={() => setStudentMode(true)} className="btn-outline btn-sm shadow-lg bg-white dark:bg-[#161b22] text-xs whitespace-nowrap">
            📱 Mark Attendance
          </button>
          <button onClick={() => setJoinGroupMode(true)} className="btn-outline btn-sm shadow-lg bg-white dark:bg-[#161b22] text-xs whitespace-nowrap">
            🔗 Join Group
          </button>
        </div>
        <ToastProvider />
      </>
    );
  }

  if (!staff) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50 dark:bg-[#0d1117] p-6 text-center">
        <p className="text-lg font-bold text-slate-900 dark:text-slate-100">Setting up your profile…</p>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">
          Creating your account access. Please wait a moment or sign in again.
        </p>
        <button onClick={handleLogout} className="btn-secondary">Sign out</button>
      </div>
    );
  }

  if (staff.status === 'disabled') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50 dark:bg-[#0d1117] p-6 text-center">
        <p className="text-lg font-bold text-slate-900 dark:text-slate-100">Access disabled</p>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">Your access has been disabled by an administrator.</p>
        <button onClick={handleLogout} className="btn-secondary">Sign out</button>
      </div>
    );
  }

  const adminOnlyTabs = ['admin', 'audit', 'settings'];
  const effectiveTab = adminOnlyTabs.includes(activeTab) && staff.role !== 'admin' ? 'dashboard' : activeTab;

  const renderPage = () => {
    switch (effectiveTab) {
      case 'dashboard': return <DashboardPage staff={staff} onNavigate={setActiveTab} onOpenSession={openSession} courseName={currentCourse} />;
      case 'live_session': return <LiveSessionPage staff={staff} courseName={currentCourse} onCourseChange={setCurrentCourse} />;
      case 'students': return <StudentsPage staff={staff} courseName={currentCourse} />;
      case 'reports': return <ReportsPage staff={staff} courseName={currentCourse} focusSessionId={focusSessionId} onFocusHandled={() => setFocusSessionId(null)} />;
      case 'admin': return <AdminPage staff={staff} />;
      case 'audit': return <AuditPage />;
      case 'settings': return <SettingsPage />;
      case 'groups': return <JoinGroupQRPage />;
      default: return <DashboardPage staff={staff} onNavigate={setActiveTab} onOpenSession={openSession} courseName={currentCourse} />;
    }
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-[#0d1117] overflow-hidden">
      <TopBar
        staff={staff}
        courseName={currentCourse}
        knownCourses={knownCourses}
        onCourseChange={setCurrentCourse}
        onLogout={handleLogout}
      />

      <div className="flex flex-1 min-h-0">
        <Sidebar active={effectiveTab} onNavigate={setActiveTab} staff={staff} liveSessionCount={liveSessionCount} />
        <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-[#0d1117]">
          {renderPage()}
        </div>
      </div>

      <nav className="md:hidden flex items-center border-t border-slate-200 dark:border-[#21262d] bg-white dark:bg-[#0d1117] pb-safe flex-shrink-0">
        {MOBILE_NAV.map((item) => (
          <button
            key={item.id}
            id={`mobile-nav-${item.id}`}
            onClick={() => setActiveTab(item.id)}
            className="flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors"
          >
            <span className={`text-base ${effectiveTab === item.id ? 'opacity-100' : 'opacity-40'} ${item.id === 'live_session' && liveSessionCount > 0 ? 'text-emerald-500' : ''}`}>
              {item.icon}
            </span>
            <span className={`text-[9px] font-semibold tracking-wide ${effectiveTab === item.id ? 'text-blue-600' : 'text-slate-400'}`}>
              {item.label}
            </span>
            {effectiveTab === item.id && <div className="w-4 h-0.5 rounded-full bg-blue-600" />}
          </button>
        ))}
      </nav>

      <ToastProvider />
    </div>
  );
}
