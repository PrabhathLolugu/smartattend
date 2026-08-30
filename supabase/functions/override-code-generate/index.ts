import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { requireStaff } from "../_shared/staffAuth.ts";
import { logAudit } from "../_shared/audit.ts";

function sixDigitCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
      .select("id")
      .eq("id", sessionId)
      .eq("status", "active")
      .maybeSingle();
    if (!session) return withCors({ error: "Session is not active." }, 404);

    const { data: settings } = await db.from("course_settings").select("override_code_ttl_seconds").maybeSingle();
    const ttl = settings?.override_code_ttl_seconds || 120;
    const code = sixDigitCode();
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await db
      .from("sessions")
      .update({ override_code: code, override_code_expires_at: expiresAt.toISOString() })
      .eq("id", sessionId);

    await logAudit({
      actorId: auth.staff.id,
      actorLabel: auth.staff.email,
      action: "override_code_generated",
      entityType: "session",
      entityId: sessionId,
    });

    return withCors({ code, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error("[override-code-generate] error:", err);
    return withCors({ error: err instanceof Error ? err.message : "Invalid request." }, 400);
  }
});
