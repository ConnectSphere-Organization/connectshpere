"use client";

import { useForm } from "@tanstack/react-form";
import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { offerInputSchema, type OfferInput } from "@/modules/documents/schema";

const defaults: OfferInput = {
  candidateName: "",
  email: "",
  position: "",
  department: "",
  salary: "",
  offerType: "JOB",
  payoutFrequency: "monthly",
  startDate: "",
  endDate: "",
  duration: "",
  joiningLocation: "",
  workType: "ON_SITE",
  benefits: "",
  reportingManager: "",
  companyName: "ConnectSphere",
  hrContactName: "",
  hrContactEmail: "",
  hrContactPhone: "",
  issuedBy: "ConnectSphere",
  validUntil: "",
  additionalNotes: "",
  applicationId: "",
};
const areaClass =
  "min-h-28 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-600/10";

export function OfferForm({
  applicationId = "",
  initialValues = {},
}: {
  applicationId?: string;
  initialValues?: Partial<OfferInput>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [acceptanceUrl, setAcceptanceUrl] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { ...defaults, ...initialValues, applicationId },
    onSubmit: async ({ value, formApi }) => {
      setError(null);
      setAcceptanceUrl(null);
      const parsed = offerInputSchema.safeParse(value);
      if (!parsed.success)
        return setError(
          parsed.error.issues[0]?.message ?? "Review the offer details",
        );
      const response = await fetch("/api/recruitment/offers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const result: unknown = await response.json().catch(() => null);
      const message =
        typeof result === "object" &&
        result !== null &&
        "message" in result &&
        typeof result.message === "string"
          ? result.message
          : null;
      if (!response.ok) return setError(message ?? "Unable to issue offer");
      if (
        typeof result === "object" &&
        result !== null &&
        "acceptanceToken" in result &&
        typeof result.acceptanceToken === "string"
      )
        setAcceptanceUrl(
          `${location.origin}/offer/respond/${result.acceptanceToken}`,
        );
      formApi.reset();
      router.refresh();
    },
  });
  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {error ? (
        <p
          className="rounded-xl bg-rose-50 p-3 font-semibold text-rose-700 md:col-span-2"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {acceptanceUrl ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 md:col-span-2">
          <p className="font-bold text-amber-900">
            Copy this one-time response link now
          </p>
          <p className="mt-1 text-sm break-all text-amber-800">
            {acceptanceUrl}
          </p>
          <p className="mt-1 text-xs text-amber-700">
            Only its SHA-256 digest is stored. The raw token will not be shown
            again.
          </p>
        </div>
      ) : null}
      <form.Field name="candidateName">
        {(field) => <Field label="Candidate name" field={field} />}
      </form.Field>
      <form.Field name="email">
        {(field) => (
          <Field label="Candidate email" field={field} type="email" />
        )}
      </form.Field>
      <form.Field name="position">
        {(field) => <Field label="Position" field={field} />}
      </form.Field>
      <form.Field name="department">
        {(field) => <Field label="Department" field={field} />}
      </form.Field>
      <form.Field name="salary">
        {(field) => <Field label="Compensation" field={field} />}
      </form.Field>
      <form.Field name="payoutFrequency">
        {(field) => <Field label="Payout frequency" field={field} />}
      </form.Field>
      <form.Field name="startDate">
        {(field) => <Field label="Start date" field={field} type="date" />}
      </form.Field>
      <form.Field name="validUntil">
        {(field) => <Field label="Valid until" field={field} type="date" />}
      </form.Field>
      <form.Field name="joiningLocation">
        {(field) => <Field label="Joining location" field={field} />}
      </form.Field>
      <form.Field name="reportingManager">
        {(field) => <Field label="Reporting manager" field={field} />}
      </form.Field>
      <form.Field name="offerType">
        {(field) => (
          <Select
            label="Offer type"
            value={field.state.value}
            onChange={(value) =>
              field.handleChange(value as OfferInput["offerType"])
            }
            options={["JOB", "INTERNSHIP"]}
          />
        )}
      </form.Field>
      <form.Field name="workType">
        {(field) => (
          <Select
            label="Work type"
            value={field.state.value}
            onChange={(value) =>
              field.handleChange(value as OfferInput["workType"])
            }
            options={["ON_SITE", "REMOTE", "HYBRID"]}
          />
        )}
      </form.Field>
      <form.Field name="applicationId">
        {(field) => (
          <Field label="Application ID or slug (optional)" field={field} />
        )}
      </form.Field>
      <form.Field name="companyName">
        {(field) => <Field label="Company" field={field} />}
      </form.Field>
      <form.Field name="issuedBy">
        {(field) => <Field label="Issued by" field={field} />}
      </form.Field>
      <form.Field name="hrContactEmail">
        {(field) => (
          <Field label="HR contact email" field={field} type="email" />
        )}
      </form.Field>
      <form.Field name="benefits">
        {(field) => <Area label="Benefits (one per line)" field={field} />}
      </form.Field>
      <form.Field name="additionalNotes">
        {(field) => <Area label="Additional notes" field={field} />}
      </form.Field>
      <div className="flex justify-end md:col-span-2">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(pending) => (
            <Button disabled={pending}>
              {pending ? <LoaderCircle className="animate-spin" /> : null}Issue
              offer
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

type FieldValue = {
  name: string;
  state: { value: string };
  handleBlur: () => void;
  handleChange: (value: string) => void;
};
function Field({
  label,
  field,
  type = "text",
}: {
  label: string;
  field: FieldValue;
  type?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={field.name}>{label}</Label>
      <Input
        id={field.name}
        type={type}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
      />
    </div>
  );
}
function Area({ label, field }: { label: string; field: FieldValue }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={field.name}>{label}</Label>
      <textarea
        id={field.name}
        className={areaClass}
        value={field.state.value}
        onChange={(event) => field.handleChange(event.target.value)}
      />
    </div>
  );
}
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <select
        className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replace("_", " ")}
          </option>
        ))}
      </select>
    </div>
  );
}
