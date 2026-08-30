import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { logAudit } from "../_shared/audit.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const body = await req.json();
    const roll = String(body.rollNumber ?? "").trim().toUpperCase();
    const name = String(body.name ?? "").trim();
    if (!roll || !name) return withCors({ error: "ID / Roll number and name are required." }, 400);

    const roleType = body.roleType === 'faculty' ? 'faculty' : 'student';
    const department = body.department ? String(body.department).trim() : null; // School / Centre
    const program = body.program ? String(body.program).trim() : null;       // Program (e.g. B.Tech, M.Tech, Ph.D.)

    const db = serviceClient();

    const { data: existing } = await db
      .from("students")
      .select("id, name, status")
      .ilike("roll_number", roll)
      .maybeSingle();

    let data;
    if (existing) {
      const { data: updated, error: updateErr } = await db
        .from("students")
        .update({
          name,
          role_type: roleType,
          department,
          program,
          status: "active",
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (updateErr) {
        console.error("[student-enroll] update error:", updateErr);
        return withCors({ error: "Could not update registration details. Please try again." }, 500);
      }
      data = updated;
    } else {
      const { data: inserted, error: insertErr } = await db
        .from("students")
        .insert({
          roll_number: roll,
          name,
          role_type: roleType,
          department,
          program,
        })
        .select()
        .single();

      if (insertErr) {
        if (insertErr.code === "23505") {
          // Race condition with concurrent insert — update the existing record
          const { data: raceUpdated } = await db
            .from("students")
            .update({ name, role_type: roleType, department, program, status: "active" })
            .ilike("roll_number", roll)
            .select()
            .single();
          if (raceUpdated) {
            data = raceUpdated;
          } else {
            return withCors(
              { error: "This ID / Roll number is already registered.", code: "already_registered" },
              409,
            );
          }
        } else {
          console.error("[student-enroll] insert error:", insertErr);
          return withCors({ error: "Registration failed. Please try again." }, 500);
        }
      } else {
        data = inserted;
      }
    }

    await logAudit({
      actorLabel: `${roleType}:${roll}`,
      action: existing ? "participant_updated" : "participant_registered",
      entityType: "student",
      entityId: data.id,
      after: data,
    });

    return withCors({ student: data });
  } catch (err) {
    console.error("[student-enroll] unexpected error:", err);
    return withCors({ error: err instanceof Error ? err.message : "Invalid request." }, 400);
  }
});
