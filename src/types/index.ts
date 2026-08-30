export type StaffRole = 'admin' | 'ta';
export type StaffStatus = 'active' | 'disabled';

export interface Staff {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  status: StaffStatus;
  created_at: string;
  created_by?: string | null;
}

export type StudentStatus = 'active' | 'inactive' | 'graduated' | 'deleted';
export type ParticipantType = 'student' | 'faculty';

export interface Student {
  id: string;
  roll_number: string;
  name: string;
  role_type?: ParticipantType | null;
  department?: string | null; // Maps to "School / Centre"
  program?: string | null;    // Maps to "Program" (e.g. B.Tech, M.Tech, Ph.D.)
  group_label?: string | null;
  photo_url?: string | null;
  status: StudentStatus;
  created_at: string;
  updated_at: string;
}

export interface CourseSettings {
  course_name: string;
  gps_radius_meters: number;
  override_code_ttl_seconds: number;
  qr_rotation_seconds: number;
  qr_token_validity_seconds: number;
}

export type SessionCategory = 'theory_lecture' | 'yoga_practical';

export const SESSION_TYPE_PRESETS = [
  'Theory',
  'Lecture',
  'Practical',
  'Yoga',
  'Lab',
  'Tutorial',
  'Colloquium',
  'Seminar',
  'Workshop',
  'Exam',
  'Special Session',
] as const;
export type SessionStatus = 'active' | 'ended';

export interface Session {
  id: string;
  session_date: string;
  session_type: string;
  course_name: string;
  status: SessionStatus;
  started_by: string;
  anchor_lat: number;
  anchor_lng: number;
  radius_meters: number;
  group_filter?: string | null;
  round_id?: string | null;
  rotation_id: string;
  rotation_expires_at: string;
  allow_gps_override: boolean;
  override_code?: string | null;
  override_code_expires_at?: string | null;
  notes?: string | null;
  created_at: string;
  ended_at?: string | null;
}

export type AttendanceStatus = 'present' | 'manual' | 'override' | 'excused';
export type AttendanceMethod = 'gps' | 'gps_flagged' | 'override_code' | 'manual' | 'instructor_approved';

export interface AttendanceRecord {
  id: string;
  session_id: string;
  student_id: string;
  roll_number: string;
  status: AttendanceStatus;
  method: AttendanceMethod;
  distance_meters?: number | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  gps_accuracy?: number | null;
  gps_flag?: string | null;  // 'no_gps' | 'gps_denied' | 'gps_unavailable' | 'outside_radius' | null
  marked_at: string;
  recorded_by?: string | null;
  notes?: string | null;
}

export type OverrideReason = 'gps_denied' | 'outside_radius' | 'gps_unavailable';
// 'auto_allowed' = student was let through without blocking (new default behaviour)
export type OverrideStatus = 'pending' | 'approved' | 'rejected' | 'auto_allowed';

export interface GpsOverrideRequest {
  id: string;
  session_id: string;
  student_id: string;
  roll_number: string;
  distance_meters?: number | null;
  reason: OverrideReason;
  status: OverrideStatus;
  requested_at: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
}

export interface AuditLogEntry {
  id: string;
  actor_id?: string | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  before?: unknown;
  after?: unknown;
  created_at: string;
}

export interface StudentAttendanceSummary {
  student_id: string;
  roll_number: string;
  name: string;
  role_type?: ParticipantType | null;
  department?: string | null;
  program?: string | null;
  group_label?: string | null;
  present_count: number;
  excused_count: number;
  manual_count: number;
  override_count: number;
  total_sessions: number;
  attendance_percentage: number;
  // Category specific stats
  theory_present_count?: number;
  theory_total_sessions?: number;
  theory_percentage?: number;
  practical_present_count?: number;
  practical_total_sessions?: number;
  practical_percentage?: number;
}

export interface ActivityRound {
  id: string;
  name: string;
  created_at: string;
}

