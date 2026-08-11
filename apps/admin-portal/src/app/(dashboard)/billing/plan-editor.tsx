"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Package,
  DollarSign,
  Zap,
  Users,
  Layers,
  CheckCircle2,
  Shield,
  ChevronLeft,
  ChevronRight,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiPost } from "@/lib/api/client";

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface Plan {
  _id?: string;
  name?: string;
  slug?: string;
  currency?: string;
  monthlyBaseFeeCents?: number;
  yearlyBaseFeeCents?: number;
  maxActivePhones?: number;
  features?: string[];
  isActive?: boolean;
  isDefault?: boolean;
  limits?: Record<string, number>;
  conversationPricing?: Record<string, number>;
}

interface PlanForm {
  name: string;
  slug: string;
  currency: string;
  monthlyBaseFeeCents: number;
  yearlyBaseFeeCents: number;
  isActive: boolean;
  isDefault: boolean;
  limits: {
    maxContacts: number;
    maxMessagesPerMonth: number;
    maxAutomations: number;
    maxTemplates: number;
    maxCampaigns: number;
  };
  conversationPricing: {
    marketingMarkupPercent: number;
    utilityMarkupPercent: number;
    authenticationMarkupPercent: number;
    serviceMarkupPercent: number;
  };
  features: string[];
}

const STEPS = [
  { id: 1, title: "Identity", desc: "Classification & branding" },
  { id: 2, title: "Economics", desc: "Monthly & yearly pricing" },
  { id: 3, title: "Quotas", desc: "Usage & resource limits" },
  { id: 4, title: "Services", desc: "Feature entitlements" },
  { id: 5, title: "Review", desc: "Final review & launch" },
];

const FEATURE_SECTIONS = [
  {
    group: "Core Messaging",
    items: [
      { id: "INBOX", label: "Inbox", desc: "Unified multi-channel message hub" },
      { id: "BILLING", label: "Billing", desc: "Wallet, recharge and invoice management" },
      { id: "CAMPAIGNS", label: "Campaigns", desc: "Broadcast marketing and messaging flows" },
      { id: "CONTACTS", label: "Contacts", desc: "Centralized customer directory & metadata" },
      { id: "ADS", label: "Ads", desc: "Click-to-WhatsApp ad monitoring" },
      { id: "TEMPLATES_LIBRARY", label: "Templates & Library", desc: "Meta-approved shared template vault" },
    ],
  },
  {
    group: "Automation Hub",
    items: [
      { id: "FLOW_HUB", label: "Flow Hub", desc: "Visual builder for customer journeys" },
      { id: "WORKFLOWS", label: "Workflows", desc: "Advanced logic and trigger sequences" },
      { id: "AUTO_REPLIES", label: "Auto Replies", desc: "Keyword and intent based response" },
      { id: "WA_FORMS", label: "WhatsApp Forms", desc: "Structured data collection in chat" },
      { id: "ANSWERBOT", label: "AnswerBot Training", desc: "AI agent knowledge base & training" },
      { id: "AI_INTENT", label: "AI Intent Match", desc: "Natural language intent classification" },
      { id: "INTERAKTIVE_LIST", label: "Interaktive List", desc: "Interactive message menu controls" },
    ],
  },
  {
    group: "CRM & Analysis",
    items: [
      { id: "PIPELINE", label: "Pipeline", desc: "Visual sales funnel and stage tracking" },
      { id: "TASKS", label: "Tasks", desc: "Agent follow-ups and CRM to-do list" },
      { id: "REPORTS", label: "Reports", desc: "CRM performance and conversion data" },
      { id: "ANALYTICS", label: "Chat Analytics", desc: "In-depth message & response auditing" },
      { id: "CHAT_ASSIGNMENT", label: "Chat Assignment", desc: "Automated agent routing protocols" },
      { id: "TEAM_MGMT", label: "Team Management", desc: "RBAC and agent performance monitoring" },
    ],
  },
  {
    group: "Commerce & Tools",
    items: [
      { id: "CATALOG", label: "Catalog", desc: "Meta product catalog integration" },
      { id: "ORDERS", label: "Order Panel", desc: "Order tracking and transaction hub" },
      { id: "CHECKOUT_BOT", label: "Checkout Bot", desc: "Self-serve checkout flow logic" },
      { id: "COMMERCE_SETTINGS", label: "Commerce Settings", desc: "Storefront and payment configuration" },
      { id: "INTEGRATIONS", label: "Integrations", desc: "External app and API connectivity" },
      { id: "WIDGET_CONFIG", label: "Widget", desc: "On-site chat widget customization" },
      { id: "MACROS", label: "Macros", desc: "Templated quick-responses for agents" },
    ],
  },
];

