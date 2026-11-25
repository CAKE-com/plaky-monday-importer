export type PipelineEvent = {
  level: "info" | "warn" | "error" | "ambiguous" | "progress";
  code: string;
  message: string;
  data?: Record<string, unknown>;
  board?: string;
};

export type PipelineLog = (event: PipelineEvent) => void;
