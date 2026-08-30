import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { requireStaff } from "../_shared/staffAuth.ts";
import ExcelJS from "npm:exceljs@4.4.0";

const BUCKET = "attendance-exports";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  const auth = await requireStaff(req);
  if ("error" in auth) return withCors({ error: auth.error }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const fromDate: string | undefined = body.fromDate || undefined;
    const toDate: string | undefined = body.toDate || undefined;
    const courseName: string = body.courseName || "General Class";

    const db = serviceClient();

    const { data: students } = await db
      .from("students")
      .select("roll_number, name, role_type, department, program, group_label")
      .eq("status", "active")
      .order("roll_number");
    const { data: summaries } = await db.rpc("student_attendance_summary", { p_course_name: courseName });
    const pctByRoll = new Map((summaries ?? []).map((s: { roll_number: string; attendance_percentage: number }) => [s.roll_number, s.attendance_percentage]));

    const isPractical = (type: string) => {
      const t = (type || "").toLowerCase();
      return t.includes("yoga") || t.includes("practical") || t.includes("lab") || t.includes("activity");
    };

    let sessionQuery = db.from("sessions").select("id, session_date, session_type, course_name, group_filter, round_id").eq("status", "ended").eq("course_name", courseName).order("session_date");
    if (fromDate) sessionQuery = sessionQuery.gte("session_date", fromDate);
    if (toDate) sessionQuery = sessionQuery.lte("session_date", toDate);
    const { data: sessions } = await sessionQuery;

    const { data: records } = sessions?.length
      ? await db.from("attendance_records").select("session_id, roll_number, status").in("session_id", sessions.map((s) => s.id)).limit(20000)
      : { data: [] };

    const byStudentSession = new Map<string, string>();
    for (const r of records ?? []) byStudentSession.set(`${r.roll_number}|${r.session_id}`, r.status);

    const workbook = new ExcelJS.Workbook();
    const sheetName = courseName.slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    sheet.columns = [
      { header: "Roll / Emp ID", key: "roll", width: 16 },
      { header: "Name", key: "name", width: 26 },
      { header: "Role", key: "role", width: 16 },
      { header: "School / Centre", key: "dept", width: 30 },
      { header: "Program", key: "prog", width: 16 },
      { header: "Group", key: "group", width: 10 },
      ...(sessions ?? []).map((s) => {
        const tag = isPractical(s.session_type) ? "[Practical]" : "[Theory]";
        return {
          header: `${s.session_date} · ${tag} ${s.course_name} (${s.session_type})${s.round_id ? " ↻" : ""}`,
          key: s.id,
          width: 20,
        };
      }),
      { header: "Theory %", key: "theory_pct", width: 14 },
      { header: "Yoga/Pract. %", key: "practical_pct", width: 16 },
      { header: "Overall %", key: "pct", width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };

    const LABELS: Record<string, string> = { manual: "Manual", override: "Override", excused: "Excused", present: "P" };

    for (const student of students ?? []) {
      const row: Record<string, string | number> = {
        roll: student.roll_number,
        name: student.name,
        role: student.role_type === 'faculty' ? 'Faculty / Staff' : 'Student',
        dept: student.department ?? "",
        prog: student.program ?? "",
        group: student.group_label ?? "",
      };

      let theoryTot = 0;
      let theoryPres = 0;
      let practicalTot = 0;
      let practicalPres = 0;

      for (const s of sessions ?? []) {
        const applicable = !s.group_filter || s.group_filter === student.group_label;
        const status = byStudentSession.get(`${student.roll_number}|${s.id}`);
        const attended = status && status !== "excused";
        const practical = isPractical(s.session_type);

        if (!applicable && !attended) {
          row[s.id] = "-";
          continue;
        }

        if (practical) {
          practicalTot += 1;
          if (attended) practicalPres += 1;
        } else {
          theoryTot += 1;
          if (attended) theoryPres += 1;
        }

        row[s.id] = status ? (LABELS[status] ?? "P") : "A";
      }

      const totalHeld = theoryTot + practicalTot;
      const totalPres = theoryPres + practicalPres;

      row.theory_pct = theoryTot === 0 ? "N/A" : `${Math.round((theoryPres / theoryTot) * 1000) / 10}%`;
      row.practical_pct = practicalTot === 0 ? "N/A" : `${Math.round((practicalPres / practicalTot) * 1000) / 10}%`;
      row.pct = totalHeld === 0 ? "N/A" : `${Math.round((totalPres / totalHeld) * 1000) / 10}%`;
      sheet.addRow(row);
    }


    const buffer = await workbook.xlsx.writeBuffer();

    await db.storage.createBucket(BUCKET, { public: false }).catch(() => {});
    const safeCourse = courseName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = fromDate || toDate
      ? `${safeCourse}_${fromDate || "start"}_to_${toDate || "end"}.xlsx`
      : `${safeCourse}_Attendance.xlsx`;
    const { error: uploadErr } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      upsert: true,
    });
    if (uploadErr) return withCors({ error: "Could not save the Excel file: " + uploadErr.message }, 500);

    const { data: signed, error: signErr } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (signErr || !signed) return withCors({ error: "File saved, but could not generate a download link." }, 500);

    return withCors({ url: signed.signedUrl });
  } catch (err) {
    console.error("[excel-sync] error:", err);
    return withCors({ error: err instanceof Error ? err.message : "Excel export failed." }, 500);
  }
});
