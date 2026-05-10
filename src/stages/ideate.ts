import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractJson, runCodexText } from "../codex.js";
import { saveManifest, setStageStatus, projectDir } from "../manifest.js";
import {
  MAX_PROMPT_CHARS,
  type Aspect,
  type AudioBible,
  type BeatFunction,
  type Manifest,
  type Model,
  type Resolution,
  type StyleBible
} from "../types.js";

interface OutlineRawBeat {
  function: BeatFunction;
  description: string;
  locationCard?: string | null;
}

interface OutlineRaw {
  title: string;
  logline: string;
  titleCard?: string;
  narrationScript: string;
  hookMoment: string;
  spectacleHints?: string[];
  storyBeats: OutlineRawBeat[] | string[];   // legacy string[] tolerated
  characters: Array<{ name: string; description: string }>;
  settings: Array<{ name: string; description: string }>;
  props?: Array<{ name: string; description: string }>;
  style: StyleBible;
  audio: AudioBible;
}

interface SegmentsRaw {
  segments: Array<{
    name: string;
    prompt: string;
    duration: number;
    refs: string[];
    firstFrameDescription: string;
    lastFrameDescription: string;
    beatFunction?: BeatFunction;
    locationCard?: string | null;
  }>;
}

export interface IdeateOptions {
  segmentCount?: number;
  codexModel: string;
  cwd?: string;
  log: (msg: string) => void;
}

export async function runIdeate(manifest: Manifest, options: IdeateOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  if (manifest.stages.ideate.status === "done" && manifest.segments.length > 0) {
    options.log("[ideate] already done; skipping (delete segments + clear stage status to redo)");
    return manifest;
  }

  setStageStatus(manifest, "ideate", "running");
  saveManifest(manifest, cwd);

  // ---- PASS 1: Outline ----
  const outline = await passOutline(manifest, options, cwd);
  // Normalize storyBeats — accept both modern object form and legacy string[].
  // Internal manifest stores beats as descriptions only; the function +
  // locationCard get pushed onto each Segment object during pass 2 mapping.
  const normalizedBeats: OutlineRawBeat[] = Array.isArray(outline.storyBeats) && outline.storyBeats.length > 0
    ? typeof outline.storyBeats[0] === "string"
      ? (outline.storyBeats as string[]).map((d) => ({ function: "rising", description: d }))
      : (outline.storyBeats as OutlineRawBeat[])
    : [];
  manifest.title = outline.title;
  manifest.logline = outline.logline;
  manifest.titleCard = outline.titleCard;
  manifest.narrationScript = outline.narrationScript;
  manifest.hookMoment = outline.hookMoment;
  manifest.spectacleHints = outline.spectacleHints ?? [];
  manifest.storyBeats = normalizedBeats.map((b) => b.description);
  manifest.characters = outline.characters.map((c) => ({ name: kebab(c.name), description: c.description }));
  manifest.settings = outline.settings.map((s) => ({ name: kebab(s.name), description: s.description }));
  manifest.props = (outline.props ?? []).map((p) => ({ name: kebab(p.name), description: p.description }));
  manifest.style = outline.style;
  manifest.audio = outline.audio;
  saveManifest(manifest, cwd);
  options.log(
    `[ideate] outline: ${manifest.characters.length} char(s), ${manifest.settings.length} setting(s), ${manifest.props.length} prop(s), ${normalizedBeats.length} beat(s), ${manifest.spectacleHints?.length ?? 0} spectacle hint(s)`
  );
  options.log(`[ideate] hook: ${manifest.hookMoment}`);
  options.log(`[ideate] narration: ${manifest.narrationScript ? `${manifest.narrationScript.length} chars / ~${manifest.narrationScript.split(/\s+/).length} words` : "(MISSING)"}`);
  for (const beat of normalizedBeats) {
    options.log(`[ideate] beat: [${beat.function}] ${beat.description}${beat.locationCard ? ` (card: ${beat.locationCard})` : ""}`);
  }
  for (const hint of manifest.spectacleHints ?? []) {
    options.log(`[ideate] spectacle: ${hint}`);
  }

  // ---- PASS 2: Segments (with up to 2 retries on length-violation) ----
  const segments = await passSegmentsWithRetries(manifest, outline, options, cwd);

  // Inject style/audio/character descriptors verbatim into every segment prompt.
  const characterDescByName = new Map(manifest.characters.map((c) => [c.name, c.description]));
  manifest.segments = segments.map((s, i) => {
    const refs = (s.refs ?? []).map(kebab);
    const finalPrompt = composeSegmentPrompt({
      basePrompt: s.prompt.trim(),
      refs,
      style: manifest.style!,
      audio: manifest.audio!,
      characterDescByName
    });
    if (finalPrompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `[ideate] segment "${s.name}" final prompt is ${finalPrompt.length} chars (max ${MAX_PROMPT_CHARS}). ` +
        "This indicates the model produced a base prompt that's too long even after retries — please re-run ideate."
      );
    }
    // Pass 2 should echo beatFunction + locationCard from the outline; fall
    // back to the outline's storyBeats[i] if pass 2 omitted them.
    const fallbackBeat = normalizedBeats[i];
    const beatFunction = s.beatFunction ?? fallbackBeat?.function;
    const locationCardRaw = s.locationCard ?? fallbackBeat?.locationCard;
    const locationCard = locationCardRaw === null ? undefined : (locationCardRaw || undefined);
    // For segment 0, the project-level titleCard overrides the per-segment
    // card so the opening reads as the video's title (e.g. "60 SECONDS TO
    // SHIBUYA ZERO" instead of just "SHIBUYA • 02:14 AM").
    const effectiveCard = i === 0 && manifest.titleCard ? manifest.titleCard : locationCard;
    return {
      name: s.name ? kebab(s.name) : `seg-${String(i + 1).padStart(2, "0")}`,
      prompt: finalPrompt,
      duration: clampDuration(s.duration ?? manifest.defaults.duration),
      aspect: manifest.defaults.aspect as Aspect,
      model: manifest.defaults.model as Model,
      resolution: manifest.defaults.resolution as Resolution,
      upscale: manifest.defaults.upscale,
      refs,
      firstFrameDescription: s.firstFrameDescription?.trim(),
      lastFrameDescription: s.lastFrameDescription?.trim(),
      beatFunction,
      locationCard: effectiveCard
    };
  });

  // Continuity sync — for non-final segments, ensure lastFrameDescription
  // equals segment[i+1].firstFrameDescription so the frames stage can reuse
  // the same image file across the cut. Pass 2 is instructed to make these
  // identical; if the model drifts, we sync to the NEXT segment's
  // firstFrameDescription (not the current segment's lastFrameDescription)
  // because firstFrame is the canonical anchor for that segment.
  for (let i = 0; i < manifest.segments.length - 1; i++) {
    const next = manifest.segments[i + 1];
    if (next.firstFrameDescription) {
      manifest.segments[i].lastFrameDescription = next.firstFrameDescription;
    }
  }

  setStageStatus(manifest, "ideate", "done");
  saveManifest(manifest, cwd);
  writeFileSync(join(projectDir(manifest.slug, cwd), "script.md"), buildScriptMarkdown(manifest));
  options.log(`[ideate] ${manifest.segments.length} segment(s) finalized`);
  return manifest;
}

