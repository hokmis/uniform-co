"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  HrRequestValidationError,
  summarizeHrRequest,
  type EmployeeSnapshot,
  type IssueLineDraft,
  type UniformItemSnapshot,
} from "@/src/domain/hr-request";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type LineState = {
  lineId: string;
  employeeId: string;
  itemId: string;
  quantity: number;
};

const previewEmployees: EmployeeSnapshot[] = [
  {
    employeeId: "employee-1",
    employeeNo: "E001",
    employeeName: "測試員工一",
    institutionCode: "ABC",
    institutionName: "ABC 機構",
    departmentCode: "A",
    departmentName: "A 部門",
  },
  {
    employeeId: "employee-2",
    employeeNo: "E002",
    employeeName: "測試員工二",
    institutionCode: "ABD",
    institutionName: "ABD 機構",
    departmentCode: "B",
    departmentName: "B 部門",
  },
];

const previewItems: UniformItemSnapshot[] = [
  {
    itemId: "item-m",
    itemCode: "U-M",
    itemName: "測試上衣",
    size: "M",
    unit: "件",
    hrOnHand: 10,
    generalOnHand: 5,
    activeReserved: 0,
  },
  {
    itemId: "item-l",
    itemCode: "U-L",
    itemName: "測試長褲",
    size: "L",
    unit: "件",
    hrOnHand: 20,
    generalOnHand: 100,
    activeReserved: 0,
  },
];

