import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseQueriesAfterSessionRefresh } from "./supabase-session";

export async function loadHrRequestHistoryFallback(client: SupabaseClient) {
  const [result] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    () => Promise.all([
      client.from("hr_requests")
        .select("id,request_no,status,distribution_date,row_version,created_at,submitted_at,shipped_at,cancelled_at,note")
        .order("created_at", { ascending: false })
        .limit(500),
    ]),
  );
  if (result.error || !result.data) {
    return { data: null, error: result.error };
  }

  const requests = (result.data ?? []) as Array<Record<string, unknown>>;
  const requestIds = requests.flatMap((row) => typeof row.id === "string" ? [row.id] : []);

  const shipmentsByRequestId = new Map<string, { shipment_no: string | null; status: "DRAFT" | "POSTED" | null }>();
  if (requestIds.length > 0) {
    const [shipmentResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      () => Promise.all([
        client.from("warehouse_shipments")
          .select("hr_request_id,shipment_no,status")
          .in("hr_request_id", requestIds),
      ]),
    );
    if (!shipmentResult.error && shipmentResult.data) {
      for (const s of shipmentResult.data as Array<Record<string, unknown>>) {
        if (typeof s.hr_request_id === "string") {
          shipmentsByRequestId.set(s.hr_request_id, {
            shipment_no: typeof s.shipment_no === "string" ? s.shipment_no : null,
            status: s.status === "POSTED" ? "POSTED" : s.status === "DRAFT" ? "DRAFT" : null,
          });
        }
      }
    }
  }

  const mapped = requests.map((row) => {
    const shipment = shipmentsByRequestId.get(String(row.id));
    return {
      id: String(row.id ?? ""),
      request_no: String(row.request_no ?? ""),
      status: row.status as "DRAFT" | "SUBMITTED" | "INVENTORY_REVIEW_REQUIRED" | "SHIPPED" | "CANCELLED",
      distribution_date: String(row.distribution_date ?? ""),
      row_version: Number(row.row_version) || 1,
      created_at: String(row.created_at ?? ""),
      submitted_at: (row.submitted_at as string) || null,
      shipped_at: (row.shipped_at as string) || null,
      cancelled_at: (row.cancelled_at as string) || null,
      note: (row.note as string) || null,
      shipment_no: shipment?.shipment_no ?? null,
      shipment_status: shipment?.status ?? (row.status === "SHIPPED" ? "POSTED" : null),
      active_reserved_quantity: 0,
    };
  });

  return { data: mapped, error: null };
}

export async function loadHrRequestHistoryDetailFallback(client: SupabaseClient, requestId: string) {
  const [itemsResult, linesResult, resResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    () => Promise.all([
      client.from("hr_request_items").select("*").eq("request_id", requestId),
      client.from("hr_issue_lines").select("*").eq("request_id", requestId).order("line_no"),
      client.from("inventory_reservations").select("*").eq("source_hr_request_id", requestId),
    ]),
  );

  if (itemsResult.error && linesResult.error) {
    return { data: null, error: itemsResult.error || linesResult.error };
  }

  const items = ((itemsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    request_id: requestId,
    detail_kind: "ITEM" as const,
    detail_id: String(row.id ?? ""),
    item_id: String(row.item_id ?? ""),
    item_code_snapshot: (row.item_code_snapshot as string) || null,
    item_name_snapshot: (row.item_name_snapshot as string) || null,
    unit_snapshot: (row.unit_snapshot as string) || null,
    issue_quantity: Number(row.issue_quantity) || 0,
    increase_quantity: Number(row.increase_quantity) || 0,
    requested_transfer_quantity: Number(row.requested_transfer_quantity) || 0,
    line_no: null,
    employee_no_snapshot: null,
    employee_name_snapshot: null,
    institution_code_snapshot: null,
    department_code_snapshot: null,
    size_snapshot: null,
    quantity: null,
    reservation_status: null,
    closed_at: null,
  }));

  const issueLines = ((linesResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    request_id: requestId,
    detail_kind: "ISSUE" as const,
    detail_id: String(row.id ?? ""),
    item_id: String(row.item_id ?? ""),
    item_code_snapshot: (row.item_code_snapshot as string) || null,
    item_name_snapshot: (row.item_name_snapshot as string) || null,
    unit_snapshot: (row.unit_snapshot as string) || null,
    issue_quantity: null,
    increase_quantity: null,
    requested_transfer_quantity: null,
    line_no: Number(row.line_no) || 0,
    employee_no_snapshot: (row.employee_no_snapshot as string) || null,
    employee_name_snapshot: (row.employee_name_snapshot as string) || null,
    institution_code_snapshot: (row.institution_code_snapshot as string) || null,
    institution_name_snapshot: (row.institution_name_snapshot as string) || null,
    department_code_snapshot: (row.department_code_snapshot as string) || null,
    department_name_snapshot: (row.department_name_snapshot as string) || null,
    size_snapshot: (row.size_snapshot as string) || null,
    quantity: Number(row.quantity) || 0,
    reservation_status: null,
    closed_at: null,
  }));

  const reservations = ((resResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    request_id: requestId,
    detail_kind: "RESERVATION" as const,
    detail_id: String(row.id ?? ""),
    item_id: String(row.item_id ?? ""),
    item_code_snapshot: null,
    item_name_snapshot: null,
    unit_snapshot: null,
    issue_quantity: null,
    increase_quantity: null,
    requested_transfer_quantity: null,
    line_no: null,
    employee_no_snapshot: null,
    employee_name_snapshot: null,
    institution_code_snapshot: null,
    department_code_snapshot: null,
    size_snapshot: null,
    quantity: Number(row.quantity) || 0,
    reservation_status: (row.status as string) || null,
    closed_at: (row.closed_at as string) || null,
  }));

  return {
    data: [...items, ...issueLines, ...reservations],
    error: null,
  };
}
