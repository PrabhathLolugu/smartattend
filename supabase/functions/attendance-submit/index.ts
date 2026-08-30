import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { verifyQrToken } from "../_shared/qr.ts";
import { haversineMeters } from "../_shared/geo.ts";
import { logAudit } from "../_shared/audit.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const body = await req.json();
    const qrCheck = await verifyQrToken(String(body.qrToken ?? ""), Deno.env.get("QR_SIGNING_SECRET")!);
    if (!qrCheck.valid) return withCors({ error: qrCheck.error }, 400);

    const roll = String(body.rollNumber ?? "").trim().toUpperCase();
    if (!roll) return withCors({ error: "Roll number is required." }, 400);

    const db = serviceClient();

    const { data: session } = await db.from("sessions").select("*").eq("id", qrCheck.payload.sid).maybeSingle();
    if (!session) return withCors({ error: "Attendance session not found." }, 404);
    if (session.status !== "active") {
      return withCors({ error: "This attendance session has already ended." }, 410);
    }

    const { data: student } = await db.from("students").select("*").ilike("roll_number", roll).maybeSingle();
    if (!student || student.status === "deleted") {
      return withCors(
        { error: "No student found with that roll number. Check spelling and try again.", code: "not_found" },
        404,
      );
    }

    // ── Duplicate check ───────────────────────────────────────────────────────
    const { data: existing } = await db
      .from("attendance_records")
      .select("marked_at, status")
      .eq("session_id", session.id)
      .eq("student_id", student.id)
      .maybeSingle();
    if (existing) {
      return withCors({ duplicate: true, markedAt: existing.marked_at, status: existing.status });
    }

    // ── GPS analysis (NEVER blocks the student) ───────────────────────────────
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const hasPosition = Number.isFinite(lat) && Number.isFinite(lng);

    let gpsFlag: string | null = null;      // null = clean GPS, otherwise flagged for instructor
    let distanceMeters: number | null = null;

    if (!hasPosition) {
      // GPS unavailable or denied — student is still allowed through
      gpsFlag = body.gpsDenied ? "gps_denied" : "gps_unavailable";
    } else {
      const distance = haversineMeters(lat, lng, session.anchor_lat, session.anchor_lng);
      distanceMeters = distance;
      const accuracy = Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : 0;
      // Account for mobile GPS accuracy variance (up to 100m indoor buffer)
      const effectiveDistance = Math.max(0, distance - Math.min(accuracy, 100));
      const sessionRadius = session.radius_meters || 150;
      const withinRadius = effectiveDistance <= sessionRadius;

      if (!withinRadius) {
        // Outside radius — still allowed, just flagged for instructor review
        gpsFlag = "outside_radius";
      }
    }

    // ── Always record attendance ──────────────────────────────────────────────
    const { data: record, error: insertErr } = await db
      .from("attendance_records")
      .insert({
        session_id: session.id,
        student_id: student.id,
        roll_number: student.roll_number,
        status: "present",
        method: gpsFlag ? "gps_flagged" : "gps",
        distance_meters: distanceMeters,
        gps_lat: hasPosition ? lat : null,
        gps_lng: hasPosition ? lng : null,
        gps_accuracy: hasPosition && Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
        gps_flag: gpsFlag,
      })
      .select()
      .single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        return withCors({ duplicate: true });
      }
      return withCors({ error: "Could not record attendance. Please try again." }, 500);
    }

    // ── Log GPS override request for instructor visibility (non-blocking) ─────
    if (gpsFlag) {
      await db
        .from("gps_override_requests")
        .upsert(
          {
            session_id: session.id,
            student_id: student.id,
            roll_number: student.roll_number,
            distance_meters: distanceMeters,
            reason: gpsFlag,
            status: "auto_allowed",   // not 'pending' — student already has attendance
          },
          { onConflict: "session_id,student_id", ignoreDuplicates: true },
        );
    }

    await logAudit({
      actorLabel: `student:${roll}`,
      action: "attendance_submitted",
      entityType: "attendance_record",
      entityId: record.id,
      after: { ...record, gpsFlag },
    });

    return withCors({ record, student, session });
  } catch (err) {
    return withCors({ error: err instanceof Error ? err.message : "Something went wrong. Please try again." }, 400);
  }
});
