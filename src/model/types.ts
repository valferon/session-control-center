// Core data model shared across the extension and (via protocol.ts) the webview.

// active   = currently working (a turn is in flight);
// awaiting  = stopped to ask YOU something (AskUserQuestion / plan approval) and
//             blocked until you reply;
// pendingReview = ended cleanly within the idle window but you HAVEN'T opened it
//             since it last changed — a completed session still awaiting your
//             review. This is the default state a session lands in when it
//             finishes; opening it (SeenStore) promotes it to "finished";
// finished  = ended cleanly AND you've already checked it since its last change
//             (opened it at or after its current mtime) — reviewed, done;
// interrupted = went quiet with an UNfinished turn: user hit ESC, the window
//             died mid-turn, or an API error cut it off. Incomplete, resumable;
// idle      = quiet for longer than the idle window (default >24h); stale,
//             hidden by default in the sidebar.
//
// pendingReview vs finished is a SeenStore overlay applied in SessionStore, not
// derived from the jsonl: computeStatus() only ever returns "finished" for a
// clean end, and the store rewrites it to "pendingReview" when unseen.
export type SessionStatus = "active" | "awaiting" | "pendingReview" | "finished" | "interrupted" | "idle";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function emptyTokens(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

export interface PrLink {
  prNumber: number;
  prUrl: string;
  prRepository: string;
  timestamp: string;
}

export interface SubagentInfo {
  agentType: string;
  description: string;
  file: string;
}

export interface Aggregates {
  turns: number; // user-role records
  assistantTurns: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  tokens: TokenUsage;
  models: string[];
  startedAt?: string;
  endedAt?: string;
  filesTouched: number;
  prLinks: PrLink[];
  lastQueueOp?: string;
  // Net queued prompts (enqueue minus dequeue/remove, floored at 0). >0 at a
  // clean turn end means the harness has more work lined up — still active.
  queueDepth: number;
  lastConvRole?: "user" | "assistant";
  lastStopReason?: string;
  // True when the final assistant turn ended on a tool that blocks on the user
  // (AskUserQuestion / ExitPlanMode) with no reply yet. Drives "awaiting".
  awaitingInput: boolean;
  // True when the last conversational record is an explicit interrupt marker
  // ("[Request interrupted by user]"). Drives "interrupted" even while recent.
  interrupted: boolean;
  hasSidechain: boolean;
}

export function emptyAggregates(): Aggregates {
  return {
    turns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolCallsByName: {},
    tokens: emptyTokens(),
    models: [],
    queueDepth: 0,
    filesTouched: 0,
    prLinks: [],
    awaitingInput: false,
    interrupted: false,
    hasSidechain: false,
  };
}

export interface Session {
  sessionId: string;
  filePath: string;
  encodedDir: string;
  cwd?: string;
  cwdVerified: boolean;
  gitBranch?: string;
  version?: string;
  title?: string;
  lastPrompt?: string;
  status: SessionStatus;
  mtimeMs: number;
  sizeBytes: number;
  aggregates: Aggregates;
  subagents: SubagentInfo[];
  costUsd: number;
}

export interface ProjectGroup {
  key: string;
  label: string;
  cwd?: string;
  cwdVerified: boolean;
  sessions: Session[];
  activeCount: number;
  awaitingCount: number;
  pendingReviewCount: number;
  finishedCount: number;
  interruptedCount: number;
  idleCount: number;
  lastActivityMs: number;
}

export interface UsageWindow {
  percent: number;
  resetsAt?: string;
  severity?: string;
}

export interface ClaudeUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDayFable?: UsageWindow;
  extra?: { percent: number; usedCredits: number; monthlyLimit: number; currency: string };
  fetchedAt: number;
  error?: string;
}

export interface DashboardMetrics {
  totalSessions: number;
  activeSessions: number;
  awaitingSessions: number;
  pendingReviewSessions: number;
  finishedSessions: number;
  totalProjects: number;
  totalTokens: number;
  totalCostUsd: number;
  openPrs: number;
}
