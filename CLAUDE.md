# SmartAttend — General Attendance Management System

Production QR + GPS attendance system. React + TypeScript + Vite + Tailwind, backed by Supabase (Postgres, Auth, Edge Functions, Realtime, Storage).

## Git

- Remote: `origin` → https://github.com/PrabhathLolugu/IC181_Attendance.git, branch `main`.
- Auth: Push using the token stored in `.env.deploy` (gitignored, never commit it):
  ```bash
  git push https://$(grep GITHUB_TOKEN .env.deploy | cut -d= -f2)@github.com/PrabhathLolugu/IC181_Attendance.git main
  ```
  Never write the raw token into a tracked file or commit message — only read it from `.env.deploy` at push time.


## Deploys

- Supabase project ref: `wkiejppvzbzuhzwflbon`.
- Env vars for migrations/deploys live in `.env.deploy` (gitignored). Load them with `set -a && source .env.deploy && set +a` before any script that needs them.
- `student-check`, `student-enroll`, `attendance-submit`, `override-code-redeem` are the 4 public-facing Edge Functions and must be deployed with `--no-verify-jwt`.
- Migrations live in `supabase/migrations/001_initial_schema.sql`.

## Data Model Notes

- Courses are dynamically managed and isolated by `course_name`.
- Any registered account user can create and manage their own courses, classes, colloquiums, seminars, or special sessions.
