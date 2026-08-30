import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { requireStaff } from "../_shared/staffAuth.ts";
import { signQrToken } from "../_shared/qr.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  const auth = await requireStaff(req);
  if ("error" in auth) return withCors({ error: auth.error }, 401);

  try {
    const { sessionId } = await req.json();
    const db = serviceClient();
    const { data: session } = await db
      .from("sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("status", "active")
      .maybeSingle();
    if (!session) return withCors({ error: "Session is not active." }, 404);

    const { data: settings } = await db.from("course_settings").select("qr_rotation_seconds, qr_token_validity_seconds").maybeSingle();
    const rotationSeconds = settings?.qr_rotation_seconds || 300;
    const tokenValiditySeconds = settings?.qr_token_validity_seconds || 600;
    const rotationId = crypto.randomUUID();
    const rotationExpiresAt = new Date(Date.now() + rotationSeconds * 1000);
    const tokenExpiresAt = new Date(Date.now() + tokenValiditySeconds * 1000);

    await db
      .from("sessions")
      .update({ rotation_id: rotationId, rotation_expires_at: rotationExpiresAt.toISOString() })
      .eq("id", sessionId);

    const qrSigningSecret = Deno.env.get("QR_SIGNING_SECRET");
    if (!qrSigningSecret) {
      return withCors({ error: "Server configuration error: QR_SIGNING_SECRET missing." }, 500);
    }

    const qrToken = await signQrToken(
      { sid: session.id, rot: rotationId, exp: tokenExpiresAt.getTime() },
      qrSigningSecret,
    );

    return withCors({ qrToken, expiresAt: rotationExpiresAt.toISOString() });
  } catch (err) {
    console.error("[session-qr-rotate] error:", err);
    return withCors({ error: err instanceof Error ? err.message : "Invalid request." }, 400);
  }
});
