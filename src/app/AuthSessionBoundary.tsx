"use client";

import { Fragment, type ReactNode } from "react";

type Props = { children: ReactNode; sessionKey: string };

export default function AuthSessionBoundary({ children, sessionKey }: Props) {
  return <Fragment key={sessionKey}>{children}</Fragment>;
}