const MARKUP_KEYS = [
  ["marketing", "marketingMarkupPercent"],
  ["utility", "utilityMarkupPercent"],
  ["authentication", "authenticationMarkupPercent"],
  ["service", "serviceMarkupPercent"],
] as const;

function planToForm(plan: Plan | null): PlanForm {
  return {
    name: plan?.name ?? "",
    slug: plan?.slug ?? "",
    currency: plan?.currency ?? "INR",
    monthlyBaseFeeCents: plan?.monthlyBaseFeeCents ?? 0,
    yearlyBaseFeeCents: plan?.yearlyBaseFeeCents ?? 0,
    isActive: plan?.isActive ?? true,
    isDefault: plan?.isDefault ?? false,
    limits: {
      maxContacts: plan?.limits?.maxContacts ?? 1000,
      maxMessagesPerMonth: plan?.limits?.maxMessagesPerMonth ?? 5000,
      maxAutomations: plan?.limits?.maxAutomations ?? 2,
      maxTemplates: plan?.limits?.maxTemplates ?? 10,
      maxCampaigns: plan?.limits?.maxCampaigns ?? 50,
    },
    conversationPricing: {
      marketingMarkupPercent: plan?.conversationPricing?.marketingMarkupPercent ?? 0,
      utilityMarkupPercent: plan?.conversationPricing?.utilityMarkupPercent ?? 0,
      authenticationMarkupPercent: plan?.conversationPricing?.authenticationMarkupPercent ?? 0,
      serviceMarkupPercent: plan?.conversationPricing?.serviceMarkupPercent ?? 0,
    },
    features: plan?.features ?? [],
  };
}

/* ── Dialog ─────────────────────────────────────────────────────────────── */

