export type AccountCreationDraft = {
  loginName: string;
  password: string;
  roleCount: number;
  reason: string;
};

export function validateAccountCreation(draft: AccountCreationDraft): string[] {
  const errors: string[] = [];
  if (!draft.loginName.trim()) errors.push("請填寫登入帳號。");
  if (draft.password.length < 6) errors.push("初始密碼至少需要 6 個字元。");
  if (draft.roleCount === 0) errors.push("請至少選擇一個角色權限。");
  if (!draft.reason.trim()) errors.push("請填寫建立理由。");
  return errors;
}
