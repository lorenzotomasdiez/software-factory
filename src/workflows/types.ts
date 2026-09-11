export interface ScoutEnvelope {
  summary: string;
  findings: string[];
  files: string[];
}

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
  topic: string;
  scouts: ScoutResult[];
  report: string;
  reportPath: string;
}
