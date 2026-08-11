"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Database, Server, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiFetch, apiGet } from "@/lib/api/client";
import { useAdminAuth } from "@/store/admin-auth-store";

interface ServiceControl {
  published: boolean;
  customerVisible: boolean;
  maintenance: boolean;
  message: string;
  updatedAt?: string;
}

interface ServiceHealth {
  id: string;
  name: string;
  tier?: string;
  status: "up" | "down";
  latencyMs: number | null;
  database: { name: string; status: string };
  control: ServiceControl;
}

interface MonitoringData {
  services: ServiceHealth[];
  process: { uptimeSec: number; memoryRssMb: number; nodeVersion: string; mongooseVersion: string };
  generatedAt: string;
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

export default function MonitoringPage() {
  const can = useAdminAuth((s) => s.can);
  const editable = can("system");
  const queryClient = useQueryClient();
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ["monitoring"],
    queryFn: () => apiGet<MonitoringData>("/api/admin/read/monitoring"),
    refetchInterval: 15_000,
  });

  const updateControl = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<ServiceControl> }) =>
      apiFetch(`/api/admin/ops/services/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => {
      toast.success("Service control updated");
      queryClient.invalidateQueries({ queryKey: ["monitoring"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const patchServiceControl = (service: ServiceHealth, patch: Partial<ServiceControl>) => {
    const nextPatch = { ...patch };
    if (patch.maintenance === true) {
      nextPatch.message = window.prompt("Maintenance message shown in customer portal:", service.control.message || "This service is under maintenance.") || "";
    }
    if (patch.maintenance === false && service.control.published) {
      nextPatch.message = "";
    }
    if (patch.published === false) {
      nextPatch.message = window.prompt("Unavailable message shown in customer portal:", service.control.message || "This service is temporarily unavailable.") || "";
    }
    if (patch.published === true && !service.control.maintenance) {
      nextPatch.message = "";
    }
    updateControl.mutate({ id: service.id, patch: nextPatch });
  };

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="Live service and database health, with process metrics"
        actions={
          isFetching ? (
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : null
        }
      />
      <div className="p-6 space-y-6">
        {isError ? (
          <p className="text-sm text-destructive">Failed to load monitoring data.</p>
        ) : (
          <>
            <section>
              <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <Server className="h-4 w-4" /> Services
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {isLoading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <Card key={i}>
                        <CardContent className="p-4">
                          <Skeleton className="h-5 w-32" />
                        </CardContent>
                      </Card>
                    ))
                  : data?.services.map((s) => (
                      <Card key={s.id}>
                        <CardContent className="p-4 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-medium text-sm">{s.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {s.tier ? `${s.tier} · ` : ""}{s.latencyMs != null ? `${s.latencyMs} ms` : "—"}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {s.control.maintenance ? <Badge variant="outline">maintenance</Badge> : null}
                              {!s.control.published ? <Badge variant="outline">unpublished</Badge> : null}
                              <Badge variant={s.status === "up" ? "success" : "destructive"}>
                                {s.status}
                              </Badge>
                            </div>
                          </div>
                          <div className="flex items-center justify-between border-t pt-3 text-xs">
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                              <Database className="h-3.5 w-3.5" />
                              Database · <span className="font-medium capitalize text-foreground">{s.database.name}</span>
                            </span>
                            <Badge variant={s.database.status === "connected" ? "success" : "outline"}>
                              {s.database.status}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-3 gap-3 border-t pt-3">
                            <ServiceSwitch
                              label="Publish"
                              checked={s.control.published}
                              disabled={!editable || updateControl.isPending}
                              onChange={(published) => patchServiceControl(s, { published })}
                            />
                            <ServiceSwitch
                              label="Customer"
                              checked={s.control.customerVisible}
                              disabled={!editable || updateControl.isPending}
                              onChange={(customerVisible) => patchServiceControl(s, { customerVisible })}
                            />
                            <ServiceSwitch
                              label="Maint."
                              checked={s.control.maintenance}
                              disabled={!editable || updateControl.isPending}
                              onChange={(maintenance) => patchServiceControl(s, { maintenance })}
                            />
                          </div>
                        </CardContent>
                      </Card>
                    ))}
              </div>
            </section>

            {data?.process && (
              <section>
                <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                  <Activity className="h-4 w-4" /> Admin Portal Process
                </h2>
                <Card>
                  <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 text-sm">
                    <Metric label="Uptime" value={uptime(data.process.uptimeSec)} />
                    <Metric label="Memory (RSS)" value={`${data.process.memoryRssMb} MB`} />
                    <Metric label="Node" value={data.process.nodeVersion} />
                    <Metric label="Mongoose" value={data.process.mongooseVersion} />
                  </CardContent>
                </Card>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function ServiceSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}
