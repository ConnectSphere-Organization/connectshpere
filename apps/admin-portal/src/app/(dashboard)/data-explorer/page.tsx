"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Eye, Pencil, Table2, Braces } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api/client";
import { useAdminAuth } from "@/store/admin-auth-store";
import { DataInspectionModal, type InspectionState } from "./data-inspection-modal";

const DATABASES = [
  { id: "core", label: "Core" },
  { id: "billing", label: "Billing" },
  { id: "campaign", label: "Campaign" },
  { id: "automation", label: "Automation" },
  { id: "bsp", label: "BSP / Service Provider" },
] as const;
type DatabaseId = (typeof DATABASES)[number]["id"];

interface CollectionsResp {
  data?: string[];
}
interface DocsResp {
  data?: Record<string, unknown>[];
  pagination?: { total: number; limit: number; skip: number };
}

function cellValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return Array.isArray(v) ? `[${v.length}]` : "{…}";
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

export default function DataExplorerPage() {
  const can = useAdminAuth((s) => s.can);
  const editable = can("system");
  const [database, setDatabase] = useState<DatabaseId>("core");
  const [collection, setCollection] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("{}");
  const [appliedFilter, setAppliedFilter] = useState("{}");
  const [view, setView] = useState<"table" | "json">("table");
  const [inspection, setInspection] = useState<InspectionState>({ isOpen: false, document: null, mode: "view" });

  const collections = useQuery({
    queryKey: ["collections", database],
    queryFn: () => apiGet<CollectionsResp>(`/api/admin/read/data/collections?database=${database}`),
  });

  const docs = useQuery({
    queryKey: ["docs", database, collection, appliedFilter],
    enabled: !!collection,
    queryFn: () =>
      apiGet<DocsResp>(
        `/api/admin/read/data/documents?database=${database}&collection=${encodeURIComponent(collection)}&filter=${encodeURIComponent(appliedFilter)}`
      ),
  });

  const collectionList = (collections.data?.data ?? []).filter((c) =>
    c.toLowerCase().includes(search.toLowerCase())
  );
  const rows = docs.data?.data ?? [];
  // Up to 5 representative columns (besides _id) from the first document.
  const columns = rows.length ? Object.keys(rows[0]).filter((k) => k !== "_id").slice(0, 5) : [];

  return (
    <>
      <PageHeader title="Data Explorer" description="Inspect and edit raw MongoDB collections across platform databases" />
      <div className="p-6">
        {!can("system") ? (
          <p className="text-sm text-destructive">Data Explorer requires the SUPER_ADMIN role.</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
            {/* Collections sidebar */}
            <Card className="h-fit">
              <CardContent className="p-3 space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="database">Database</label>
                <select
                  id="database"
                  value={database}
                  onChange={(event) => {
                    setDatabase(event.target.value as DatabaseId);
                    setCollection("");
                    setFilter("{}");
                    setAppliedFilter("{}");
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {DATABASES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search collections…" className="h-9" />
                <Badge variant="outline">{collectionList.length} collections</Badge>
                <div className="max-h-[60vh] overflow-y-auto space-y-0.5">
                  {collections.isLoading ? (
                    Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)
                  ) : (
                    collectionList.map((c) => (
                      <button
                        key={c}
                        onClick={() => { setCollection(c); setFilter("{}"); setAppliedFilter("{}"); }}
                        className={`w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${
                          collection === c ? "bg-primary/10 text-primary font-medium" : "hover:bg-accent"
                        }`}
                      >
                        {c}
                      </button>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Main view */}
            <div className="space-y-4">
              {!collection ? (
                <div className="flex flex-col items-center justify-center text-muted-foreground py-24">
                  <Database className="h-8 w-8 mb-2" />
                  <p className="text-sm">Select a collection to browse documents.</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="relative flex-1 min-w-64">
                      <Input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder='Mongo filter: {"status":"active"}'
                        className="font-mono text-xs"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        try { JSON.parse(filter); setAppliedFilter(filter); }
                        catch { toast.error("Invalid filter JSON"); }
                      }}
                    >
                      Apply filter
                    </Button>
                    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                      <Button size="sm" variant={view === "table" ? "default" : "ghost"} onClick={() => setView("table")}>
                        <Table2 className="h-4 w-4" /> Table
                      </Button>
                      <Button size="sm" variant={view === "json" ? "default" : "ghost"} onClick={() => setView("json")}>
                        <Braces className="h-4 w-4" /> JSON
                      </Button>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {docs.data?.pagination?.total ?? rows.length} documents (showing {rows.length})
                  </p>

                  {docs.isLoading ? (
                    <Skeleton className="h-64 w-full" />
                  ) : docs.isError ? (
                    <p className="text-sm text-destructive">Failed to fetch documents.</p>
                  ) : view === "table" ? (
                    <div className="rounded-lg border border-border overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>_id</TableHead>
                            {columns.map((c) => <TableHead key={c}>{c}</TableHead>)}
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((doc) => (
                            <TableRow key={String(doc._id)}>
                              <TableCell className="font-mono text-xs">{String(doc._id).slice(-10)}</TableCell>
                              {columns.map((c) => <TableCell key={c} className="text-xs">{cellValue(doc[c])}</TableCell>)}
                              <TableCell className="text-right space-x-1">
                                <Button size="sm" variant="ghost" onClick={() => setInspection({ isOpen: true, document: doc, mode: "view" })}>
                                  <Eye className="h-4 w-4" />
                                </Button>
                                {editable && (
                                  <Button size="sm" variant="ghost" onClick={() => setInspection({ isOpen: true, document: doc, mode: "edit" })}>
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                          {!rows.length && (
                            <TableRow><TableCell colSpan={columns.length + 2} className="text-center text-muted-foreground py-8">No documents.</TableCell></TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <pre className="text-xs rounded-md bg-muted/40 p-3 overflow-x-auto max-h-[60vh]">
                      {JSON.stringify(rows, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <DataInspectionModal
        state={inspection}
        database={database}
        collection={collection}
        onClose={() => setInspection({ isOpen: false, document: null, mode: "view" })}
        onSaved={() => docs.refetch()}
      />
    </>
  );
}
