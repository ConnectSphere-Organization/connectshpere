import "server-only";
import { config } from "@/config/env";
import type { DbName } from "@/server/db";

/**
 * Registry of platform services for the Monitoring Center. URLs are overridable
 * via env so the same code works in dev (localhost) and prod (internal DNS).
 *
 * Covers EVERY deployable: the API gateway, all nine backend microservices,
 * and the customer-portal frontend — so the super admin sees the entire
 * platform's connections in one place.
 */
export interface ServiceDef {
  id: string;
  name: string;
  baseUrl: string;
  /** Health endpoint path that returns 200 when the service is up. */
  healthPath: string;
  /** Logical tier shown in the UI. */
  tier: "edge" | "backend" | "frontend";
  /** Database the service owns or reads from in normal operation. */
  database: DbName;
}

const gatewayUrl = config.gatewayUrl;

const throughGateway = (
  id: string,
  name: string,
  healthService: string,
  tier: ServiceDef["tier"] = "backend",
  database: DbName = "core"
): ServiceDef => ({
  id,
  name,
  baseUrl: gatewayUrl,
  healthPath: `/api/internal/health/${healthService}`,
  tier,
  database,
});

const directOrGateway = (
  id: string,
  name: string,
  healthService: string,
  envNames: string[],
  database: DbName = "core"
): ServiceDef => {
  const directUrl = envNames
    .map((name) => serviceUrlFromEnvName(name))
    .find(Boolean);
  if (directUrl) {
    return { id, name, baseUrl: directUrl, healthPath: "/health", tier: "backend", database };
  }
  return throughGateway(id, name, healthService, "backend", database);
};

export const SERVICES: ServiceDef[] = [
  { id: "gateway", name: "API Gateway", baseUrl: gatewayUrl, healthPath: "/health", tier: "edge", database: "core" },
  directOrGateway("auth", "Auth Service", "auth", ["AUTH_SERVICE_URL"]),
  directOrGateway("chat", "Chat Service", "chat", ["CHAT_SERVICE_URL"]),
  directOrGateway("contact", "Contact Service", "contact", ["CONTACT_SERVICE_URL"]),
  directOrGateway("billing", "Billing Service", "billing", ["BILLING_SERVICE_URL"], "billing"),
  directOrGateway("campaign", "Campaign Service", "campaign", ["CAMPAIGN_SERVICE_URL"], "campaign"),
  directOrGateway("automation", "Automation Service", "automation", ["AUTOMATION_SERVICE_URL"], "automation"),
  directOrGateway("bsp", "BSP / Service Provider", "serviceProvider", ["SERVICE_PROVIDER_URL", "BSP_SERVICE_URL"], "bsp"),
  directOrGateway("ingestor", "Webhook Ingestor", "ingestor", ["WEBHOOK_INGESTOR_URL"], "bsp"),
  directOrGateway("websocket", "WebSocket Gateway", "websocket", ["WEBSOCKET_URL"]),
  {
    id: "customer-portal",
    name: "Customer Portal (frontend)",
    baseUrl: config.services.customerPortal,
    healthPath: "/",
    tier: "frontend",
    database: "core",
  },
];

function serviceUrlFromEnvName(name: string): string | undefined {
  const urls: Record<string, string | undefined> = {
    AUTH_SERVICE_URL: config.services.auth,
    CHAT_SERVICE_URL: config.services.chat,
    CONTACT_SERVICE_URL: config.services.contact,
    BILLING_SERVICE_URL: config.services.billing,
    CAMPAIGN_SERVICE_URL: config.services.campaign,
    AUTOMATION_SERVICE_URL: config.services.automation,
    SERVICE_PROVIDER_URL: config.services.serviceProvider,
    BSP_SERVICE_URL: config.services.serviceProvider,
    WEBHOOK_INGESTOR_URL: config.services.webhookIngestor,
    WEBSOCKET_URL: config.services.websocket,
  };
  return urls[name];
}
