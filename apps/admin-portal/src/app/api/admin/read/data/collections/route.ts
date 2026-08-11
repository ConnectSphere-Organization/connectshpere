import { NextResponse } from "next/server";
import { requireAdmin, AdminAuthError } from "@/server/auth";
import { getConnection } from "@/server/db";
import { parseAdminDatabase } from "@/server/admin-databases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Data Explorer — list collections (SELF-CONTAINED, direct from core DB). System role. */
export async function GET(req: Request) {
  try {
    await requireAdmin("system");
    const database = parseAdminDatabase(new URL(req.url).searchParams.get("database"));
    if (!database) return NextResponse.json({ message: "Valid database is required" }, { status: 400 });
    const connection = await getConnection(database);
    const db = connection.db;
    if (!db) throw new Error(`${database} DB unavailable`);
    const collections = await db.listCollections().toArray();
    return NextResponse.json({ success: true, database, data: collections.map((c: any) => c.name).sort() });
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    console.error("[admin/read/data/collections]", err);
    return NextResponse.json({ message: "Failed to list collections" }, { status: 500 });
  }
}
