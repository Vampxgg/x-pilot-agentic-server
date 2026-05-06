import type { RepairRecord } from "../types.js";

export interface BuildMeta {
  sessionId: string;
}

export interface BuildHooks {
  onFirstSuccess?: (info: { round: number; elapsedMs: number }) => void;
  onRound?: (info: { round: number; success: boolean; errorCount: number; elapsedMs: number }) => void;
}

export interface BuildResult {
  success: boolean;
  output: string;
}

export interface BuildRepairResult {
  success: boolean;
  warnings: string[];
  repairLog: RepairRecord[];
}

export interface TutorialPaths {
  sourceDir: string;
  distDir: string;
  distCandidateDir: string;
}

export interface AssembleJobRequest {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface AssembleJobHandle extends AssembleJobRequest {
  mode: "assemble" | "reassemble";
}