const previewLines: LineState[] = [
  { lineId: "line-1", employeeId: "employee-1", itemId: "item-m", quantity: 10 },
];

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export default function HrRequestWorkbench() {
  const client = getSupabaseBrowserClient();
  const previewMode = !client;
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeSnapshot[]>(previewMode ? previewEmployees : []);
  const [itemOptions, setItemOptions] = useState<UniformItemSnapshot[]>(previewMode ? previewItems : []);
  const [lines, setLines] = useState<LineState[]>(previewMode ? previewLines : []);
  const [distributionDate, setDistributionDate] = useState(taipeiToday());
  const [increases, setIncreases] = useState<Record<string, number>>(
    previewMode ? { "item-m": 0, "item-l": 0 } : {},
  );
  const [dataMessage, setDataMessage] = useState("");
  const [submitMessage, setSubmitMessage] = useState("");
  const [loadingData, setLoadingData] = useState(false);
  const [dataReady, setDataReady] = useState(previewMode);
  const [submitting, setSubmitting] = useState(false);
  const [submittedRequestId, setSubmittedRequestId] = useState("");
  const [hasDraftOperation, setHasDraftOperation] = useState(false);
  const operationRef = useRef<{ requestKey: string; submitKey: string; draftId?: string } | null>(null);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function loadOperationalData() {
      setLoadingData(true);
      const [employeeResult, institutionResult, departmentResult, itemResult, warehouseResult, balanceResult, reservationResult] = await Promise.all([
        supabase.from("employees").select("id,employee_no,name,institution_id,department_id").eq("employment_status", "ACTIVE").order("employee_no"),
        supabase.from("institutions").select("id,code,name"),
        supabase.from("departments").select("id,institution_id,code,name"),
        supabase.from("uniform_items").select("id,item_code,item_name,size,unit").eq("is_active", true).order("item_code"),
        supabase.from("warehouses").select("id,purpose").eq("is_active", true),
        supabase.from("inventory_balances").select("warehouse_id,item_id,on_hand_quantity"),
        supabase.from("inventory_reservations").select("item_id,quantity").eq("status", "ACTIVE"),
      ]);
      if (!active) return;
      if (employeeResult.error || institutionResult.error || departmentResult.error || itemResult.error || warehouseResult.error || balanceResult.error || reservationResult.error) {
        setEmployeeOptions([]);
        setItemOptions([]);
        setLines([]);
        setIncreases({});
        setDataMessage("正式主檔載入失敗，已停用需求建立；請確認 HR 角色與 RLS 權限。");
        setDataReady(false);
        setLoadingData(false);
        return;
      }
      const institutionById = new Map((institutionResult.data ?? []).map((row) => [row.id, row]));
      const departmentById = new Map((departmentResult.data ?? []).map((row) => [row.id, row]));
      const employeeRows = (employeeResult.data ?? []).flatMap((row) => {
        const institution = institutionById.get(row.institution_id);
        const department = departmentById.get(row.department_id);
        return institution && department ? [{
          employeeId: row.id,
          employeeNo: row.employee_no,
          employeeName: row.name,
          institutionId: row.institution_id,
          institutionCode: institution.code,
          institutionName: institution.name,
          departmentId: row.department_id,
          departmentCode: department.code,
          departmentName: department.name,
        }] : [];
      });
      const hrWarehouse = (warehouseResult.data ?? []).find((row) => row.purpose === "HR");
      const generalWarehouse = (warehouseResult.data ?? []).find((row) => row.purpose === "GENERAL");
      const balanceByItem = new Map<string, { hr: number; general: number }>();
      for (const row of balanceResult.data ?? []) {
        const current = balanceByItem.get(row.item_id) ?? { hr: 0, general: 0 };
        if (row.warehouse_id === hrWarehouse?.id) current.hr = Number(row.on_hand_quantity);
        if (row.warehouse_id === generalWarehouse?.id) current.general = Number(row.on_hand_quantity);
        balanceByItem.set(row.item_id, current);
      }
      const reservedByItem = new Map<string, number>();
      for (const row of reservationResult.data ?? []) reservedByItem.set(row.item_id, (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity));
      const itemRows = (itemResult.data ?? []).map((row) => {
        const balance = balanceByItem.get(row.id) ?? { hr: 0, general: 0 };
        return { itemId: row.id, itemCode: row.item_code, itemName: row.item_name, size: row.size ?? "", unit: row.unit, hrOnHand: balance.hr, generalOnHand: balance.general, activeReserved: reservedByItem.get(row.id) ?? 0 };
      });
      if (employeeRows.length > 0 && itemRows.length > 0) {
        setEmployeeOptions(employeeRows);
        setItemOptions(itemRows);
        setLines([{ lineId: `line-${Date.now()}`, employeeId: employeeRows[0].employeeId, itemId: itemRows[0].itemId, quantity: 1 }]);
        setIncreases(Object.fromEntries(itemRows.map((item) => [item.itemId, 0])));
        setDataMessage(`已載入 ${employeeRows.length} 位在職員工、${itemRows.length} 個啟用品號`);
        setDataReady(true);
      } else {
        setEmployeeOptions([]);
        setItemOptions([]);
        setLines([]);
        setIncreases({});
        setDataMessage("正式主檔沒有可用的在職員工或制服品號。");
        setDataReady(false);
      }
      setLoadingData(false);
    }
    void loadOperationalData();
    return () => { active = false; };
  }, [client]);

  const result = useMemo(() => {
    try {
      const issueLines: IssueLineDraft[] = lines.map((line) => ({
        ...line,
        employee: employeeOptions.find((employee) => employee.employeeId === line.employeeId)!,
        item: itemOptions.find((item) => item.itemId === line.itemId)!,
      }));
      const increaseLines = itemOptions.map((item) => ({
        item,
        quantity: increases[item.itemId] ?? 0,
      }));
      return {
        summary: summarizeHrRequest(issueLines, increaseLines),
        error: "",
      };
    } catch (error) {
      return {
        summary: null,
        error:
          error instanceof HrRequestValidationError ? error.message : "需求單資料無法檢查",
      };
    }
  }, [employeeOptions, increases, itemOptions, lines]);

  function updateLine(lineId: string, field: keyof Omit<LineState, "lineId">, value: string) {
    setLines((current) =>
      current.map((line) =>
        line.lineId === lineId
          ? { ...line, [field]: field === "quantity" ? Number(value) || 0 : value }
          : line,
      ),
    );
  }

  function addLine() {
    const nextId = `line-${lines.length + 1}-${Date.now()}`;
    const defaultEmployee = employeeOptions[0];
    const defaultItem = itemOptions[Math.min(1, itemOptions.length - 1)];
    if (!defaultEmployee || !defaultItem) return;
    setLines((current) => [
      ...current,
      { lineId: nextId, employeeId: defaultEmployee.employeeId, itemId: defaultItem.itemId, quantity: 1 },
    ]);
  }

  function removeLine(lineId: string) {
    setLines((current) => current.filter((line) => line.lineId !== lineId));
  }

  async function submitRequest() {
    if (!client) {
      setSubmitMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後才能建立草稿與送出預留。");
      return;
    }
    if (!dataReady) {
      setSubmitMessage(dataMessage || "正式主檔尚未載入，暫時不能建立需求。");
      return;
    }
    if (!distributionDate) {
      setSubmitMessage("請先填寫發放日期。");
      return;
    }
    if (!result.summary || result.error) {
      setSubmitMessage("請先修正送出前檢查錯誤。");
      return;
    }
    setSubmitting(true);
    setSubmitMessage("");
    const operation = operationRef.current ?? { requestKey: crypto.randomUUID(), submitKey: crypto.randomUUID() };
    operationRef.current = operation;
    setHasDraftOperation(Boolean(operation.draftId));
    const issuePayload = lines.map((line) => ({ employeeId: line.employeeId, itemId: line.itemId, quantity: line.quantity }));
    const increasePayload = itemOptions
      .map((item) => ({ itemId: item.itemId, quantity: increases[item.itemId] ?? 0 }))
      .filter((line) => line.quantity > 0);
    let draft = operation.draftId ? { id: operation.draftId, request_no: "" } : null;
    let draftError: { message: string } | null = null;
    if (!draft) {
      const draftResult = await client.rpc("create_hr_request_draft", {
        p_request_no: `HR-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
        p_distribution_date: distributionDate,
        p_note: null,
        p_issue_lines: issuePayload,
        p_increase_lines: increasePayload,
        p_idempotency_key: `CREATE-${operation.requestKey}`,
        p_request_fingerprint: JSON.stringify({ issuePayload, increasePayload, distributionDate }),
      });
      draft = draftResult.data;
      draftError = draftResult.error;
      if (draft?.id) {
        operation.draftId = draft.id;
        setHasDraftOperation(true);
      }
    }
    if (draftError || !draft?.id) {
      setSubmitMessage(draftError?.message ?? "需求草稿建立失敗");
      setSubmitting(false);
      return;
    }
    const { data: submitted, error: submitError } = await client.rpc("submit_hr_request", {
      p_request_id: draft.id,
      p_idempotency_key: `SUBMIT-${operation.submitKey}`,
      p_request_fingerprint: JSON.stringify({ requestId: draft.id, issuePayload, increasePayload }),
    });
    if (!submitError && submitted?.id) {
      setSubmittedRequestId(submitted.id);
      setSubmitMessage(`已送出 ${submitted.request_no ?? draft.request_no}，庫存預留已由伺服器重算。`);
    } else {
      setSubmitMessage(submitError?.message ?? "送出結果未知；再次按下會沿用相同冪等鍵查回結果。");
    }
    setSubmitting(false);
  }

  return (
    <section className="request-workbench" aria-label="人資需求單明細預覽">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">03 / HR REQUEST</p>
            <h2>員工明細與增庫</h2>
          </div>
          <span className={`status-pill ${loadingData ? "" : dataMessage ? "success" : ""}`}>{loadingData ? "載入正式資料…" : client ? "Supabase 資料" : "測試資料預覽"}</span>
        </div>

        <label className="field date-field"><span>發放日期</span><input type="date" value={distributionDate} onChange={(event) => setDistributionDate(event.target.value)} disabled={submitting || loadingData} required /></label>
        <div className="request-table" role="table" aria-label="發放明細">
          <div className="request-table-row request-table-header" role="row">
            <span>員工／機構</span>
            <span>制服品號</span>
            <span>發放量 F</span>
            <span aria-hidden="true" />
          </div>
          {lines.map((line) => (
            <div className="request-table-row" role="row" key={line.lineId}>
              <label className="field">
                <span className="sr-only">員工</span>
                <select
                  value={line.employeeId}
                  onChange={(event) => updateLine(line.lineId, "employeeId", event.target.value)}
                >
                  {employeeOptions.map((employee) => (
                    <option key={employee.employeeId} value={employee.employeeId}>
                      {employee.employeeNo}｜{employee.employeeName}（{employee.institutionCode}/
                      {employee.departmentCode}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="sr-only">制服品號</span>
                <select
                  value={line.itemId}
                  onChange={(event) => updateLine(line.lineId, "itemId", event.target.value)}
                >
                  {itemOptions.map((item) => (
                    <option key={item.itemId} value={item.itemId}>
                      {item.itemCode}｜{item.itemName}（{item.size || "不分尺寸"}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="sr-only">發放量</span>
                <input
                  min={1}
                  step={1}
                  type="number"
                  value={line.quantity}
                  onChange={(event) => updateLine(line.lineId, "quantity", event.target.value)}
                />
              </label>
              <button className="text-button" type="button" onClick={() => removeLine(line.lineId)}>
                移除
              </button>
            </div>
          ))}
        </div>

        <button className="secondary-button" type="button" onClick={addLine}>
          ＋新增員工明細
        </button>
        <button className="primary-button" type="button" onClick={() => void submitRequest()} disabled={submitting || loadingData || !dataReady || Boolean(result.error) || Boolean(submittedRequestId)}>
          {submittedRequestId ? "已送出並預留" : submitting ? "送出中…" : hasDraftOperation ? "重試送出（沿用冪等鍵）" : "建立草稿並送出"}
        </button>
        {dataMessage ? <p className="auth-message" role="status">{dataMessage}</p> : null}
        {submitMessage ? <p className={submitMessage.includes("已送出") ? "success-note" : "error-box"} role="status">{submitMessage}</p> : null}

        <div className="increase-list">
          <div className="subheading">
            <h3>品號彙總增庫量 I</h3>
            <span>尺寸選填；庫存按品號獨立計算</span>
          </div>
            {itemOptions.map((item) => (
            <label className="increase-row" key={item.itemId}>
              <span>
                {item.itemCode}｜{item.itemName}（{item.size || "不分尺寸"}）
                <small>
                  人資倉 {item.hrOnHand} ／總倉 {item.generalOnHand}／有效預留 {item.activeReserved}
                </small>
              </span>
              <input
                min={0}
                step={1}
                type="number"
                value={increases[item.itemId] ?? 0}
                onChange={(event) =>
                  setIncreases((current) => ({
                    ...current,
                    [item.itemId]: Number(event.target.value) || 0,
                  }))
                }
                aria-label={`${item.itemCode} 增庫量`}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="panel result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">04 / ITEM SUMMARY</p>
            <h2>送出前品號檢查</h2>
          </div>
          <div className="heading-actions">
            <span className={`status-pill ${result.error ? "danger" : "success"}`}>
              {result.error ? "不可送出" : "可送出預覽"}
            </span>
            <button className="secondary-button print-button" type="button" onClick={() => window.print()}>
              列印 A4 預覽
            </button>
          </div>
        </div>
        {result.error ? (
          <div className="error-box" role="alert">
            <strong>這張需求單需要修正</strong>
            <span>{result.error}</span>
          </div>
        ) : (
          <>
            <div className="metric-grid">
              <Metric label="發放總量 F" value={result.summary?.totalIssueQuantity ?? 0} />
              <Metric label="增庫總量 I" value={result.summary?.totalIncreaseQuantity ?? 0} />
              <Metric
                label="合計調庫需求 R"
                value={result.summary?.totalRequestedTransferQuantity ?? 0}
              />
            </div>
            <div className="summary-list">
              {result.summary?.summaries.map((summary) => (
                <div className="summary-row" key={summary.item.itemId}>
                  <span>
                    <strong>{summary.item.itemCode}</strong>
                    <small>
                      {summary.item.itemName}／{summary.item.size || "不分尺寸"}
                    </small>
                  </span>
                  <span>F {summary.issueQuantity} ＋ I {summary.increaseQuantity}</span>
                  <strong>
                    R {summary.requestedTransferQuantity}／可用 {summary.availableToRequest}
                  </strong>
                </div>
              ))}
            </div>
            <p className="success-note">
              {previewMode
                ? "這是本機測試資料的送出前預覽；設定 Supabase env 並登入後才可建立正式需求。"
                : "正式送單會透過 Supabase `submit_hr_request` RPC，再次鎖定品號、重算兩倉合計並建立預留。"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
