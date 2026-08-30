-- SmartAttend Initial Database Schema
-- Run this in your new Supabase SQL Editor

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Staff / User Profiles
CREATE TABLE IF NOT EXISTS public.staff (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'ta')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES public.staff(id) ON DELETE SET NULL
);

-- Automatic email auto-confirmation trigger on signup (no confirmation emails required)
CREATE OR REPLACE FUNCTION public.auto_confirm_new_user()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.email_confirmed_at IS NULL THEN
    NEW.email_confirmed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_before_insert ON auth.users;
CREATE TRIGGER on_auth_user_before_insert
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auto_confirm_new_user();

-- Automatic staff profile creation trigger on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.staff (id, email, name, role, status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', SPLIT_PART(NEW.email, '@', 1)),
    'admin',
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      name = COALESCE(EXCLUDED.name, public.staff.name);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Courses / Classes
CREATE TABLE IF NOT EXISTS public.courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_name TEXT NOT NULL UNIQUE,
  course_code TEXT,
  description TEXT,
  owner_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Course Staff Assignment
CREATE TABLE IF NOT EXISTS public.course_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_name TEXT NOT NULL,
  staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'ta')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_name, staff_id)
);

-- 4. Course Settings
CREATE TABLE IF NOT EXISTS public.course_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CONSTRAINT single_row CHECK (id = TRUE),
  course_name TEXT NOT NULL DEFAULT 'Default Class',
  gps_radius_meters INTEGER NOT NULL DEFAULT 100,
  override_code_ttl_seconds INTEGER NOT NULL DEFAULT 180,
  qr_rotation_seconds INTEGER NOT NULL DEFAULT 25,
  qr_token_validity_seconds INTEGER NOT NULL DEFAULT 1800,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default course settings row
INSERT INTO public.course_settings (id, course_name, gps_radius_meters, override_code_ttl_seconds, qr_rotation_seconds, qr_token_validity_seconds)
VALUES (TRUE, 'Default Class', 100, 180, 25, 1800)
ON CONFLICT (id) DO NOTHING;

-- 5. Students / Participants
CREATE TABLE IF NOT EXISTS public.students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roll_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'student' CHECK (role_type IN ('student', 'faculty')),
  email TEXT,
  phone TEXT,
  department TEXT,
  program TEXT,
  semester TEXT,
  group_label TEXT,
  batch TEXT,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'graduated', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Activity Rounds
CREATE TABLE IF NOT EXISTS public.activity_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_name TEXT NOT NULL DEFAULT 'Default Class',
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Sessions
CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  session_type TEXT NOT NULL DEFAULT 'Lecture',
  course_name TEXT NOT NULL DEFAULT 'Default Class',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_by UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  anchor_lat DOUBLE PRECISION NOT NULL,
  anchor_lng DOUBLE PRECISION NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 100,
  group_filter TEXT,
  round_id UUID REFERENCES public.activity_rounds(id) ON DELETE SET NULL,
  rotation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  rotation_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 seconds',
  allow_gps_override BOOLEAN NOT NULL DEFAULT TRUE,
  override_code TEXT,
  override_code_expires_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- 8. Attendance Records
CREATE TABLE IF NOT EXISTS public.attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  roll_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'manual', 'override', 'excused')),
  method TEXT NOT NULL CHECK (method IN ('gps', 'override_code', 'manual', 'instructor_approved')),
  distance_meters DOUBLE PRECISION,
  gps_lat DOUBLE PRECISION,
  gps_lng DOUBLE PRECISION,
  gps_accuracy DOUBLE PRECISION,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  device_fingerprint TEXT,
  notes TEXT,
  UNIQUE(session_id, student_id)
);

-- 9. GPS Override Requests
CREATE TABLE IF NOT EXISTS public.gps_override_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  roll_number TEXT NOT NULL,
  distance_meters DOUBLE PRECISION,
  reason TEXT NOT NULL CHECK (reason IN ('gps_denied', 'outside_radius', 'gps_unavailable')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  device_fingerprint TEXT
);

-- 10. Override Codes
CREATE TABLE IF NOT EXISTS public.override_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Audit Logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Student Attendance Summary Function
DROP FUNCTION IF EXISTS public.student_attendance_summary(TEXT);
CREATE OR REPLACE FUNCTION public.student_attendance_summary(p_course_name TEXT)

