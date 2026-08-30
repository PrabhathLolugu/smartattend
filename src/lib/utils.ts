import { clsx, type ClassValue } from 'clsx';


export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return formatDate(iso);
}

export function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

export function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
}

export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'present':   return 'badge-green';
    case 'manual':    return 'badge-purple';
    case 'override':  return 'badge-blue';
    case 'excused':   return 'badge-purple';
    case 'approved':  return 'badge-green';
    case 'rejected':  return 'badge-red';
    case 'pending':   return 'badge-amber';
    case 'active':    return 'badge-green';
    case 'ended':     return 'badge-slate';
    case 'disabled':  return 'badge-slate';
    case 'gps_denied':
    case 'gps_unavailable':
    case 'outside_radius': return 'badge-amber';
    default:          return 'badge-slate';
  }
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    present: 'Present',
    manual: 'Manual',
    override: 'GPS Override',
    excused: 'Excused',
    approved: 'Approved',
    rejected: 'Rejected',
    pending: 'Pending',
    active: 'Active',
    ended: 'Ended',
    disabled: 'Disabled',
    ta: 'TA',
    admin: 'Admin',
    gps_denied: 'GPS Denied',
    gps_unavailable: 'GPS Unavailable',
    outside_radius: 'Outside Radius',
  };
  return map[status] ?? status;
}

export function pctColor(pct: number): string {
  if (pct >= 85) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 75) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function getSessionCategory(sessionType: string | null | undefined): 'theory_lecture' | 'yoga_practical' {
  const t = (sessionType || '').toLowerCase();
  if (t.includes('yoga') || t.includes('practical') || t.includes('lab') || t.includes('activity')) {
    return 'yoga_practical';
  }
  return 'theory_lecture';
}

export function getSessionCategoryLabel(category: 'theory_lecture' | 'yoga_practical'): string {
  return category === 'yoga_practical' ? 'Yoga & Practical' : 'Theory & Lecture';
}

export function getCategoryBadgeClass(category: 'theory_lecture' | 'yoga_practical'): string {
  return category === 'yoga_practical'
    ? 'bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-200/60 dark:border-purple-500/20'
    : 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-200/60 dark:border-blue-500/20';
}

