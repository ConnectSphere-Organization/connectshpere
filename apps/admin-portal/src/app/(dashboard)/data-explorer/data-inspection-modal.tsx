"use client";

import { useEffect, useState } from "react";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client";

export interface InspectionState {
  isOpen: boolean;
  document: Record<string, unknown> | null;
  mode: "view" | "edit";
}

/**
 * Document inspector — view (read-only pretty JSON) or edit (editable JSON of
 * fields to $set). Mirrors the reference DataInspectionModal. _id is immutable.
 */
export function DataInspectionModal({
  state,
  database,
  collection,
  onClose,
  onSaved,
}: {
  state: InspectionState;
  database: string;
  collection: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [json, setJson] = useState("");
  const [copied, setCopied] = useState(false);
  const [parseError, setParseError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state.isOpen && state.document) {
      setJson(JSON.stringify(state.document, null, 2));
      setParseError(false);
    }
  }, [state.isOpen, state.document]);

  const id = state.document ? String(state.document._id) : "";

  function copy() {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function save() {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json);
    } catch {
      setParseError(true);
      toast.error("Invalid JSON");
      return;
    }
    if (String(parsed._id) !== id) {
      toast.error("The _id field cannot be changed");
      return;
    }
    const update = { ...parsed };
    delete update._id;
    setSaving(true);
    try {
      await apiFetch("/api/admin/ops/data/document", { method: "PATCH", body: { database, collection, id, update } });
      toast.success("Document updated");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update document");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={state.isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <DialogTitle className="flex items-center gap-2">
                {state.mode === "edit" ? "Edit document" : "Inspect document"}
                <Badge variant="outline">{database}.{collection}</Badge>
              </DialogTitle>
              <DialogDescription className="font-mono text-xs">{id}</DialogDescription>
            </div>
            <Button size="sm" variant="ghost" onClick={copy}>
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </DialogHeader>

        {state.mode === "edit" && (
          <div className="flex items-center gap-2 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" /> Write access active — changes are persisted via $set.
          </div>
        )}

        <ScrollArea className="max-h-[55vh]">
          {state.mode === "edit" ? (
            <Textarea
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                setParseError(false);
              }}
              className={`font-mono text-xs min-h-[40vh] ${parseError ? "border-destructive" : ""}`}
            />
          ) : (
            <pre className="text-xs rounded-md bg-muted/40 p-3 overflow-x-auto">{json}</pre>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {state.mode === "edit" ? "Cancel" : "Close"}
          </Button>
          {state.mode === "edit" && (
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Commit changes"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
