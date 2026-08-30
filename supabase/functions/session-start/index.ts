import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { requireStaff } from "../_shared/staffAuth.ts";
import { signQrToken } from "../_shared/qr.ts";
import { logAudit } from "../_shared/audit.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  const auth = await requireStaff(req);
  if ("error" in auth) return withCors({ error: auth.error }, 401);

  try {
    const body = await req.json();
    const sessionType = String(body.sessionType ?? "").trim();
    const courseName = String(body.courseName ?? "").trim();
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!sessionType) return withCors({ error: "Session type is required." }, 400);
    if (!courseName) return withCors({ error: "Course is required." }, 400);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return withCors({ error: "Your current location is required to start a session." }, 400);
    }

    const db = serviceClient();
    const { data: settings } = await db.from("course_settings").select("*").maybeSingle();
    const radius = Number(body.radiusMeters) || settings?.gps_radius_meters || 100;
    const rotationSeconds = settings?.qr_rotation_seconds || 300;
    const tokenValiditySeconds = settings?.qr_token_validity_seconds || 600;
    const rotationId = crypto.randomUUID();
    const rotationExpiresAt = new Date(Date.now() + rotationSeconds * 1000);
    const tokenExpiresAt = new Date(Date.now() + tokenValiditySeconds * 1000);

    let roundId: string | null = body.roundId || null;
    const newRoundName = String(body.newRoundName ?? "").trim();
    if (!roundId && newRoundName) {
      const { data: round, error: roundErr } = await db
        .from("activity_rounds")
        .insert({ name: newRoundName, course_name: courseName })
        .select()
        .single();
      if (roundErr || !round) return withCors({ error: "Could not create the round." }, 500);
      roundId = round.id;
    }

    const { data: session, error } = await db
      .from("sessions")
      .insert({
        session_date: body.sessionDate || new Date().toISOString().slice(0, 10),
        session_type: sessionType,
        course_name: courseName,
        started_by: auth.staff.id,
        anchor_lat: lat,
        anchor_lng: lng,
        radius_meters: radius,
        group_filter: body.groupFilter || null,
        round_id: roundId,
        rotation_id: rotationId,
        rotation_expires_at: rotationExpiresAt.toISOString(),
        allow_gps_override: body.allowGpsOverride !== false,
        notes: body.notes || null,
      })
      .select()
      .single();

    if (error || !session) return withCors({ error: "Could not start the session." }, 500);

    const qrSigningSecret = Deno.env.get("QR_SIGNING_SECRET");
    if (!qrSigningSecret) {
      return withCors({ error: "Server configuration error: QR_SIGNING_SECRET missing." }, 500);
    }

    const qrToken = await signQrToken(
      { sid: session.id, rot: rotationId, exp: tokenExpiresAt.getTime() },
      qrSigningSecret,
    );

    await logAudit({
      actorId: auth.staff.id,
      actorLabel: auth.staff.email,
      action: "session_started",
      entityType: "session",
      entityId: session.id,
      after: session,
    });

    return withCors({ session, qrToken });
  } catch (err) {
    console.error("[session-start] error:", err);
    return withCors({ error: err instanceof Error ? err.message : "Invalid request." }, 400);
  }
});
