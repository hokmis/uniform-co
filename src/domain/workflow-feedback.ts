export type ConfirmedInventoryFeedbackInput = {
  status: string | null | undefined;
  message: string;
  completedPrefix: string;
  nextItemPrefix?: string;
};

/** A draft or an optimistic message is never proof of an inventory mutation. */
export function isConfirmedInventoryFeedback({
  status,
  message,
  completedPrefix,
  nextItemPrefix,
}: ConfirmedInventoryFeedbackInput): boolean {
  if (status === "POSTED" && message.startsWith(completedPrefix)) return true;
  return Boolean(nextItemPrefix && message.startsWith(nextItemPrefix));
}

export { safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