// ---------- Pass 1 ----------

async function passOutline(manifest: Manifest, options: IdeateOptions, cwd: string): Promise<OutlineRaw> {
  const template = readFileSync(resolve(cwd, "prompts/ideate-outline.md"), "utf8");
  const prompt = template
    .replace("{{idea}}", manifest.idea)
    .replace("{{segmentCount}}", String(options.segmentCount ?? 4));
  options.log("[ideate] pass 1 — outline (codex high reasoning)");
  const raw = await runCodexText(prompt, {
    model: options.codexModel,
    cwd,
    reasoningEffort: "high"
  });
  const parsed = JSON.parse(extractJson(raw)) as OutlineRaw;
  validateOutline(parsed);
  return parsed;
}

function validateOutline(parsed: OutlineRaw): void {
  if (!parsed.title || !parsed.logline) throw new Error("[ideate] outline missing title/logline");
  if (!parsed.hookMoment || parsed.hookMoment.trim().length < 20) {
    throw new Error("[ideate] outline missing hookMoment (or too short to be a real hook)");
  }
  if (!parsed.narrationScript || parsed.narrationScript.trim().length < 80) {
    throw new Error(
      "[ideate] outline missing narrationScript (or too short — needs ~2 words/second of total video duration). " +
      "This is what makes the video comprehensible; required."
    );
  }
  if (!Array.isArray(parsed.storyBeats) || parsed.storyBeats.length === 0) {
    throw new Error("[ideate] outline missing storyBeats");
  }
  // If beats are objects, require function tag on each.
  if (typeof parsed.storyBeats[0] === "object") {
    const beats = parsed.storyBeats as OutlineRawBeat[];
    const validFns: BeatFunction[] = ["setup", "inciting", "rising", "climax", "resolution"];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (!b.description) throw new Error(`[ideate] storyBeats[${i}] missing description`);
      if (!validFns.includes(b.function)) {
        throw new Error(`[ideate] storyBeats[${i}].function must be one of ${validFns.join("/")} — got "${b.function}"`);
      }
    }
  }
  if (!Array.isArray(parsed.characters)) throw new Error("[ideate] outline missing characters[]");
  if (!Array.isArray(parsed.settings)) throw new Error("[ideate] outline missing settings[]");
  if (!parsed.style || !parsed.style.era || !parsed.style.lens || !parsed.style.grade) {
    throw new Error("[ideate] outline missing style bible (era/lens/grade)");
  }
  if (!parsed.audio || !parsed.audio.music || !parsed.audio.ambient) {
    throw new Error("[ideate] outline missing audio bible (music/ambient)");
  }
}