export function PlanEditorDialog({
  open,
  onOpenChange,
  plan,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  plan: Plan | null;
  onSaved: () => void;
}) {
  const isEditing = !!plan?._id;
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<PlanForm>(planToForm(plan));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(planToForm(plan));
      setStep(1);
    }
  }, [open, plan]);

  function patch(p: Partial<PlanForm>) {
    setForm((f) => ({ ...f, ...p }));
  }
  function patchLimit(key: keyof PlanForm["limits"], value: number) {
    setForm((f) => ({ ...f, limits: { ...f.limits, [key]: value } }));
  }
  function patchMarkup(key: keyof PlanForm["conversationPricing"], value: number) {
    setForm((f) => ({ ...f, conversationPricing: { ...f.conversationPricing, [key]: value } }));
  }
  function toggleFeature(id: string, on: boolean) {
    setForm((f) => ({
      ...f,
      features: on ? [...new Set([...f.features, id])] : f.features.filter((x) => x !== id),
    }));
  }

  function next() {
    if (step === 1 && (!form.name.trim() || !form.slug.trim())) {
      toast.error("Name and slug are required");
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length));
  }
  function back() {
    setStep((s) => Math.max(s - 1, 1));
  }

  async function save() {
    if (!form.name.trim() || !form.slug.trim()) {
      toast.error("Name and slug are required");
      setStep(1);
      return;
    }
    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      currency: form.currency.trim() || "INR",
      monthlyBaseFeeCents: Math.round(form.monthlyBaseFeeCents) || 0,
      yearlyBaseFeeCents: Math.round(form.yearlyBaseFeeCents) || 0,
      isActive: form.isActive,
      isDefault: form.isDefault,
      limits: form.limits,
      conversationPricing: form.conversationPricing,
      features: form.features,
    };

    setSaving(true);
    try {
      if (isEditing) {
        await apiPost("/api/admin/ops/billing/update-plan", { planId: plan!._id, ...payload });
        toast.success("Plan updated");
      } else {
        await apiPost("/api/admin/ops/billing/create-plan", payload);
        toast.success("Plan created");
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save plan");
    } finally {
      setSaving(false);
    }
  }

  const current = STEPS[step - 1];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl h-[85dvh] max-h-[720px] p-0 overflow-hidden gap-0">
        <div className="flex h-full min-h-0">
          {/* Wizard rail */}
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-muted/30 p-5 flex flex-col gap-6">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
                <Package className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">Plan Engine</p>
                <p className="text-xs text-muted-foreground">{isEditing ? "Edit tier" : "New tier"}</p>
              </div>
            </div>
            <nav className="space-y-1">
              {STEPS.map((s) => {
                const active = s.id === step;
                const done = s.id < step;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => s.id < step && setStep(s.id)}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                      active ? "bg-primary/10" : done ? "hover:bg-accent" : "opacity-60 cursor-default"
                    )}
                  >
                    <span
                      className={cn(
                        "h-6 w-6 shrink-0 rounded-full border flex items-center justify-center text-xs font-medium",
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : done
                            ? "border-primary text-primary"
                            : "border-muted-foreground/30 text-muted-foreground"
                      )}
                    >
                      {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : s.id}
                    </span>
                    <span>
                      <span className={cn("block text-sm", active && "font-medium text-primary")}>
                        {s.title}
                      </span>
                      <span className="block text-[11px] text-muted-foreground leading-tight">{s.desc}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
            <div className="mt-auto rounded-md border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground mb-1">Status</p>
              <div className="flex items-center gap-2">
                <span
                  className={cn("h-2 w-2 rounded-full", form.isActive ? "bg-emerald-500" : "bg-destructive")}
                />
                <span className="text-xs font-medium">{form.isActive ? "Active" : "Inactive"}</span>
              </div>
            </div>
          </aside>

          {/* Content */}
          <div className="flex-1 flex min-h-0 flex-col min-w-0">
            <DialogHeader className="shrink-0 px-6 py-4 border-b border-border space-y-0.5 text-left">
              <div className="flex items-center justify-between">
                <DialogTitle>{current.title}</DialogTitle>
                <Badge variant="outline">
                  Step {step} / {STEPS.length}
                </Badge>
              </div>
              <DialogDescription>{current.desc}</DialogDescription>
            </DialogHeader>

            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
              data-testid="plan-editor-content"
              tabIndex={0}
            >
              <div className="p-6">
                {step === 1 && <StepIdentity form={form} patch={patch} />}
                {step === 2 && (
                  <StepEconomics form={form} patch={patch} patchMarkup={patchMarkup} />
                )}
                {step === 3 && <StepQuotas form={form} patchLimit={patchLimit} />}
                {step === 4 && <StepServices form={form} toggleFeature={toggleFeature} />}
                {step === 5 && <StepReview form={form} />}
              </div>
            </div>

            <div className="shrink-0 px-6 py-4 border-t border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                {step > 1 && (
                  <Button type="button" variant="outline" size="sm" onClick={back} disabled={saving}>
                    <ChevronLeft className="h-4 w-4" /> Back
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </div>
              {step < STEPS.length ? (
                <Button type="button" size="sm" onClick={next}>
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={save} disabled={saving}>
                  {saving ? "Saving…" : isEditing ? "Save changes" : "Create plan"}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Steps ──────────────────────────────────────────────────────────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function StepIdentity({ form, patch }: { form: PlanForm; patch: (p: Partial<PlanForm>) => void }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Plan name">
          <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Enterprise Growth" />
        </Field>
        <Field label="Slug (unique)">
          <Input value={form.slug} onChange={(e) => patch({ slug: e.target.value })} placeholder="growth-v2" />
        </Field>
      </div>
      <Field label="Currency">
        <Input value={form.currency} onChange={(e) => patch({ currency: e.target.value })} className="w-32" />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <ToggleCard
          title="Visibility"
          desc="Is this plan visible to users?"
          checked={form.isActive}
          onChange={(v) => patch({ isActive: v })}
        />
        <ToggleCard
          title="Default assignment"
          desc="Assign to all new signups?"
          checked={form.isDefault}
          onChange={(v) => patch({ isDefault: v })}
        />
      </div>
    </div>
  );
}

function StepEconomics({
  form,
  patch,
  patchMarkup,
}: {
  form: PlanForm;
  patch: (p: Partial<PlanForm>) => void;
  patchMarkup: (k: keyof PlanForm["conversationPricing"], v: number) => void;
}) {
  const savePct =
    form.monthlyBaseFeeCents > 0
      ? Math.max(0, Math.round((1 - form.yearlyBaseFeeCents / (form.monthlyBaseFeeCents * 12)) * 100))
      : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <DollarSign className="h-4 w-4 text-primary" /> Monthly billing
          </div>
          <Field label="Fee (₹)">
            <Input
              type="number"
              value={form.monthlyBaseFeeCents / 100}
              onChange={(e) => patch({ monthlyBaseFeeCents: Math.round((parseFloat(e.target.value) || 0) * 100) })}
            />
          </Field>
        </div>
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Zap className="h-4 w-4 text-amber-500" /> Yearly billing
          </div>
          <Field label="Fee (₹)">
            <Input
              type="number"
              value={form.yearlyBaseFeeCents / 100}
              onChange={(e) => patch({ yearlyBaseFeeCents: Math.round((parseFloat(e.target.value) || 0) * 100) })}
            />
          </Field>
          {form.yearlyBaseFeeCents > 0 && (
            <p className="text-xs text-emerald-600">Save ~{savePct}% with yearly</p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-3">
        <p className="text-sm font-medium">Conversation markups (%)</p>
        <div className="grid grid-cols-4 gap-3">
          {MARKUP_KEYS.map(([label, key]) => (
            <Field key={key} label={label[0].toUpperCase() + label.slice(1)}>
              <Input
                type="number"
                value={form.conversationPricing[key]}
                onChange={(e) => patchMarkup(key, parseFloat(e.target.value) || 0)}
              />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepQuotas({
  form,
  patchLimit,
}: {
  form: PlanForm;
  patchLimit: (k: keyof PlanForm["limits"], v: number) => void;
}) {
  const big = [
    { key: "maxContacts", label: "Max contact capacity", icon: Users },
    { key: "maxMessagesPerMonth", label: "Monthly message volume", icon: Layers },
  ] as const;
  const small = [
    { key: "maxAutomations", label: "Automations", icon: Zap },
    { key: "maxTemplates", label: "Meta templates", icon: CheckCircle2 },
    { key: "maxCampaigns", label: "Bulk campaigns", icon: Shield },
  ] as const;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        {big.map(({ key, label, icon: Icon }) => (
          <div key={key} className="rounded-lg border border-border p-4 space-y-2">
            <Label className="text-xs flex items-center gap-2">
              <Icon className="h-4 w-4 text-primary" /> {label}
            </Label>
            <Input
              type="number"
              value={form.limits[key]}
              onChange={(e) => patchLimit(key, parseInt(e.target.value) || 0)}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {small.map(({ key, label, icon: Icon }) => (
          <div key={key} className="rounded-lg border border-border p-4 space-y-2">
            <Label className="text-xs flex items-center gap-2">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" /> {label}
            </Label>
            <Input
              type="number"
              value={form.limits[key]}
              onChange={(e) => patchLimit(key, parseInt(e.target.value) || 0)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepServices({
  form,
  toggleFeature,
}: {
  form: PlanForm;
  toggleFeature: (id: string, on: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      {FEATURE_SECTIONS.map((section) => (
        <div key={section.group} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground border-l-2 border-primary pl-2">
            {section.group}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {section.items.map((feature) => {
              const checked = form.features.includes(feature.id);
              return (
                <label
                  key={feature.id}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                    checked ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                    checked={checked}
                    onChange={(e) => toggleFeature(feature.id, e.target.checked)}
                  />
                  <span>
                    <span className="block text-sm font-medium">{feature.label}</span>
                    <span className="block text-xs text-muted-foreground leading-tight">{feature.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function StepReview({ form }: { form: PlanForm }) {
  const inr = (cents: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(
      cents / 100
    );
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border p-5 text-center space-y-2">
        <Package className="h-8 w-8 mx-auto text-primary" />
        <h3 className="text-xl font-semibold">{form.name || "Untitled plan"}</h3>
        <Badge variant="secondary">{form.slug || "no-slug"}</Badge>
        <div className="grid grid-cols-2 gap-3 pt-3">
          <div className="rounded-md bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">Monthly</p>
            <p className="text-lg font-semibold">{inr(form.monthlyBaseFeeCents)}</p>
          </div>
          <div className="rounded-md bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">Yearly</p>
            <p className="text-lg font-semibold">{inr(form.yearlyBaseFeeCents)}</p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Summary label="Contacts" value={form.limits.maxContacts.toLocaleString()} />
        <Summary label="Messages/mo" value={form.limits.maxMessagesPerMonth.toLocaleString()} />
        <Summary label="Features" value={String(form.features.length)} />
      </div>
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
        <Info className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          Saving makes this tier available in the platform plan registry, which may affect subscriber
          discovery and entitlement evaluation.
        </p>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-4 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}

function ToggleCard({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4 flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
