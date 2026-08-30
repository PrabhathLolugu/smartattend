import { handleOptions, withCors } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/client.ts";
import { logAudit } from "../_shared/audit.ts";

// Must match MAX_CAPACITY in the Yoga group registration Apps Script — this
// is a backstop against the Apps Script's own choice-list filtering, not the
// primary enforcement (the form already hides a group once it's full).
// Capacity limit for groups
const MAX_CAPACITY = 60;

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const body = await req.json();
    const roll = String(body.rollNumber ?? "").trim().toUpperCase();
    let name = String(body.name ?? "").trim();
    const rawGroup = String(body.group ?? "").trim();
    if (!roll || !rawGroup) {
      return withCors({ error: "Roll number and group are required." }, 400);
    }

    // Support "A", "Group A", "Group A — Monday...", etc.
    const match = rawGroup.match(/^(?:Group\s+)?([A-Za-z])\b/i);
    const code = (match ? match[1] : rawGroup.slice(0, 1)).toUpperCase();

    const email = body.email ? String(body.email).trim() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return withCors({ error: "Please enter a valid email address." }, 400);
    }

    const db = serviceClient();

    const { data: existing, error: lookupErr } = await db
      .from("students")
      .select("*")
      .ilike("roll_number", roll)
      .maybeSingle();
    if (lookupErr) return withCors({ error: "Lookup failed. Please try again." }, 500);

    if (existing && existing.status === "deleted") {
      return withCors({ error: "This roll number is not active in the system. Please contact the instructor." }, 409);
    }

    if (!name && existing?.name) {
      name = existing.name;
    }
    if (!name) {
      name = roll;
    }

    if (!existing || existing.group_label !== code) {
      const { count, error: countErr } = await db
        .from("students")
        .select("id", { count: "exact", head: true })
        .eq("group_label", code)
        .eq("status", "active");
      if (countErr) return withCors({ error: "Could not check group capacity. Please try again." }, 500);
      if ((count ?? 0) >= MAX_CAPACITY) {
        return withCors({ error: `Group ${code} is full (max ${MAX_CAPACITY} students). Please choose another group.` }, 409);
      }
    }

    let student;
    if (existing) {
      const { data, error } = await db
        .from("students")
        .update({ group_label: code, email: existing.email ?? email })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) return withCors({ error: "Could not update your group. Please try again." }, 500);
      student = data;
    } else {
      const { data, error } = await db
        .from("students")
        .insert({ roll_number: roll, name, email, group_label: code })
        .select()
        .single();
      if (error) {
        if (error.code === "23505") {
          return withCors({ error: "This roll number was just registered — please resubmit." }, 409);
        }
        return withCors({ error: "Registration failed. Please try again." }, 500);
      }
      student = data;
    }

    await logAudit({
      actorLabel: `student:${roll}`,
      action: existing ? "student_group_updated" : "student_group_registered",
      entityType: "student",
      entityId: student.id,
      before: existing ?? null,
      after: student,
    });

    return withCors({ student, group: code });
  } catch (err) {
    console.error("[group-register] error:", err);
    return withCors({ error: err instanceof Error ? err.message : "Invalid request." }, 400);
  }
});