// ---------- Pass 2 (with retry-on-length-violation) ----------

async function passSegmentsWithRetries(
  manifest: Manifest,
  outline: OutlineRaw,
  options: IdeateOptions,
  cwd: string
): Promise<SegmentsRaw["segments"]> {
  const template = readFileSync(resolve(cwd, "prompts/ideate-segments.md"), "utf8");
  const characterDescByName = new Map(manifest.characters.map((c) => [c.name, c.description]));
  const propNames = new Set(manifest.props.map((p) => p.name));
  const settingNames = new Set(manifest.settings.map((s) => s.name));

  let extraInstructions = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const prompt = template
      .replace("{{outlineJson}}", JSON.stringify(outline, null, 2))
      .replace("{{idea}}", manifest.idea)
      .replace("{{segmentDuration}}", String(manifest.defaults.duration)) +
      (extraInstructions ? "\n\n## Additional constraints from previous attempt\n" + extraInstructions : "");

    options.log(`[ideate] pass 2 — segments (attempt ${attempt}, codex high reasoning)`);
    const raw = await runCodexText(prompt, {
      model: options.codexModel,
      cwd,
      reasoningEffort: "high"
    });
    const parsed = JSON.parse(extractJson(raw)) as SegmentsRaw;
    if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
      throw new Error("[ideate] pass 2 returned no segments");
    }

    // Validate every segment's *final composed* length. If any exceeds, retry
    // with a tightened character budget.
    const violations: Array<{ name: string; finalLen: number; baseLen: number }> = [];
    for (let segIdx = 0; segIdx < parsed.segments.length; segIdx++) {
      const seg = parsed.segments[segIdx];
      if (!seg.firstFrameDescription) {
        violations.push({ name: seg.name, finalLen: 0, baseLen: 0 });
        extraInstructions += `\n- Segment "${seg.name}" was missing firstFrameDescription. EVERY segment must have one (no nulls).`;
        continue;
      }
      if (!seg.lastFrameDescription) {
        violations.push({ name: seg.name, finalLen: 0, baseLen: 0 });
        extraInstructions += `\n- Segment "${seg.name}" was missing lastFrameDescription. EVERY segment must have one (no nulls). For non-final segments it should EQUAL segments[i+1].firstFrameDescription.`;
        continue;
      }
      // For non-final segments, lastFrameDescription must match next
      // segment's firstFrameDescription. The pipeline will auto-sync at
      // ingest, but warn the model so it converges on identity.
      const next = parsed.segments[segIdx + 1];
      if (next && next.firstFrameDescription &&
          seg.lastFrameDescription.trim() !== next.firstFrameDescription.trim()) {
        extraInstructions += `\n- Segment "${seg.name}" lastFrameDescription does NOT equal segments[${segIdx + 1}].firstFrameDescription word-for-word. They must be byte-identical so the pipeline can reuse the image file across the cut.`;
      }
      const refs = (seg.refs ?? []).map(kebab);
      // Validate refs reference real names.
      for (const ref of refs) {
        if (!characterDescByName.has(ref) && !settingNames.has(ref) && !propNames.has(ref)) {
          extraInstructions += `\n- Segment "${seg.name}" refs unknown name "${ref}". Use only names from the outline.`;
        }
      }
      const composed = composeSegmentPrompt({
        basePrompt: seg.prompt.trim(),
        refs,
        style: outline.style,
        audio: outline.audio,
        characterDescByName
      });
      if (composed.length > MAX_PROMPT_CHARS) {
        violations.push({ name: seg.name, finalLen: composed.length, baseLen: seg.prompt.length });
      }
    }

    if (
      violations.length === 0 &&
      !extraInstructions.includes("missing firstFrameDescription") &&
      !extraInstructions.includes("missing lastFrameDescription") &&
      !extraInstructions.includes("refs unknown") &&
      !extraInstructions.includes("does NOT equal")
    ) {
      return parsed.segments;
    }

    // Build retry feedback. The override here is deliberately aggressive —
    // when budget is tight we force pass 2 to use fewer blocks at lower word
    // density rather than letting it hold the line on the per-block target.
    if (violations.length > 0) {
      const longest = violations.reduce((a, b) => (b.finalLen > a.finalLen ? b : a));
      const overheadEstimate = longest.finalLen - longest.baseLen;
      const newBudget = Math.max(700, MAX_PROMPT_CHARS - overheadEstimate - 200);
      // Block count + per-block word target tighten as budget gets tighter.
      const targetBlocks = newBudget < 1200 ? 3 : newBudget < 1700 ? 3 : 4;
      const wordTarget = newBudget < 1200 ? "30–45" : newBudget < 1700 ? "45–65" : "60–90";
      extraInstructions +=
        `\n\n## RETRY OVERRIDE (attempt ${attempt + 1})\n` +
        `Previous attempt: ${violations.length} segment(s) exceeded the ${MAX_PROMPT_CHARS}-char composed limit. ` +
        `Auto-prepended overhead is ~${overheadEstimate} chars (style + audio bibles + verbatim character descriptors).\n\n` +
        `**This attempt's hard constraints — these OVERRIDE the per-block guidance in the main template:**\n` +
        `- Each segment's base prompt: **≤${newBudget} chars**\n` +
        `- Use exactly **${targetBlocks} timestamp blocks per segment** (not more)\n` +
        `- Each block: **${wordTarget} words** (not the 60-150 default — budget doesn't allow it here)\n` +
        `- Keep every block specific and detail-dense — just describe LESS per shot, not LESS specifically. Cut secondary actions/details, keep the primary action with body mechanics + camera + one anchor detail.\n` +
        `- Footer stays minimal: SFX timestamps + music timing + negatives. No restated audio bible.\n` +
        `- Spectacle moments still required — just one beat per moment, not elaborate buildup chains.\n\n` +
        `Specifically too long last time: ${violations.map((v) => `"${v.name}" (final ${v.finalLen})`).join(", ")}.`;
      options.log(`[ideate] pass 2 attempt ${attempt} had length violations; retrying — ${targetBlocks} blocks × ${wordTarget} words, budget ≤${newBudget}`);
    } else if (extraInstructions) {
      options.log(`[ideate] pass 2 attempt ${attempt} had structural issues; retrying`);
    }
  }
  throw new Error(
    `[ideate] pass 2 failed to produce valid segments within prompt limits after 5 attempts. ` +
    `Most likely cause: too many characters per segment + verbose descriptors. ` +
    `Consider: editing manifest character descriptions to be tighter (~30 words each), reducing co-presence of multiple characters per segment via story restructure, or running again.`
  );
}

