import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { requireStaff } from "../_shared/staffAuth.ts";
import { logAudit } from "../_shared/audit.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  const auth = await requireStaff(req);
  if ("error" in auth) return withCors({ error: auth.error }, 401);

  try {
    const body = await req.json();
    const roll = String(body.rollNumber ?? "").trim().toUpperCase();
    const reason = String(body.reason ?? "").trim();
    const status = ["present", "excused"].includes(body.status) ? body.status : "present";
    if (!body.sessionId || !roll || !reason) {
      return withCors({ error: "Session, roll number, and a reason are all required." }, 400);
    }

    const db = serviceClient();
    const { data: session } = await db.from("sessions").select("*").eq("id", body.sessionId).maybeSingle();
    if (!session) return withCors({ error: "Session not found." }, 404);

    const { data: student } = await db.from("students").select("*").ilike("roll_number", roll).maybeSingle();
    if (!student) return withCors({ error: "No student found with that roll number." }, 404);

    const { data: record, error } = await db
      .from("attendance_records")
      .insert({
        session_id: session.id,
        student_id: student.id,
        roll_number: student.roll_number,
        status,
        method: "manual",
        recorded_by: auth.staff.id,
        notes: reason,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return withCors({ error: "This student already has attendance recorded for this session." }, 409);
      }
      return withCors({ error: "Could not record attendance." }, 500);
    }

    await logAudit({
      actorId: auth.staff.id,
      actorLabel: auth.staff.email,
      action: "manual_attendance_added",
      entityType: "attendance_record",
      entityId: record.id,
      after: record,
    });

    return withCors({ record });
  } catch {
    return withCors({ error: "Invalid request." }, 400);
  }
});
