export type StageName = "ideate" | "artifacts" | "frames" | "generate" | "stitch" | "polish";
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

// Story-function tag — every segment serves one of these functions in the
// narrative arc. Pass 1 assigns; pass 2 reads and renders shots whose
// content matches the function (setup is a held character introduction,
// climax is a kinetic VFX peak, resolution is a calmer reaction beat, etc.)
export type BeatFunction = "setup" | "inciting" | "rising" | "climax" | "resolution";

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
  lastFrameDescription?: string;           // ending-frame composition. For non-final segments, MUST equal segment[i+1].firstFrameDescription so the cut is invisible (Seedance interpolates between start/end frames; same end-as-next-start = seamless continuity).
  lastFrameImagePath?: string;             // populated by frames stage; reused from next segment's firstFrameImagePath when descriptions match
  videoPath?: string;                       // populated by generate stage
  videoStatus?: "pending" | "done" | "failed";
  videoError?: string;
  // Story function this segment serves in the arc (setup/inciting/rising/climax/
  // resolution). Pass 2 uses this to decide spectacle vs character-intro vs
  // reaction-beat shaping.
  beatFunction?: BeatFunction;
  // 1-3 word location/time stamp burned in as on-screen text by the polish
  // stage during this segment's window. e.g. "TOKYO • 02:14 AM",
  // "PENTHOUSE — FLOOR 87", "60 SECONDS LEFT".
  locationCard?: string;
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
    // Polish stage controls — applied in src/stages/polish.ts after stitch.
    narrate: boolean;             // mix TTS narration into final.mp4
    narrationVoice: string;       // edge-tts voice id, e.g. "en-US-AriaNeural"
    titleCards: boolean;          // burn segment locationCard as on-screen text
  };
  style?: StyleBible;
  audio?: AudioBible;
  // Mandatory eye-catching opening — every project starts with a 3-5s hook
  // executed in segment[0]'s opening timestamp block. Captured during ideate
  // pass 1; consumed by ideate pass 2 to write segment[0]'s opening shot.
  hookMoment?: string;
  // Planned VFX/spectacle moments across segments — one short sentence per
  // moment, prefixed with the segment number. Pass 2 consumes these and
  // renders them inside the relevant segment's timestamp blocks. Empty array
  // is allowed for genuinely subdued projects but most should have 2-6.
  spectacleHints?: string[];
  // 60-90 word continuous narration script paced to total video duration.
  // Polish stage generates TTS from this and ducks the Seedance audio under
  // it. This is the primary mechanism for story comprehension — without
  // narration, a 1-min multi-segment video reads as 4 cool unrelated shots.
  narrationScript?: string;
  // Optional 1-3 word burn-in title card shown across the whole video (e.g.
  // "60 SECONDS TO SHIBUYA ZERO"). Per-segment cards live on Segment.
  titleCard?: string;
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
  upscale: true,
  narrate: true,
  narrationVoice: "en-US-AriaNeural",
  titleCards: true
};

export const STAGE_ORDER: StageName[] = ["ideate", "artifacts", "frames", "generate", "stitch", "polish"];

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
