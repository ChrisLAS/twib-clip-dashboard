import type { InventoryCutRequest } from "./inventory";
export type IntakeWorkPriority = "normal" | "urgent";
export interface IntakeWorkView {
  jobId: string;
  intakeId: string;
  intakeRevision: number;
  episodeId: string;
  episodeNumber: number;
  priority: IntakeWorkPriority;
  state: string;
  stage: string;
  code: string | null;
  attempt: number;
  updatedAt: string;
  stale: boolean;
  retryable?: boolean;
  retryTargetId?: string;
  cutRequest?: InventoryCutRequest | null;
}
export interface IntakeWorkList {
  enabled: boolean;
  dispatchEnabled: boolean;
  jobs: IntakeWorkView[];
}
export interface IntakeWorkInput {
  expectedRevision: number;
  priority: IntakeWorkPriority;
}
export interface IntakeWorkRetryInput {
  expectedAttempt: number;
  expectedTargetId?: string;
}
