"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Globe,
  Zap,
  ShieldCheck,
  Search,
  Filter,
  Loader2,
  MoreVertical,
  UserCog,
  Users as UsersIcon,
  Trash2,
  Settings,
  Webhook,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiGet, apiPost } from "@/lib/api/client";
import { useAdminAuth } from "@/store/admin-auth-store";

const GUPSHUP_MODES = [
  "MESSAGE", "SENT", "DELIVERED", "READ", "FAILED",
  "ENQUEUED", "TEMPLATE", "ACCOUNT", "BILLING", "PAYMENTS", "FLOWS_MESSAGE",
];

const DEFAULT_GUPSHUP_WEBHOOK_URL =
  "https://connectsphere-customer-vivek.eastus2.cloudapp.azure.com/api/webhooks/whatsapp";

type GupshupOpResult = {
  ok?: boolean;
  data?: {
    skipped?: boolean;
    message?: string;
  };
};

interface Workspace {
  _id: string;
  name: string;
  owner?: { name?: string; email?: string };
  plan?: { name?: string; slug?: string };
  billingStatus?: string;
  whatsappConnected?: boolean;
  gupshupAppId?: string;
  gupshupIdentity?: { partnerAppId?: string };
  gupshupAppLive?: boolean;
  gupshupAppHealth?: boolean | null;
  bspWabaId?: string;
  wabaId?: string;
  bspPhoneStatus?: string;
  bspSyncStatus?: string;
  bspLastSyncedAt?: string;
  esbFlow?: { status?: string };
  walletBalance?: number;
  walletCurrency?: string;
  walletParkedBalance?: number;
  walletThreshold?: number;
  phoneNumbers?: Array<{ id?: string; displayPhoneNumber?: string; verifiedName?: string; status?: string }>;
  createdAt?: string;
}

interface WebhookStatus {
  subscriptions: Array<{ id: string; url: string; modes?: string[]; events?: string[]; status?: string }>;
  syncStatus?: string;
  lastSyncedAt?: string | null;
}

function needsAttention(ws: Workspace): boolean {
  return (
    ["BANNED", "DISCONNECTED", "PENDING", "INACTIVE"].includes(String(ws.bspPhoneStatus || "").toUpperCase()) ||
    ws.gupshupAppHealth === false ||
    (!ws.whatsappConnected && !!ws.gupshupAppId)
  );
}

