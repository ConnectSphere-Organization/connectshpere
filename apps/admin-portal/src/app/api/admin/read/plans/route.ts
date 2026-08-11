import { NextResponse } from "next/server";
import { requireAdmin, AdminAuthError } from "@/server/auth";
import { coreModels } from "@/server/models";
import { syncPlanCatalogToBilling } from "@/server/config-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Plan catalogue — direct read (Rule #4). */
export async function GET() {
  try {
    await requireAdmin("read");
    const { Plan } = await coreModels();
    const items = await Plan.find({}).sort({ name: 1 }).lean();
    // Core is the authoritative catalogue for the Admin UI. Billing is a
    // replica used by checkout; a temporary billing connection failure must
    // never hide an otherwise valid plan catalogue from Super Admin.
    let billingSynchronized = true;
    try {
      await syncPlanCatalogToBilling();
    } catch (syncError) {
      billingSynchronized = false;
      console.warn("[admin/read/plans] Billing catalogue sync deferred:", syncError instanceof Error ? syncError.message : syncError);
    }

    return NextResponse.json({ items, billingSynchronized });
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    console.error("[admin/read/plans]", err);
    return NextResponse.json({ message: "Failed to load plans" }, { status: 500 });
  }
}
