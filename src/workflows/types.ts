import type { ScoutEnvelope } from "./scout-context/gates";
import type { SectionEnvelope, SectionName } from "./spec-context/gates";
import type { WorkType } from "./work-title";

export interface ScoutResult {
  role: string;
  angle: string;
  ok: boolean;
  attempts: number;
  envelope?: ScoutEnvelope;
  error?: string;
}

export interface WorkflowResult {
  workflowId: string;
  ok: boolean;
  cancelled?: boolean;
  topic: string;
  scouts: ScoutResult[];
  report: string;
  reportPath: string;
}

export interface SpecSectionResult {
  role: string;
  section: SectionName;
  angle: string;
  ok: boolean;
  attempts: number;
  envelope?: SectionEnvelope;
  error?: string;
}

export interface SpecContextWorkflowResult {
  workflowId: string;
  ok: boolean;
  cancelled?: boolean;
  topic: string;
  /** Absent only when neither the planner nor the namer produced a valid name. */
  title?: string;
  type?: WorkType;
  sections: SpecSectionResult[];
  markdown: string;
  specJson: string;
  specMdPath: string;
  specJsonPath: string;
}
