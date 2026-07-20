import { createContext } from "react";
import type { CgSocket } from "./api";
import type { CardNoticeState } from "./projection";

// Extracted from Shell.tsx so leaf views (DiffView, Board, tests) can consume
// the context without pulling Shell's TerminalView → ghostty-web import chain
// into bun's test resolver (vite aliases the vendor package; bun test doesn't).

export type View = "board" | "terminal" | "diff" | "settings";
export type SessionFocus = { projectId: string; sessionId: string };

export const AppCtx = createContext<{
  projectId: string;
  view: View;
  setView: (v: View) => void;
  sessionFocus: SessionFocus | null;
  focusSession: (sessionId: string) => void;
  diffFocus: number | null;
  focusDiff: (cardId: number) => void;
  socket: CgSocket;
  cardNotices: CardNoticeState;
}>(null as any);
