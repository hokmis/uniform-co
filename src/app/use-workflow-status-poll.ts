"use client";

import { useCallback, useEffect, useRef } from "react";

type WorkflowStatusPollOptions<T> = {
  active: boolean;
  token: string | null;
  poll: () => Promise<T | null>;
  isTerminal: (value: T) => boolean;
  onValue: (value: T) => void;
  intervalMs?: number;
};

type WorkflowStatusPollHandle<T> = {
  refresh: () => Promise<T | null>;
};

/**
 * Polls one server-owned workflow only while its panel is visible. The next
 * request is scheduled after the previous one finishes, so slow RPCs cannot
 * overlap; foreground refreshes share the same in-flight request instead of
 * starting a second RPC; terminal states stop the loop without a manual
 * refresh step.
 */
export function useWorkflowStatusPoll<T>({
  active,
  token,
  poll,
  isTerminal,
  onValue,
  intervalMs = 4000,
}: WorkflowStatusPollOptions<T>): WorkflowStatusPollHandle<T> {
  const pollRef = useRef(poll);
  const terminalRef = useRef(isTerminal);
  const onValueRef = useRef(onValue);
  const inFlightRef = useRef<Promise<T | null> | null>(null);

  useEffect(() => {
    pollRef.current = poll;
    terminalRef.current = isTerminal;
    onValueRef.current = onValue;
  }, [isTerminal, onValue, poll]);

  const refresh = useCallback((): Promise<T | null> => {
    if (inFlightRef.current) return inFlightRef.current;
    const request = (async () => {
      try {
        return await pollRef.current();
      } catch {
        return null;
      }
    })();
    inFlightRef.current = request;
    void request.then(
      () => { if (inFlightRef.current === request) inFlightRef.current = null; },
      () => { if (inFlightRef.current === request) inFlightRef.current = null; },
    );
    return request;
  }, []);

  useEffect(() => {
    if (!active || !token) return;
    let cancelled = false;
    let timer: number | undefined;

    async function run() {
      // A transient network/session failure must not strand a non-terminal
      // artifact. Keep the same serial loop and retry on the next interval;
      // the panel's foreground query still owns user-visible error text.
      const value = await refresh();
      if (cancelled) return;
      if (value !== null) {
        onValueRef.current(value);
        if (terminalRef.current(value)) return;
      }
      timer = window.setTimeout(() => void run(), intervalMs);
    }

    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      inFlightRef.current = null;
    };
  }, [active, intervalMs, refresh, token]);

  return { refresh };
}
