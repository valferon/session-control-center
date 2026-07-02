import { ClaudeUsage, DashboardMetrics, ProjectGroup } from "../model/types";

export interface ActivityBucket {
  startMs: number;
  count: number;
}

export type ToWebview =
  | {
      kind: "snapshot";
      projects: ProjectGroup[];
      metrics: DashboardMetrics;
      activity: ActivityBucket[];
      usage?: ClaudeUsage;
      generatedAt: number;
    };

export type FromWebview =
  | { kind: "ready" }
  | { kind: "requestRefresh" }
  | { kind: "openSession"; sessionId: string; newWindow: boolean }
  | { kind: "startClaude"; sessionId: string }
  | { kind: "copySessionId"; sessionId: string };