export default function WorkspacesPage() {
  const qc = useQueryClient();
  const can = useAdminAuth((s) => s.can);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "connected" | "attention">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [webhookForm, setWebhookForm] = useState({ url: DEFAULT_GUPSHUP_WEBHOOK_URL, modes: GUPSHUP_MODES, strategy: "update" });
  const [bulkForm, setBulkForm] = useState({ url: DEFAULT_GUPSHUP_WEBHOOK_URL, modes: GUPSHUP_MODES, strategy: "update" });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => apiGet<{ items: Workspace[]; total: number }>("/api/admin/read/workspaces"),
  });
  const all = useMemo(() => data?.items ?? [], [data]);

  const filtered = all.filter((ws) => {
    const target = [ws.name, ws.owner?.name, ws.owner?.email, ws.gupshupAppId, ws.bspWabaId, ws.wabaId, ws._id]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!target.includes(search.toLowerCase())) return false;
    if (statusFilter === "connected" && !ws.whatsappConnected) return false;
    if (statusFilter === "attention" && !needsAttention(ws)) return false;
    return true;
  });

  const selected = filtered.find((w) => w._id === selectedId) || filtered[0] || null;
  const selectedGupshupAppId = selected?.gupshupAppId || selected?.gupshupIdentity?.partnerAppId || "";
  const selectedWorkspaceId = selected?._id || "";

  const { data: webhookStatus, isFetching: fetchingWebhook, refetch: refetchWebhook } = useQuery({
    queryKey: ["webhook-status", selected?._id],
    queryFn: () => apiGet<WebhookStatus>(`/api/admin/read/webhook-status?workspaceId=${selected!._id}`),
    enabled: !!selected?._id,
  });

  const action = useMutation({
    mutationFn: ({ id, act, body }: { id: string; act: string; body?: unknown }) =>
      apiPost(`/api/admin/ops/workspaces/${id}/${act}`, body),
    onSuccess: (_r, v) => {
      toast.success(`Workspace ${v.act}d`);
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const impersonate = useMutation({
    mutationFn: (id: string) => apiPost<{ targetUrl: string }>(`/api/admin/ops/impersonate/${id}`),
    onSuccess: (res) => {
      toast.success("Impersonation session created");
      if (res?.targetUrl) window.open(res.targetUrl, "_blank", "noopener");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncWebhook = useMutation<GupshupOpResult, Error>({
    mutationFn: () =>
      apiPost<GupshupOpResult>("/api/admin/ops/gupshup/sync-webhook", {
        appId: selectedGupshupAppId,
        workspaceId: selectedWorkspaceId,
        url: webhookForm.url,
        modes: webhookForm.modes,
        strategy: webhookForm.strategy,
      }),
    onSuccess: (res) => {
      if (res.data?.skipped) {
        toast.warning(res.data.message || "No live Gupshup app is linked to this workspace yet.");
        return;
      }
      toast.success("Webhook sync applied");
      refetchWebhook();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncAppSubscriptions = useMutation<GupshupOpResult, Error>({
    mutationFn: () =>
      apiPost<GupshupOpResult>("/api/admin/ops/gupshup/sync-app-subscriptions", {
        appId: selectedGupshupAppId,
        workspaceId: selectedWorkspaceId,
      }),
    onSuccess: (res) => {
      if (res.data?.skipped) {
        toast.warning(res.data.message || "No live Gupshup app is linked to this workspace yet.");
        return;
      }
      toast.success("Subscriptions synced from Gupshup");
      refetchWebhook();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncAll = useMutation({
    mutationFn: () => apiPost("/api/admin/ops/gupshup/sync-all-webhooks", bulkForm),
    onSuccess: () => {
      toast.success("Bulk webhook sync completed");
      setBulkOpen(false);
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteSub = useMutation({
    mutationFn: (subscriptionId: string) =>
      apiPost("/api/admin/ops/gupshup/delete-subscription", { appId: selectedGupshupAppId, subscriptionId }),
    onSuccess: () => {
      toast.success("Subscription deleted");
      refetchWebhook();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleDelete(ws: Workspace) {
    const confirmName = window.prompt(`Type "${ws.name}" to permanently delete this workspace and all related records.`);
    if (confirmName === null) return;
    if (confirmName.trim() !== ws.name) {
      toast.error("Workspace name did not match");
      return;
    }
    action.mutate({ id: ws._id, act: "delete" });
  }

  const cards = [
    { label: "Total Workspaces", value: all.length, icon: Building2, tone: "emerald" },
    { label: "Connected", value: all.filter((w) => w.whatsappConnected).length, icon: Globe, tone: "emerald" },
    { label: "Configured", value: all.filter((w) => w.gupshupAppId || w.gupshupIdentity?.partnerAppId).length, icon: Zap, tone: "amber" },
    { label: "Needs Attention", value: all.filter(needsAttention).length, icon: ShieldCheck, tone: "rose" },
  ] as const;

  const toneClass: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-600",
    amber: "bg-amber-500/10 text-amber-600",
    rose: "bg-rose-500/10 text-rose-600",
  };
  const syncedSubscriptions = webhookStatus?.subscriptions ?? [];
  const activeSubscriptionCount = syncedSubscriptions.filter((sub) => (sub.status || "active") === "active").length;

  return (
    <>
      <PageHeader
        title="Workspaces"
        description={`Monitor and manage ${all.length} workspaces, configurations, and connection health`}
        actions={
          <div className="flex items-center gap-2">
            {can("operations") && (
              <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
                <Zap className="h-4 w-4" /> Global Webhook Sync
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isLoading}>
              <Loader2 className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        }
      />
      <div className="p-6 space-y-6">
        {/* Summary cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((c) => {
            const Icon = c.icon;
            return (
              <Card key={c.label}>
                <CardContent className="flex items-center justify-between p-5">
                  <div>
                    <p className="text-sm text-muted-foreground">{c.label}</p>
                    {isLoading ? (
                      <Skeleton className="h-8 w-12 mt-1" />
                    ) : (
                      <p className="text-2xl font-semibold mt-1">{c.value}</p>
                    )}
                  </div>
                  <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${toneClass[c.tone]}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Controls */}
        <div className="flex flex-col md:flex-row gap-3 md:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, owner email, app id, WABA, or workspace ID…"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-1">
            {(["all", "connected", "attention"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={statusFilter === f ? "default" : "ghost"}
                onClick={() => setStatusFilter(f)}
              >
                {f === "all" && <Filter className="h-4 w-4" />}
                {f === "connected" && <ShieldCheck className="h-4 w-4" />}
                {f === "attention" && <Zap className="h-4 w-4" />}
                {f === "all" ? "All" : f === "connected" ? "Connected" : "Needs Attention"}
              </Button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Workspace</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Integration</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 5 }).map((__, j) => (
                      <td key={j} className="px-4 py-4"><Skeleton className="h-5 w-24" /></td>
                    ))}
                  </tr>
                ))
              ) : isError ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-destructive">Failed to load workspaces.</td></tr>
              ) : filtered.length ? (
                filtered.map((ws) => (
                  <tr
                    key={ws._id}
                    onClick={() => setSelectedId(ws._id)}
                    className={`cursor-pointer hover:bg-accent/40 ${selected?._id === ws._id ? "bg-accent/40" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center text-xs font-semibold uppercase">
                          {ws.name.slice(0, 2)}
                        </div>
                        <div>
                          <Link
                            href={`/workspaces/${ws._id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium hover:text-primary hover:underline"
                          >
                            {ws.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">{ws.owner?.email || "—"}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{ws.plan?.name || "Free Tier"}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${ws.whatsappConnected ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span className="text-xs">{ws.whatsappConnected ? "Active" : "Offline"}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {ws.createdAt ? new Date(ws.createdAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {can("workspaces") && (
                          <Button size="sm" variant="ghost" onClick={() => impersonate.mutate(ws._id)} disabled={impersonate.isPending}>
                            <UserCog className="h-4 w-4" /> Open Access
                          </Button>
                        )}
	                        <DropdownMenu>
	                          <DropdownMenuTrigger asChild>
	                            <Button size="sm" variant="ghost" aria-label={`Open actions for ${ws.name || ws._id}`}><MoreVertical className="h-4 w-4" /></Button>
	                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <Link href={`/workspaces/${ws._id}`}>
                              <DropdownMenuItem>
                                <Settings className="h-4 w-4" /> Workspace controls
                              </DropdownMenuItem>
                            </Link>
                            <Link href={`/users?workspace=${ws._id}`}>
                              <DropdownMenuItem><UsersIcon className="h-4 w-4" /> Team Directory</DropdownMenuItem>
                            </Link>
                            {can("workspaces") && (
                              <DropdownMenuItem
                                onClick={() =>
                                  action.mutate({
                                    id: ws._id,
                                    act: ws.billingStatus === "suspended" ? "activate" : "suspend",
                                  })
                                }
                              >
                                <ShieldCheck className="h-4 w-4" />
                                {ws.billingStatus === "suspended" ? "Activate" : "Suspend"}
                              </DropdownMenuItem>
                            )}
                            {can("system") && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => setTimeout(() => handleDelete(ws), 50)}
                                >
                                  <Trash2 className="h-4 w-4" /> Delete Workspace
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">No matching workspaces.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Detail + checklist */}
        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardContent className="p-5 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" /> Selected Workspace
                </h2>
                {selected && <StatusBadge status={selected.billingStatus} />}
              </div>
              {!selected ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  Select a workspace to inspect its owner, app, wallet and health.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Info label="Workspace" value={selected.name} sub={`ID: ${selected._id.slice(-12)}`} />
                    <Info label="Owner" value={selected.owner?.name || "Unassigned"} sub={selected.owner?.email} />
                    <Info
                      label="Plan & Billing"
                      value={selected.plan?.name || "Free Tier"}
                      sub={`Status: ${selected.billingStatus || "trialing"}`}
                    />
                    <Info
                      label="Sync & Onboarding"
                      value={selected.whatsappConnected ? "WhatsApp Connected" : "WhatsApp Offline"}
                      sub={`Onboarding: ${selected.esbFlow?.status || "not_started"}`}
                    />
                    <Info
                      label="WABA & App"
                      value={`App: ${selected.gupshupAppId || "Pending"}`}
                      sub={`WABA: ${selected.wabaId || selected.bspWabaId || "Pending"}`}
                    />
                    <Info
                      label="Health"
                      value={`Phone: ${selected.bspPhoneStatus || "PENDING"}`}
                      sub={`Last sync: ${selected.bspLastSyncedAt ? new Date(selected.bspLastSyncedAt).toLocaleString() : "Never"}`}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <Info label="Wallet" value={`${selected.walletCurrency || "INR"} ${selected.walletBalance ?? 0}`} />
                    <Info label="Parked" value={String(selected.walletParkedBalance ?? 0)} />
                    <Info label="Threshold" value={String(selected.walletThreshold ?? 0)} />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {can("workspaces") && (
                      <Link href={`/workspaces/${selected._id}`}>
                        <Button size="sm" variant="outline">
                          <Settings className="h-4 w-4" /> Manage plan & access
                        </Button>
                      </Link>
                    )}
                    {can("workspaces") && (
                      <Button size="sm" onClick={() => impersonate.mutate(selected._id)} disabled={impersonate.isPending}>
                        Bypass Access <ArrowRight className="h-4 w-4" />
                      </Button>
                    )}
                    <Link href="/gupshup"><Button size="sm" variant="outline">Open BSP Provider</Button></Link>
                  </div>

                  {/* Webhook infrastructure control */}
                  {can("operations") && (
                    <div className="border-t border-border pt-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium flex items-center gap-2">
                          <Webhook className="h-4 w-4 text-primary" /> Webhook Infrastructure
                        </h3>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => syncAppSubscriptions.mutate()}
                          disabled={!selectedWorkspaceId || fetchingWebhook || syncAppSubscriptions.isPending}
                          title={!selectedWorkspaceId ? "Select a workspace first" : "Sync subscriptions from Gupshup"}
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${syncAppSubscriptions.isPending || fetchingWebhook ? "animate-spin" : ""}`} /> Sync
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        {activeSubscriptionCount > 0 ? (
                          <><CheckCircle2 className="h-4 w-4 text-emerald-500" /> <span className="text-emerald-600">Active &amp; synced</span></>
                        ) : syncedSubscriptions.length ? (
                          <><AlertCircle className="h-4 w-4 text-amber-500" /> <span className="text-amber-600">Synced; no active subscription</span></>
                        ) : (
                          <><AlertCircle className="h-4 w-4 text-amber-500" /> <span className="text-amber-600">Sync required</span></>
                        )}
                      </div>

                      <div className="space-y-3 rounded-md border border-border p-3">
                        <div>
                          <Label className="text-xs">Target callback URL</Label>
                          <Input
                            value={webhookForm.url}
                            onChange={(e) => setWebhookForm({ ...webhookForm, url: e.target.value })}
                            placeholder="System default"
                            className="mt-1"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3 items-end">
                          <div>
                            <Label className="text-xs">Strategy</Label>
                            <Select value={webhookForm.strategy} onValueChange={(v) => setWebhookForm({ ...webhookForm, strategy: v })}>
                              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="update">Update existing</SelectItem>
                                <SelectItem value="add">Force add new</SelectItem>
                                <SelectItem value="replace">Clean replace</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <Button size="sm" onClick={() => syncWebhook.mutate()} disabled={!selectedWorkspaceId || syncWebhook.isPending}>
                            {syncWebhook.isPending ? "Syncing…" : "Apply Sync"}
                          </Button>
                        </div>
                        <div>
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Events</Label>
                            <button className="text-xs text-primary" onClick={() => setWebhookForm({ ...webhookForm, modes: GUPSHUP_MODES })}>All</button>
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {GUPSHUP_MODES.map((m) => {
                              const on = webhookForm.modes.includes(m);
                              return (
                                <button
                                  key={m}
                                  onClick={() =>
                                    setWebhookForm({
                                      ...webhookForm,
                                      modes: on ? webhookForm.modes.filter((x) => x !== m) : [...webhookForm.modes, m],
                                    })
                                  }
                                >
                                  <Badge variant={on ? "default" : "outline"} className="text-[10px] cursor-pointer">{m}</Badge>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      {!!syncedSubscriptions.length && (
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground">Synced subscriptions</p>
                          {syncedSubscriptions.map((sub) => (
                            <div key={sub.id} className="rounded-md border border-border p-2 flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-start gap-2">
                                  <p className="text-xs font-mono break-all">{sub.url}</p>
                                  <Badge variant={sub.status === "disabled" ? "outline" : "secondary"} className="shrink-0 text-[9px]">
                                    {sub.status || "active"}
                                  </Badge>
                                </div>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {(sub.modes || sub.events || []).map((m) => (
                                    <Badge key={m} variant="secondary" className="text-[9px]">{m}</Badge>
                                  ))}
                                </div>
                              </div>
	                              <Button size="sm" variant="ghost" onClick={() => deleteSub.mutate(sub.id)} disabled={deleteSub.isPending} aria-label={`Delete webhook subscription ${sub.url || sub.id}`}>
	                                <Trash2 className="h-3.5 w-3.5" />
	                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <UsersIcon className="h-4 w-4 text-primary" /> Operational Checklist
              </h2>
              {[
                `Owner identity: ${selected?.owner?.email || "unknown"}`,
                `WABA connection: ${selected?.whatsappConnected ? "connected" : "offline"}`,
                `Gupshup app: ${selected?.gupshupAppId || "pending"}`,
                `Phone status: ${selected?.bspPhoneStatus || "PENDING"}`,
                `Last sync: ${selected?.bspLastSyncedAt ? new Date(selected.bspLastSyncedAt).toLocaleString() : "never"}`,
              ].map((item) => (
                <div key={item} className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">{item}</div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Bulk webhook sync modal */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Zap className="h-5 w-5 text-amber-500" /> Bulk Webhook Sync</DialogTitle>
            <DialogDescription>Apply webhook configuration to all {all.length} workspaces.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
              Bulk sync triggers Gupshup partner-API calls for every workspace. Use “Update matching” unless a platform-wide URL migration is intended.
            </div>
            <div>
              <Label className="text-xs">Global callback URL (empty = system default)</Label>
              <Input value={bulkForm.url} onChange={(e) => setBulkForm({ ...bulkForm, url: e.target.value })} placeholder="https://…/api/webhooks/whatsapp" className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Strategy</Label>
              <Select value={bulkForm.strategy} onValueChange={(v) => setBulkForm({ ...bulkForm, strategy: v })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="update">Update matching (keep existing URLs)</SelectItem>
                  <SelectItem value="replace">Force replace (wipe and overwrite)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Event modes</Label>
                <button className="text-xs text-primary" onClick={() => setBulkForm({ ...bulkForm, modes: GUPSHUP_MODES })}>Select all</button>
              </div>
              <div className="flex flex-wrap gap-1 mt-1">
                {GUPSHUP_MODES.map((m) => {
                  const on = bulkForm.modes.includes(m);
                  return (
                    <button
                      key={m}
                      onClick={() =>
                        setBulkForm({ ...bulkForm, modes: on ? bulkForm.modes.filter((x) => x !== m) : [...bulkForm.modes, m] })
                      }
                    >
                      <Badge variant={on ? "default" : "outline"} className="text-[10px] cursor-pointer">{m}</Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={syncAll.isPending}>Cancel</Button>
            <Button onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
              {syncAll.isPending ? "Syncing…" : "Start Bulk Sync"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Info({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium mt-0.5 break-all">{value}</p>
      {sub ? <p className="text-xs text-muted-foreground break-all">{sub}</p> : null}
    </div>
  );
}
