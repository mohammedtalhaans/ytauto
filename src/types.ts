export type StageName = "ideate" | "artifacts" | "frames" | "generate" | "stitch";
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type Aspect = "9:16" | "16:9" | "1:1" | "4:3" | "3:4" | "21:9";
export type Resolution = "720p" | "1080p";
export type Model = "seedance-2" | "gen-4.5" | "kling-3" | "multi-shot" | "characters";

export interface Asset {
  name: string;
  description: string;
  imagePath?: string;
}

export interface Segment {
  name: string;
  prompt: string;
  duration: number;
  aspect: Aspect;
  model: Model;
  resolution: Resolution;
  upscale: boolean;
  refs: string[];                          // names of characters/settings to attach as references
  firstFrameDescription?: string;          // description for gpt-image-2 to render
  firstFrameImagePath?: string;            // populated by frames stage
  videoPath?: string;                       // populated by generate stage
  videoStatus?: "pending" | "done" | "failed";
  videoError?: string;
}

export interface Manifest {
  slug: string;
  idea: string;
  title: string;
  logline: string;
  createdAt: string;
  updatedAt: string;
  defaults: {
    model: Model;
    aspect: Aspect;
    duration: number;
    resolution: Resolution;
    upscale: boolean;
  };
  characters: Asset[];
  settings: Asset[];
  segments: Segment[];
  stages: Record<StageName, { status: StageStatus; completedAt?: string; error?: string }>;
  finalPath?: string;
}

export const DEFAULT_DEFAULTS: Manifest["defaults"] = {
  model: "seedance-2",
  aspect: "9:16",
  duration: 15,
  resolution: "1080p",
  upscale: true
};

export const STAGE_ORDER: StageName[] = ["ideate", "artifacts", "frames", "generate", "stitch"];

// Runway driver types — mirror of videogen's ResolvedJob shape so runway.ts stays portable.
export interface ResolvedJob {
  index: number;
  name: string;
  prompt: string;
  refs: string[];
  model: Model;
  aspect: Aspect;
  duration: number;
  resolution: Resolution;
  upscale: boolean;
  outputDir: string;
}

export const MODEL_LABEL: Record<Model, RegExp> = {
  "seedance-2": /^Seedance\s*2\.0$/i,
  "gen-4.5": /^Gen-?4\.5$/i,
  "kling-3": /^Kling\s*3\.0$/i,
  "multi-shot": /^Multi-?Shot(\s*Video)?$/i,
  "characters": /^(Runway\s+)?Characters$/i
};
