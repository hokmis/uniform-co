"use client";

import { useMemo, useState } from "react";
import {
  calculateRequestSummary,
  calculateWarehousePost,
  InventoryRuleError,
} from "@/src/domain/inventory";

type FormState = {
  hrOnHand: number;
  generalOnHand: number;
  activeReserved: number;
  issueQuantity: number;
  increaseQuantity: number;
  actualTransfer: number;
};

const initialForm: FormState = {
  hrOnHand: 20,
  generalOnHand: 100,
  activeReserved: 0,
  issueQuantity: 10,
  increaseQuantity: 0,
  actualTransfer: 10,
};

const labels: Record<keyof FormState, string> = {
  hrOnHand: "人資倉帳面量",
  generalOnHand: "總倉帳面量",
  activeReserved: "其他有效預留",
  issueQuantity: "本次發放量 F",
  increaseQuantity: "本次增庫量 I",
  actualTransfer: "倉庫實際調庫量 T",
};

function numberValue(value: string): number {
  return value === "" ? 0 : Number(value);
}

export default function InventoryCalculator() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [shortShipReason, setShortShipReason] = useState("");

  const result = useMemo(() => {
    try {
      const request = calculateRequestSummary(form);
      const post = calculateWarehousePost({ ...form, shortShipReason });
      return { request, post, error: "" };
    } catch (error) {
      return {
        request: null,
        post: null,
        error: error instanceof InventoryRuleError ? error.message : "輸入資料無法試算",
      };
    }
  }, [form, shortShipReason]);

  function updateField(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: numberValue(value) }));
  }

  return (
    <section className="workspace" aria-label="庫存試算">
      <div className="panel form-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">01 / REQUEST</p>
            <h2>需求單數量</h2>
          </div>
          <span className="muted">品號層級</span>
        </div>
        <div className="form-grid">
          {(Object.keys(labels) as Array<keyof FormState>).map((field) => (
            <label className="field" key={field}>
              <span>{labels[field]}</span>
              <input
                min={0}
                step={1}
                type="number"
                value={form[field]}
                onChange={(event) => updateField(field, event.target.value)}
              />
            </label>
          ))}
        </div>
        <label className="field reason-field">
          <span>短發原因（T 小於最大可調量時必填）</span>
          <input
            type="text"
            value={shortShipReason}
            onChange={(event) => setShortShipReason(event.target.value)}
            placeholder="例如：總倉現貨不足"
          />
        </label>
      </div>

      <div className="panel result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">02 / VALIDATION</p>
            <h2>送單與 POST 預覽</h2>
          </div>
          <span className={`status-pill ${result.error ? "danger" : "success"}`}>
            {result.error ? "規則拒絕" : "規則通過（預覽）"}
          </span>
        </div>

        {result.error ? (
          <div className="error-box" role="alert">
            <strong>送單規則會拒絕此輸入</strong>
            <span>{result.error}</span>
          </div>
        ) : (
          <>
            <div className="metric-grid">
              <Metric label="兩倉合計" value={result.request?.combinedOnHand ?? 0} />
              <Metric label="可申請量" value={result.request?.availableToRequest ?? 0} />
              <Metric label="調庫需求 R" value={result.request?.requestedTransfer ?? 0} />
              <Metric label="調庫差異 D" value={result.post?.transferDifference ?? 0} />
            </div>
            <dl className="ledger-preview">
              <div>
                <dt>POST 後人資倉</dt>
                <dd>{result.post?.hrOnHandAfter}</dd>
              </div>
              <div>
                <dt>POST 後總倉</dt>
                <dd>{result.post?.generalOnHandAfter}</dd>
              </div>
              <div>
                <dt>公司庫存變化</dt>
                <dd>{result.post?.companyOnHandDelta}</dd>
              </div>
            </dl>
            <p className="success-note">
              目前此頁只做本機預覽，不會建立資料；正式送單必須由 Supabase RPC 重新驗證並建立合計預留。倉庫完成理貨、準備交付時才 POST，成功後才可將制服交給員工。
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
