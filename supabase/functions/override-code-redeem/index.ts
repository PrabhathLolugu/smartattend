import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { verifyQrToken } from "../_shared/qr.ts";
import { logAudit } from "../_shared/audit.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const body = await req.json();
    const qrSigningSecret = Deno.env.get("QR_SIGNING_SECRET");
    if (!qrSigningSecret) {
      return withCors({ error: "Server configuration error. Please contact support." }, 500);
    }
    const qrCheck = await verifyQrToken(String(body.qrToken ?? ""), qrSigningSecret);
    if (!qrCheck.valid) return withCors({ error: qrCheck.error }, 400);

    const roll = String(body.rollNumber ?? "").trim().toUpperCase();
    const code = String(body.code ?? "").trim();
    if (!roll || !code) return withCors({ error: "Roll number and code are required." }, 400);

    const db = serviceClient();
    const { data: session } = await db.from("sessions").select("*").eq("id", qrCheck.payload.sid).eq("status", "active").maybeSingle();
    if (!session) return withCors({ error: "Attendance session not found or has ended." }, 404);

    if (!session.override_code || session.override_code !== code) {
      return withCors({ error: "Incorrect code. Please check with your instructor." }, 400);
    }
    if (!session.override_code_expires_at || new Date(session.override_code_expires_at).getTime() < Date.now()) {
      return withCors({ error: "This code has expired. Ask your instructor to generate a new one." }, 400);
    }

    let student = await (async () => {
      const { data } = await db.from("students").select("*").ilike("roll_number", roll).maybeSingle();
      return data;
    })();

    // Auto-register student if first-time
    if (!student || student.status === "deleted") {
      const { data: created, error: autoInsertErr } = await db
        .from("students")
        .insert({ roll_number: roll, name: roll, role_type: "student" })
        .select()
        .single();

      if (!created) {
        const { data: refetched } = await db.from("students").select("*").ilike("roll_number", roll).maybeSingle();
        if (!refetched) {
          console.error("[override-code-redeem] auto-register failed:", autoInsertErr);
          return withCors({ error: "Could not register student. Please try again." }, 500);
        }
        student = refetched;
      } else {
        student = created;
      }
    }

    // Check if already marked
    const { data: existing } = await db
      .from("attendance_records")
      .select("marked_at, status")
      .eq("session_id", session.id)
      .eq("student_id", student.id)
      .maybeSingle();
    if (existing) {
      return withCors({ duplicate: true, markedAt: existing.marked_at, status: existing.status });
    }

    const { data: record, error } = await db
      .from("attendance_records")
      .insert({
        session_id: session.id,
        student_id: student.id,
        roll_number: student.roll_number,
        status: "override",
        method: "override_code",
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return withCors({ duplicate: true });
      }
      return withCors({ error: "Could not record attendance. Please try again." }, 500);
    }

    await logAudit({
      actorLabel: `student:${roll}`,
      action: "override_code_redeemed",
      entityType: "attendance_record",
      entityId: record.id,
      after: record,
    });

    return withCors({ record, student });
  } catch (err) {
    return withCors({ error: err instanceof Error ? err.message : "Invalid request." }, 400);
  }
});
