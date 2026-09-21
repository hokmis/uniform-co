"use client";

import type { ReactNode } from "react";

export type WorkflowPrimaryAction = {
  label: string;
  busyLabel?: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
};

type Props = {
  primary: WorkflowPrimaryAction;
  secondary?: ReactNode;
  secondaryLabel?: string;
};

export default function WorkflowActionBar({ primary, secondary, secondaryLabel = "其他操作" }: Props) {
  return (
    <div className="button-row workflow-action-bar">
      <button className="primary-button" type="button" onClick={primary.onClick} disabled={primary.disabled}>
        {primary.busy ? primary.busyLabel ?? "處理中…" : primary.label}
      </button>
      {secondary ? (
        <details className="workflow-secondary-actions">
          <summary className="secondary-button">{secondaryLabel}</summary>
          <div className="workflow-secondary-actions-content">{secondary}</div>
        </details>
      ) : null}
    </div>
  );
}
