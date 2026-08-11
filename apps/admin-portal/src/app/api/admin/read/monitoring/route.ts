import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { requireAdmin, AdminAuthError } from "@/server/auth";
import { SERVICES } from "@/server/services-config";
import { getConnection, type DbName } from "@/server/db";
import { coreModels } from "@/server/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ServiceHealth {
  id: string;
  name: string;
  tier: string;
  status: "up" | "down";
  latencyMs: number | null;
  database: { name: DbName; status: string };
  control: ServiceControl;
  detail?: unknown;
}

interface ServiceControl {
  published: boolean;
  customerVisible: boolean;
  maintenance: boolean;
  message: string;
  updatedAt?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

function getProbeTimeoutMs(): number {
  const configured = Number(process.env.MONITORING_PROBE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PROBE_TIMEOUT_MS;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function probe(baseUrl: string, healthPath: string): Promise<{ ok: boolean; latencyMs: number; detail?: unknown }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getProbeTimeoutMs());
  try {
    const res = await fetch(joinUrl(baseUrl, healthPath), {
      cache: "no-store",
      signal: controller.signal,
    });
    const detail = await res.json().catch(() => undefined);
    return { ok: res.ok, latencyMs: Date.now() - start, detail };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

const READY_STATE: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

function normalizeControl(value: unknown): ServiceControl {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    published: raw.published !== false,
    customerVisible: raw.customerVisible !== false,
    maintenance: raw.maintenance === true,
    message: typeof raw.message === "string" ? raw.message : "",
    updatedAt:
      raw.updatedAt instanceof Date
        ? raw.updatedAt.toISOString()
        : typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : undefined,
  };
}

/**
 * Monitoring snapshot — probes every service health endpoint and reports
 * MongoDB connection states. This is a READ (Rule #4): pure observation.
 */
export async function GET() {
  try {
    await requireAdmin("read");
    const { SystemSettings } = await coreModels();
    const settings = (await SystemSettings.findOne({}).lean()) as Record<string, unknown> | null;
    const features = settings?.features && typeof settings.features === "object" ? settings.features as Record<string, unknown> : {};
    const serviceControls =
      features.serviceControls && typeof features.serviceControls === "object"
        ? features.serviceControls as Record<string, unknown>
        : {};

    // Open every database once, then include its live status on the related
    // service card. This keeps the monitoring view actionable without a
    // disconnected database-only section.
    const dbNames: DbName[] = ["core", "billing", "campaign", "automation", "bsp"];
    const databases = await Promise.all(
      dbNames.map(async (name) => {
        try {
          const conn = await getConnection(name);
          return { name, status: READY_STATE[conn.readyState] || "unknown" };
        } catch {
          return { name, status: "unreachable" };
        }
      })
    );
    const databaseByName = new Map(databases.map((database) => [database.name, database]));

    const services: ServiceHealth[] = await Promise.all(
      SERVICES.map(async (svc) => {
        const r = await probe(svc.baseUrl, svc.healthPath);
        return {
          id: svc.id,
          name: svc.name,
          tier: svc.tier,
          status: r.ok ? "up" : "down",
          latencyMs: r.latencyMs,
          database: databaseByName.get(svc.database) || { name: svc.database, status: "unknown" },
          control: normalizeControl(serviceControls[svc.id]),
          detail: r.detail,
        } as ServiceHealth;
      })
    );

    return NextResponse.json({
      services,
      process: {
        uptimeSec: Math.round(process.uptime()),
        memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        nodeVersion: process.version,
        mongooseVersion: mongoose.version,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    console.error("[admin/read/monitoring]", err);
    return NextResponse.json({ message: "Failed to load monitoring data" }, { status: 500 });
  }
}