// ---------- Compose segment prompt ----------

interface ComposeArgs {
  basePrompt: string;
  refs: string[];
  style: StyleBible;
  audio: AudioBible;
  characterDescByName: Map<string, string>;
}

/**
 * Final segment prompt = condensed style + audio preamble + character
 * descriptors (verbatim per ref) + base prompt from pass 2.
 *
 * Design goal: the bulk of the prompt's character budget must go to the
 * scene-by-scene timestamp blocks. Pipeline-injected preamble takes care
 * of the "boilerplate" — style bible, audio bible, character identity —
 * leaving pass 2 to spend its budget on dense per-block physical
 * description. Pass 2 is told NOT to restate audio/style; it writes only
 * SFX timestamps + music timing in its footer.
 */
function composeSegmentPrompt(args: ComposeArgs): string {
  const charBlocks: string[] = [];
  for (const ref of args.refs) {
    const desc = args.characterDescByName.get(ref);
    if (desc) {
      charBlocks.push(`[${ref}]: ${desc}`);
    }
  }
  // Preamble is now MINIMAL by design — only style (lens + grade) and the
  // verbatim character descriptors. The audio bible no longer prepends; pass
  // 2 writes a tight 1-line "Music: ... Sound: ..." cue per segment using
  // genre/tempo/key from the bible (not the full verbose music+ambient+mix
  // restatement). This frees ~400 chars per segment for richer scene blocks
  // and a denser SFX list.
  const styleLine = `Style: ${args.style.lens}; ${args.style.grade}.`;
  const parts: string[] = [styleLine];
  if (charBlocks.length > 0) {
    parts.push(charBlocks.join("\n"));
  }
  parts.push(args.basePrompt);
  return parts.join("\n\n");
}

