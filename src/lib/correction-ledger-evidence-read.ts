import type { SupabaseClient } from "@supabase/supabase-js";
import {
  verifyCorrectionLedgerEvidence,
  type CorrectionLedgerEvidenceStatus,
  type CorrectionLedgerEvidenceRow,
} from "@/src/domain/correction-ledger-evidence";
import { retrySupabaseQueriesAfterSessionRefresh } from "@/src/lib/supabase-session";

export type CorrectionLedgerEvidenceReadResult =
  | { status: CorrectionLedgerEvidenceStatus }
  | { status: "unavailable" };

export type CorrectionInventoryEvidenceLookup =
  | { type: "idempotency-key"; value: string }
  | { type: "correction-id"; value: string };

/** Read back the exact posting from base tables, without relying on optional reporting views or exposing errors. */
export async function readCorrectionInventoryEvidence(
  client: SupabaseClient,
  kind: "WAREHOUSE_TRANSFER" | "STOCKTAKE",
  lookup: CorrectionInventoryEvidenceLookup,
): Promise<CorrectionLedgerEvidenceReadResult> {
  try {
    let postingId: string | null = null;
    if (lookup.type === "correction-id") {
      const [sourceResult] = await retrySupabaseQueriesAfterSessionRefresh(client, async () => [
        await client.from("correction_posting_sources")
          .select("posting_id")
          .eq("correction_note_id", lookup.value)
          .maybeSingle(),
      ] as const);
      if (sourceResult.error) return { status: "unavailable" };
      postingId = typeof sourceResult.data?.posting_id === "string" ? sourceResult.data.posting_id : null;
      if (!postingId) return { status: "missing" };
    }

    const [postingResult, ledgerResult] = await retrySupabaseQueriesAfterSessionRefresh(client, async () => {
      const posting = lookup.type === "idempotency-key"
        ? await client.from("inventory_postings").select("id,posting_kind").eq("idempotency_key", lookup.value).maybeSingle()
        : await client.from("inventory_postings").select("id,posting_kind").eq("id", postingId).maybeSingle();
      if (posting.error || !posting.data) {
        return [posting, { data: [], error: posting.error }] as const;
      }
      const ledger = await client.from("inventory_ledger_entries")
        .select("id,posting_id,item_id,warehouse_id,movement_kind,quantity_delta")
        .eq("posting_id", posting.data.id);
      return [posting, ledger] as const;
    });
    if (postingResult.error || ledgerResult.error) return { status: "unavailable" };
    const posting = postingResult.data;
    if (!posting) return { status: "missing" };
    const postingKind = posting.posting_kind;
    if (postingKind !== "CORRECTION") return { status: "mismatch" };
    return {
      status: verifyCorrectionLedgerEvidence(kind, (ledgerResult.data ?? []).map((row) => ({
        ...row,
        posting_kind: postingKind,
        ledger_entry_id: row.id,
      })) as CorrectionLedgerEvidenceRow[]),
    };
  } catch {
    return { status: "unavailable" };
  }
}
