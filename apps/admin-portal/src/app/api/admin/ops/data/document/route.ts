import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, AdminAuthError } from "@/server/auth";
import { recordAudit, clientIp } from "@/server/audit";
import { updateDocument } from "@/server/config-ops";
import { parseAdminDatabase } from "@/server/admin-databases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Data Explorer — update a single document (SELF-CONTAINED direct write,
 * system role only; the dangerous-operator guard lives in updateDocument).
 * Body: { database, collection, id, update }.
 */
export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireAdmin("system");
    const body = await req.json().catch(() => ({}));
    const { database: databaseInput, collection, id, update } = body as {
      database?: string;
      collection?: string;
      id?: string;
      update?: Record<string, unknown>;
    };

    const database = parseAdminDatabase(databaseInput);
    if (!database || !collection || !id || !update) {
      return NextResponse.json({ message: "database, collection, id and update are required" }, { status: 400 });
    }

    const data = await updateDocument(database, collection, id, update);

    await recordAudit({
      actor,
      action: "data.document.update",
      target: `${database}.${collection}`,
      targetId: id,
      metadata: { update, mode: "direct" },
      ip: clientIp(req),
      outcome: "success",
    });

    return NextResponse.json({ ok: true, data });
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Failed to update document";
    console.error("[admin/ops/data/document]", err);
    return NextResponse.json({ message }, { status: 500 });
  }
}