RETURNS TABLE (
  student_id UUID,
  roll_number TEXT,
  name TEXT,
  role_type TEXT,
  department TEXT,
  program TEXT,
  group_label TEXT,
  present_count BIGINT,
  excused_count BIGINT,
  manual_count BIGINT,
  override_count BIGINT,
  total_sessions BIGINT,
  attendance_percentage NUMERIC,
  theory_present_count BIGINT,
  theory_total_sessions BIGINT,
  theory_percentage NUMERIC,
  practical_present_count BIGINT,
  practical_total_sessions BIGINT,
  practical_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH course_sessions AS (
    SELECT 
      s.id, 
      s.session_type,
      s.group_filter, 
      s.round_id, 
      s.status,
      (LOWER(s.session_type) LIKE '%yoga%' OR LOWER(s.session_type) LIKE '%practical%' OR LOWER(s.session_type) LIKE '%lab%' OR LOWER(s.session_type) LIKE '%activity%') AS is_practical
    FROM public.sessions s
    WHERE s.course_name ILIKE p_course_name
  ),
  student_records AS (
    SELECT 
      ar.student_id,
      ar.roll_number,
      ar.session_id,
      ar.status,
      ar.method,
      cs.round_id,
      cs.group_filter,
      cs.session_type,
      cs.is_practical,
      cs.status AS session_status
    FROM public.attendance_records ar
    JOIN course_sessions cs ON cs.id = ar.session_id
  ),
  session_counts AS (
    SELECT 
      st.id AS student_id,
      COUNT(DISTINCT cs.id)::BIGINT AS total_sessions,
      COUNT(DISTINCT CASE WHEN NOT cs.is_practical THEN cs.id END)::BIGINT AS theory_total_sessions,
      COUNT(DISTINCT CASE WHEN cs.is_practical THEN cs.id END)::BIGINT AS practical_total_sessions
    FROM public.students st
    CROSS JOIN course_sessions cs
    WHERE st.status = 'active'
      AND (cs.group_filter IS NULL OR cs.group_filter = st.group_label)
    GROUP BY st.id
  ),
  student_stats AS (
    SELECT 
      st.id AS student_id,
      st.roll_number,
      st.name,
      st.role_type,
      st.department,
      st.program,
      st.group_label,
      COUNT(DISTINCT CASE WHEN sr.status IN ('present', 'manual', 'override') THEN sr.session_id END)::BIGINT AS present_count,
      COUNT(DISTINCT CASE WHEN sr.status = 'excused' THEN sr.session_id END)::BIGINT AS excused_count,
      COUNT(DISTINCT CASE WHEN sr.method = 'manual' OR sr.status = 'manual' THEN sr.session_id END)::BIGINT AS manual_count,
      COUNT(DISTINCT CASE WHEN sr.method IN ('override_code', 'instructor_approved', 'gps_flagged') OR sr.status = 'override' THEN sr.session_id END)::BIGINT AS override_count,
      COUNT(DISTINCT CASE WHEN sr.status IN ('present', 'manual', 'override') AND NOT sr.is_practical THEN sr.session_id END)::BIGINT AS theory_present_count,
      COUNT(DISTINCT CASE WHEN sr.status IN ('present', 'manual', 'override') AND sr.is_practical THEN sr.session_id END)::BIGINT AS practical_present_count
    FROM public.students st
    LEFT JOIN student_records sr ON (sr.student_id = st.id OR UPPER(sr.roll_number) = UPPER(st.roll_number))
    WHERE st.status = 'active'
    GROUP BY st.id, st.roll_number, st.name, st.role_type, st.department, st.program, st.group_label
  )
  SELECT 
    ss.student_id,
    ss.roll_number,
    ss.name,
    ss.role_type,
    ss.department,
    ss.program,
    ss.group_label,
    ss.present_count,
    ss.excused_count,
    ss.manual_count,
    ss.override_count,
    GREATEST(COALESCE(sc.total_sessions, 0), ss.present_count)::BIGINT AS total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(sc.total_sessions, 0), ss.present_count) = 0 THEN 0.0
      ELSE ROUND((ss.present_count::NUMERIC / GREATEST(sc.total_sessions, ss.present_count)::NUMERIC) * 100, 1)
    END AS attendance_percentage,
    ss.theory_present_count,
    GREATEST(COALESCE(sc.theory_total_sessions, 0), ss.theory_present_count)::BIGINT AS theory_total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(sc.theory_total_sessions, 0), ss.theory_present_count) = 0 THEN 0.0
      ELSE ROUND((ss.theory_present_count::NUMERIC / GREATEST(sc.theory_total_sessions, ss.theory_present_count)::NUMERIC) * 100, 1)
    END AS theory_percentage,
    ss.practical_present_count,
    GREATEST(COALESCE(sc.practical_total_sessions, 0), ss.practical_present_count)::BIGINT AS practical_total_sessions,
    CASE 
      WHEN GREATEST(COALESCE(sc.practical_total_sessions, 0), ss.practical_present_count) = 0 THEN 0.0
      ELSE ROUND((ss.practical_present_count::NUMERIC / GREATEST(sc.practical_total_sessions, ss.practical_present_count)::NUMERIC) * 100, 1)
    END AS practical_percentage
  FROM student_stats ss
  LEFT JOIN session_counts sc ON sc.student_id = ss.student_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 13. Enable Row Level Security (RLS) Policies
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gps_override_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.override_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Allow public / authenticated access (Edge Functions use service_role key to bypass)
CREATE POLICY "Allow authenticated read staff" ON public.staff FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow staff update self" ON public.staff FOR UPDATE TO authenticated USING (auth.uid() = id);

CREATE POLICY "Allow public read courses" ON public.courses FOR SELECT USING (true);
CREATE POLICY "Allow authenticated insert courses" ON public.courses FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Allow course owners update" ON public.courses FOR UPDATE TO authenticated USING (owner_id = auth.uid());

CREATE POLICY "Allow public read course_settings" ON public.course_settings FOR SELECT USING (true);
CREATE POLICY "Allow authenticated update course_settings" ON public.course_settings FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow public read students" ON public.students FOR SELECT USING (true);
CREATE POLICY "Allow authenticated manage students" ON public.students FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow public read sessions" ON public.sessions FOR SELECT USING (true);
CREATE POLICY "Allow authenticated manage sessions" ON public.sessions FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow public read attendance_records" ON public.attendance_records FOR SELECT USING (true);
CREATE POLICY "Allow authenticated manage attendance_records" ON public.attendance_records FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow public insert gps_override_requests" ON public.gps_override_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public read gps_override_requests" ON public.gps_override_requests FOR SELECT USING (true);
CREATE POLICY "Allow authenticated manage gps_override_requests" ON public.gps_override_requests FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow public read activity_rounds" ON public.activity_rounds FOR SELECT USING (true);
CREATE POLICY "Allow authenticated manage activity_rounds" ON public.activity_rounds FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow authenticated read audit_logs" ON public.audit_logs FOR SELECT TO authenticated USING (true);
