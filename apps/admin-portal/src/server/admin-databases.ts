import type { DbName } from "./db";

export const ADMIN_DATABASES: ReadonlyArray<{ id: DbName; label: string }> = [
  { id: "core", label: "Core" },
  { id: "billing", label: "Billing" },
  { id: "campaign", label: "Campaign" },
  { id: "automation", label: "Automation" },
  { id: "bsp", label: "BSP / Service Provider" },
];

export function parseAdminDatabase(value: string | null | undefined): DbName | null {
  return ADMIN_DATABASES.some((database) => database.id === value) ? value as DbName : null;
}