// ---------- Helpers ----------

function kebab(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 15;
  return Math.max(4, Math.min(15, Math.round(value)));
}

function buildScriptMarkdown(manifest: Manifest): string {
  const lines = [`# ${manifest.title}`, "", manifest.logline, ""];
  if (manifest.titleCard) {
    lines.push(`**Title card (segment 1):** ${manifest.titleCard}`, "");
  }
  if (manifest.narrationScript) {
    const wordCount = manifest.narrationScript.split(/\s+/).length;
    lines.push(`## Narration script (~${wordCount} words, TTS via edge-tts)`, "");
    lines.push(`> ${manifest.narrationScript}`);
    lines.push("");
  }
  if (manifest.hookMoment) {
    lines.push("## Opening hook (first 3-5s of segment 1)", "");
    lines.push(`> ${manifest.hookMoment}`);
    lines.push("");
  }
  if (manifest.style) {
    lines.push("## Style bible", "");
    lines.push(`- **Era**: ${manifest.style.era}`);
    lines.push(`- **Lens**: ${manifest.style.lens}`);
    lines.push(`- **Grade**: ${manifest.style.grade}`);
    lines.push(`- **Stock**: ${manifest.style.filmStock}`);
    lines.push(`- **Motion**: ${manifest.style.motion}`);
    lines.push("");
  }
  if (manifest.audio) {
    lines.push("## Audio bible", "");
    lines.push(`- **Music**: ${manifest.audio.music}`);
    lines.push(`- **Ambient**: ${manifest.audio.ambient}`);
    lines.push(`- **SFX motif**: ${manifest.audio.sfxMotif}`);
    lines.push(`- **Mix**: ${manifest.audio.mixNote}`);
    lines.push("");
  }
  if (manifest.storyBeats && manifest.storyBeats.length > 0) {
    lines.push("## Story beats", "");
    manifest.storyBeats.forEach((beat, i) => lines.push(`${i + 1}. ${beat}`));
    lines.push("");
  }
  if (manifest.spectacleHints && manifest.spectacleHints.length > 0) {
    lines.push("## Planned spectacle / VFX moments", "");
    manifest.spectacleHints.forEach((hint) => lines.push(`- ${hint}`));
    lines.push("");
  }
  lines.push("## Characters", "");
  for (const c of manifest.characters) lines.push(`- **${c.name}** — ${c.description}`);
  lines.push("", "## Settings", "");
  for (const s of manifest.settings) lines.push(`- **${s.name}** — ${s.description}`);
  if (manifest.props.length > 0) {
    lines.push("", "## Props", "");
    for (const p of manifest.props) lines.push(`- **${p.name}** — ${p.description}`);
  }
  lines.push("", "## Segments", "");
  for (const seg of manifest.segments) {
    const tags: string[] = [];
    if (seg.beatFunction) tags.push(`beat: **${seg.beatFunction}**`);
    if (seg.locationCard) tags.push(`card: \`${seg.locationCard}\``);
    tags.push(`${seg.duration}s`);
    tags.push(`refs: ${seg.refs.join(", ") || "none"}`);
    tags.push(`prompt ${seg.prompt.length} chars`);
    lines.push(`### ${seg.name} (${tags.join(" • ")})`);
    lines.push("");
    lines.push("```");
    lines.push(seg.prompt);
    lines.push("```");
    if (seg.firstFrameDescription) {
      lines.push("", `_first frame:_ ${seg.firstFrameDescription}`);
    }
    if (seg.lastFrameDescription) {
      lines.push("", `_last frame:_ ${seg.lastFrameDescription}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
