export type StageName = "ideate" | "artifacts" | "frames" | "generate" | "stitch";
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type Aspect = "9:16" | "16:9" | "1:1" | "4:3" | "3:4" | "21:9";
export type Resolution = "720p" | "1080p";
export type Model = "seedance-2" | "gen-4.5" | "kling-3" | "multi-shot" | "characters";

// Hard cap on Runway's prompt input. Enforced at ideate (validation) and at
// runway.ts (defensive truncation right before submit).
export const MAX_PROMPT_CHARS = 3500;

export interface Asset {
  name: string;
  description: string;
  imagePath?: string;
}

export interface StyleBible {
  era: string;          // e.g. "contemporary 2020s"
  lens: string;         // e.g. "35mm anamorphic, shallow depth of field"
  grade: string;        // e.g. "warm teal-orange, slightly lifted blacks"
  filmStock: string;    // e.g. "digital cinema, gentle film grain emulation"
  motion: string;       // e.g. "handheld realism, sparing slow dolly-ins"
}

export interface AudioBible {
  music: string;        // e.g. "solo piano + warm strings, 70 bpm, lyrical romantic theme in C major"
  ambient: string;      // e.g. "soft urban hum, distant traffic, intermittent birdsong"
  sfxMotif: string;     // e.g. "the ticking of an antique pocket watch — recurs as a leitmotif"
  mixNote: string;      // e.g. "music underscored, ambient subtle, dialogue prominent"
}

export interface Segment {
  name: string;
  prompt: string;
  duration: number;
  aspect: Aspect;
  model: Model;
  resolution: Resolution;
  upscale: boolean;
  refs: string[];                          // names of characters/settings/props to attach as references
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
  storyBeats?: string[];                   // populated by outline pass — one per segment
  createdAt: string;
  updatedAt: string;
  defaults: {
    model: Model;
    aspect: Aspect;
    duration: number;
    resolution: Resolution;
    upscale: boolean;
  };
  style?: StyleBible;
  audio?: AudioBible;
  // Mandatory eye-catching opening — every project starts with a 3-5s hook
  // executed in segment[0]'s opening timestamp block. Captured during ideate
  // pass 1; consumed by ideate pass 2 to write segment[0]'s opening shot.
  hookMoment?: string;
  characters: Asset[];
  settings: Asset[];
  props: Asset[];                          // key objects (locket, letter, bouquet, etc.)
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
//
// `refs` is now {name, path} pairs (was string[]) so runway.ts can re-upload
// each reference with a name that matches the `@<name>` binding inside the
// segment prompt. Seedance 2.0 binds `@<asset_name>` to the uploaded
// filename, so the upload name MUST match.
export interface ResolvedRef {
  name: string;
  path: string;
}

export interface ResolvedJob {
  index: number;
  name: string;
  prompt: string;
  refs: ResolvedRef[];
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
