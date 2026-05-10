import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectDir, saveManifest, setStageStatus } from "../manifest.js";
import type { Manifest } from "../types.js";

export interface PolishOptions {
  cwd?: string;
  log: (msg: string) => void;
}

/**
 * Polish stage — runs after stitch.
 *
 * 1. (optional, on by default) Generate TTS narration via edge-tts from
 *    `manifest.narrationScript`, save to `narration.mp3`.
 * 2. (optional, on by default) Build an ffmpeg filter graph that:
 *      - Burns segment-level location cards as drawtext overlays at the
 *        appropriate time windows (each card visible 0.3s fade-in,
 *        2s hold, 0.5s fade-out — total 2.8s starting at the segment's
 *        start in the stitched timeline).
 *      - Ducks the source audio (Seedance music + ambient + SFX) to 30%
 *        and mixes the TTS narration in over the top.
 * 3. Output overwrites `final.mp4` (raw stitch lives at `final.raw.mp4` if
 *    we want to keep it; for now we just overwrite — the raw clips are
 *    still present in projects/<slug>/segments/).
 *
 * If both narrate and titleCards are off, this stage is a no-op.
 *
 * Re-runnable: skips TTS generation if narration.mp3 already exists and
 * matches the current narrationScript (we just check existence — to force
 * regeneration delete narration.mp3 manually).
 */
export async function runPolish(manifest: Manifest, options: PolishOptions): Promise<Manifest> {
  const cwd = options.cwd ?? process.cwd();
  setStageStatus(manifest, "polish", "running");
  saveManifest(manifest, cwd);

  const wantNarration = manifest.defaults.narrate !== false && Boolean(manifest.narrationScript?.trim());
  const wantTitleCards = manifest.defaults.titleCards !== false && manifest.segments.some((s) => s.locationCard);

  if (!wantNarration && !wantTitleCards) {
    options.log("[polish] narrate=false and no titleCards — nothing to do, skipping");
    setStageStatus(manifest, "polish", "skipped");
    saveManifest(manifest, cwd);
    return manifest;
  }

  const dir = projectDir(manifest.slug, cwd);
  const finalPath = join(dir, "final.mp4");
  // Polish always reads from a stable RAW source (the unmodified concat
  // output from stitch) so re-running polish doesn't accumulate burnt-in
  // text on top of previous polish runs. On the first polish run for a
  // project, we snapshot the current final.mp4 as final.raw.mp4 — this
  // is the canonical raw input forever after. Subsequent polish runs
  // always read this file and overwrite final.mp4 with a fresh polish.
  const rawPath = join(dir, "final.raw.mp4");
  if (!existsSync(rawPath)) {
    if (!existsSync(finalPath)) {
      throw new Error("[polish] neither final.mp4 nor final.raw.mp4 found — run stitch first");
    }
    options.log("[polish] snapshotting current final.mp4 -> final.raw.mp4 as the canonical pre-polish source");
    copyFileSync(finalPath, rawPath);
  }
  // Use a working copy because ffmpeg can't have input == output.
  const stitchInput = join(dir, "final.stitch.mp4");
  if (existsSync(stitchInput)) unlinkSync(stitchInput);
  copyFileSync(rawPath, stitchInput);

  // ---- Narration + synced captions ----
  let narrationPath: string | undefined;
  let subtitlesVttPath: string | undefined;
  let subtitlesAssPath: string | undefined;
  if (wantNarration) {
    narrationPath = join(dir, "narration.mp3");
    subtitlesVttPath = join(dir, "narration.vtt");
    if (!existsSync(narrationPath)) {
      const voice = manifest.defaults.narrationVoice || "en-US-AriaNeural";
      options.log(`[polish] generating TTS narration + subtitles (voice ${voice}, ${manifest.narrationScript!.length} chars)`);
      await runEdgeTts(manifest.narrationScript!, voice, narrationPath, subtitlesVttPath, options.log);
      // edge-tts emits cues; mergeSubtitleCues normalizes them and writes
      // out a sibling .ass file with explicit PlayResY for predictable
      // libass rendering.
      subtitlesAssPath = mergeSubtitleCues(subtitlesVttPath, options.log);
    } else {
      options.log("[polish] narration.mp3 already exists, reusing (delete to regenerate)");
      if (!existsSync(subtitlesVttPath)) {
        const voice = manifest.defaults.narrationVoice || "en-US-AriaNeural";
        const throwaway = join(mkdtempSync(join(tmpdir(), "ytauto-tts-resub-")), "throwaway.mp3");
        options.log(`[polish] subtitles missing — regenerating from narration text`);
        await runEdgeTts(manifest.narrationScript!, voice, throwaway, subtitlesVttPath, options.log);
        subtitlesAssPath = mergeSubtitleCues(subtitlesVttPath, options.log);
        try { rmSync(throwaway, { force: true }); } catch { /* ignore */ }
      } else {
        // Both exist — derive .ass path and ensure it's there (regenerate
        // from VTT if the .ass got deleted out of band).
        subtitlesAssPath = subtitlesVttPath.replace(/\.vtt$/i, ".ass");
        if (!existsSync(subtitlesAssPath)) {
          mergeSubtitleCues(subtitlesVttPath, options.log);
        }
      }
    }
  }

  // ffmpeg's subtitles filter is libass-based and parses paths in a fragile
  // way on Windows (drive colons must be escaped, backslashes confuse it,
  // spaces in paths break unquoted parsing). Copy the .ass to a temp dir
  // with a simple ASCII filename and reference it via a forward-slash path.
  let subsForFfmpeg: string | undefined;
  let subsTempDir: string | undefined;
  if (subtitlesAssPath && existsSync(subtitlesAssPath)) {
    subsTempDir = mkdtempSync(join(tmpdir(), "ytauto-subs-"));
    subsForFfmpeg = join(subsTempDir, "subs.ass");
    copyFileSync(subtitlesAssPath, subsForFfmpeg);
  }

  // ---- Build ffmpeg filter graph ----
  const titleCardFilters = wantTitleCards ? buildTitleCardFilters(manifest) : "";
  const filterGraph = buildFilterGraph({
    titleCardFilters,
    hasNarration: Boolean(narrationPath),
    subtitlesFfmpegPath: subsForFfmpeg
  });

  const ffmpegArgs: string[] = ["-y", "-i", stitchInput];
  if (narrationPath) {
    ffmpegArgs.push("-i", narrationPath);
  }
  if (filterGraph) {
    ffmpegArgs.push("-filter_complex", filterGraph);
    ffmpegArgs.push("-map", "[vout]");
    ffmpegArgs.push("-map", narrationPath ? "[aout]" : "0:a");
  }
  // Re-encode video (drawtext requires it). Use a high-quality preset to
  // preserve the upscaled 4K source. Audio re-encoded as AAC.
  ffmpegArgs.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p");
  ffmpegArgs.push("-c:a", "aac", "-b:a", "192k");
  ffmpegArgs.push(finalPath);

  options.log(`[polish] ffmpeg ${describeArgs(ffmpegArgs)}`);
  await runFfmpeg(ffmpegArgs, options.log);

  // Cleanup the working copy + subs temp dir
  if (existsSync(stitchInput)) unlinkSync(stitchInput);
  if (subsTempDir) {
    try { rmSync(subsTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  setStageStatus(manifest, "polish", "done");
  saveManifest(manifest, cwd);

  const sizeMb = (statSync(finalPath).size / (1024 * 1024)).toFixed(1);
  options.log(`[polish] final -> ${finalPath} (${sizeMb} MB)`);
  return manifest;
}

interface FilterGraphArgs {
  titleCardFilters: string;
  hasNarration: boolean;
  subtitlesFfmpegPath?: string;   // path to a VTT file in a simple temp location
}

function buildFilterGraph(args: FilterGraphArgs): string {
  // Video chain: 0:v → optional drawtext (title cards, top-left)
  //                 → optional subtitles (synced narration captions, bottom)
  //                 → [vout]
  // Audio chain: 0:a (ducked to 30%) + 1:a (narration full) mixed → [aout]
  const videoSteps: string[] = [];
  if (args.titleCardFilters) {
    videoSteps.push(args.titleCardFilters);
  }
  if (args.subtitlesFfmpegPath) {
    // The .ass file already defines PlayResX/Y=1080x1920 in its Script Info
    // section and a fully-styled Default style (Arial, FontSize=56 in those
    // coords, white with outline + shadow, bottom-center alignment, MarginV
    // pulling text up from the bottom edge). libass scales correctly to the
    // actual video resolution from those coords, so we don't pass force_style
    // or original_size — the ASS document is self-describing.
    //
    // ffmpeg subtitles filter wants the path in forward-slash form with
    // the drive-letter colon escaped (`C\:/...`).
    const escapedPath = args.subtitlesFfmpegPath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\:");
    videoSteps.push(`subtitles='${escapedPath}'`);
  }
  const videoChain = videoSteps.length > 0
    ? `[0:v]${videoSteps.join(",")}[vout]`
    : `[0:v]copy[vout]`;

  if (!args.hasNarration) {
    return videoChain;
  }
  // Duck source audio to ~30% so narration sits clearly on top. Pad
  // narration to source length so amix duration=first works without
  // truncation when narration is shorter (typical case).
  const audioChain = `[0:a]volume=0.3[a0];[1:a]apad[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
  return `${videoChain};${audioChain}`;
}

function buildTitleCardFilters(manifest: Manifest): string {
  // Cumulative time offset so each segment's card appears at its position
  // in the stitched timeline.
  const fontPath = pickFontPath();
  const filters: string[] = [];
  let offset = 0;
  // Optional global title card on segment 0 (if manifest.titleCard set, it
  // overrides segment[0].locationCard for the first segment's window).
  for (let i = 0; i < manifest.segments.length; i++) {
    const seg = manifest.segments[i];
    const cardText = i === 0 && manifest.titleCard ? manifest.titleCard : seg.locationCard;
    if (cardText) {
      const start = offset + 0.3;          // delay 0.3s into the segment
      const fadeIn = 0.3;
      const hold = 2.0;
      const fadeOut = 0.5;
      const end = start + fadeIn + hold + fadeOut;
      const escaped = escapeDrawtext(cardText);
      // Drop shadow + subtle scale for legibility on busy backgrounds.
      // Title cards moved to top-left so they don't compete with the
      // subtitles track that lives at the bottom of frame.
      filters.push(buildDrawtext({
        fontPath,
        text: escaped,
        start,
        fadeIn,
        hold,
        fadeOut,
        end,
        position: "top-left"
      }));
    }
    offset += seg.duration;
  }
  return filters.join(",");
}

interface DrawtextArgs {
  fontPath: string | undefined;
  text: string;
  start: number;
  fadeIn: number;
  hold: number;
  fadeOut: number;
  end: number;
  position: "bottom-left" | "top-left" | "top-center";
}

function buildDrawtext(args: DrawtextArgs): string {
  const x =
    args.position === "bottom-left" ? "60" :
    args.position === "top-left"    ? "60" :
                                      "(w-text_w)/2";
  const y =
    args.position === "bottom-left" ? "h-text_h-80" :
    args.position === "top-left"    ? "80" :
                                      "80";
  // Alpha keyframes: fade-in over [start, start+fadeIn], hold,
  // fade-out over [end-fadeOut, end].
  const fadeInEnd = args.start + args.fadeIn;
  const fadeOutStart = args.end - args.fadeOut;
  const alphaExpr =
    `if(lt(t\\,${args.start})\\,0\\,` +
    `if(lt(t\\,${fadeInEnd})\\,(t-${args.start})/${args.fadeIn}\\,` +
    `if(lt(t\\,${fadeOutStart})\\,1\\,` +
    `if(lt(t\\,${args.end})\\,1-(t-${fadeOutStart})/${args.fadeOut}\\,0))))`;
  const fontParam = args.fontPath ? `:fontfile='${args.fontPath.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : "";
  return (
    `drawtext=text='${args.text}'${fontParam}` +
    `:fontcolor=white@1.0:fontsize=44:borderw=3:bordercolor=black@0.85` +
    `:shadowcolor=black@0.7:shadowx=2:shadowy=2` +
    `:x=${x}:y=${y}` +
    `:enable='between(t,${args.start},${args.end})'` +
    `:alpha='${alphaExpr}'`
  );
}

function escapeDrawtext(text: string): string {
  // ffmpeg drawtext requires escaping single quotes, backslashes, colons,
  // and percent signs. We also strip newlines.
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/[\r\n]+/g, " ");
}

function pickFontPath(): string | undefined {
  // Try a few common font locations across platforms; return the first that
  // exists. If none, return undefined and ffmpeg will fall back to a
  // default font (which may not look great but won't fail).
  const candidates = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
  ];
  return candidates.find((p) => existsSync(p));
}

async function runEdgeTts(text: string, voice: string, outPath: string, subtitlesPath: string | undefined, log: (msg: string) => void): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  // Write the text to a temp file and pass --file. Passing long multi-line
  // text via --text on Windows with shell=true mangles arg quoting.
  const tempDir = mkdtempSync(join(tmpdir(), "ytauto-tts-"));
  const textPath = join(tempDir, "narration.txt");
  writeFileSync(textPath, text, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const command = "python";
      const args = ["-m", "edge_tts", "--voice", voice, "--file", textPath, "--write-media", outPath];
      if (subtitlesPath) {
        // edge-tts emits VTT with per-word cues. We post-process them into
        // phrase-length cues for clean on-screen reading.
        args.push("--write-subtitles", subtitlesPath);
      }
      // No shell=true — python.exe resolves via PATH directly and shell-mode
      // mangles args containing spaces (paths like "yt automation").
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        reject(new Error(`[polish] python -m edge_tts spawn failed: ${err.message}. Install with: pip install edge-tts`));
      });
      child.on("close", (code) => {
        if (code === 0) {
          log(`[polish] TTS written -> ${outPath}${subtitlesPath ? ` (+ subs: ${subtitlesPath})` : ""}`);
          resolve();
        } else {
          reject(new Error(`[polish] edge-tts exited ${code}: ${stderr.split(/\r?\n/).slice(-10).join("\n")}`));
        }
      });
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * edge-tts emits subtitle cues in either SRT-style (HH:MM:SS,mmm) or VTT-
 * style (HH:MM:SS.mmm) format depending on version, and may omit the
 * WEBVTT header. Some versions emit per-word cues (need merging); recent
 * versions emit phrase-level cues already.
 *
 * This function:
 *   1. Parses both timestamp separators
 *   2. If cues are word-level (mostly 1-2 words, no sentence-ending
 *      punctuation), merges them into phrase-length chunks
 *   3. If cues are already sentence-level, leaves them alone
 *   4. ALSO writes a sibling .ass file with explicit PlayResY so ffmpeg's
 *      libass filter sizes the text correctly on a 4K vertical frame.
 *      WEBVTT has no PlayRes concept; libass falls back to a default
 *      288-tall coordinate system which makes FontSize values absurdly
 *      large when scaled to a 4K render. ASS gives us deterministic sizing.
 *   5. Returns the path to the .ass file (caller passes that to ffmpeg
 *      instead of the .vtt).
 */
function mergeSubtitleCues(vttPath: string, log: (msg: string) => void): string {
  const raw = readFileSync(vttPath, "utf8");
  const lines = raw.split(/\r?\n/);
  interface Cue { start: string; end: string; text: string }
  const cues: Cue[] = [];
  // Accept both `.` (VTT) and `,` (SRT) decimal separators.
  const tsRegex = /^(\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3})/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(tsRegex);
    if (m) {
      const text = (lines[i + 1] ?? "").trim();
      if (text) {
        cues.push({
          start: m[1].replace(",", "."),
          end:   m[2].replace(",", "."),
          text
        });
      }
    }
  }
  if (cues.length === 0) {
    log(`[polish] subtitle file has no cues — leaving as-is`);
    // Return the original VTT path; ffmpeg may or may not accept it but
    // we shouldn't crash here.
    return vttPath;
  }

  // Detect granularity: if MOST cues end with sentence punctuation OR have
  // 4+ words, treat as already phrase/sentence-level and skip merging.
  const phraseLike = cues.filter((c) =>
    /[.!?]\s*$/.test(c.text) || c.text.split(/\s+/).length >= 4
  ).length;
  const isAlreadyPhraseLevel = phraseLike >= cues.length * 0.6;

  let outCues: Cue[];
  if (isAlreadyPhraseLevel) {
    outCues = cues;
    log(`[polish] subtitle cues are already phrase-level (${cues.length} cues) — keeping as-is`);
  } else {
    // Merge word-level cues into phrases. Start a new merged cue when the
    // current one reaches ~5 words, ends a sentence, or hits ~36 chars.
    const merged: Cue[] = [];
    let current: Cue | null = null;
    for (const cue of cues) {
      if (!current) {
        current = { ...cue };
        continue;
      }
      const currentWords = current.text.split(/\s+/).length;
      const currentEndsSentence = /[.!?]\s*$/.test(current.text);
      if (currentEndsSentence || currentWords >= 5 || current.text.length >= 36) {
        merged.push(current);
        current = { ...cue };
      } else {
        current.text = `${current.text} ${cue.text}`;
        current.end = cue.end;
      }
    }
    if (current) merged.push(current);
    outCues = merged;
    log(`[polish] subtitle cues merged: ${cues.length} word-level → ${merged.length} phrase-level`);
  }

  // Write canonical WEBVTT (kept around for human inspection / debugging).
  const outLines: string[] = ["WEBVTT", ""];
  for (let i = 0; i < outCues.length; i++) {
    outLines.push(String(i + 1));
    outLines.push(`${outCues[i].start} --> ${outCues[i].end}`);
    outLines.push(outCues[i].text);
    outLines.push("");
  }
  writeFileSync(vttPath, outLines.join("\n"), "utf8");

  // Also write a .ass sibling for ffmpeg with explicit PlayResY so font
  // sizing is deterministic. PlayResY=1920 matches our 9:16 vertical
  // baseline; FontSize=56 in this coordinate system renders ~3% of frame
  // height, scaled to whatever the actual video resolution is.
  const assPath = vttPath.replace(/\.vtt$/i, ".ass");
  const ass = buildAss(outCues);
  writeFileSync(assPath, ass, "utf8");
  return assPath;
}

/**
 * Convert a list of VTT cues to a minimal ASS document with PlayRes set
 * for predictable libass rendering.
 */
function buildAss(cues: Array<{ start: string; end: string; text: string }>): string {
  // ASS uses H:MM:SS.cs (centiseconds, 2 digits) — convert from VTT's
  // HH:MM:SS.mmm (milliseconds, 3 digits).
  const toAssTs = (vtt: string): string => {
    const m = vtt.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!m) return "0:00:00.00";
    const h = String(parseInt(m[1], 10)); // single-digit hour
    return `${h}:${m[2]}:${m[3]}.${m[4].slice(0, 2)}`;
  };
  const escapeAss = (s: string): string => s.replace(/\r?\n/g, " \\N ").replace(/\{/g, "(").replace(/\}/g, ")");
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // FontSize=56 in 1920-tall coords ≈ 2.9% frame height. PrimaryColour
    // white, OutlineColour black, BackColour (semi-transparent black) for
    // a soft box behind text. BorderStyle=1 = outline + shadow (cleaner
    // than full box). Alignment=2 = bottom-center. MarginV=180 pulls text
    // up from the very bottom edge.
    "Style: Default,Arial,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,90,90,180,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ].join("\n");
  const events = cues.map((c) => `Dialogue: 0,${toAssTs(c.start)},${toAssTs(c.end)},Default,,0,0,0,,${escapeAss(c.text)}`).join("\n");
  return header + "\n" + events + "\n";
}

function runFfmpeg(args: string[], log: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        log(`[polish] ffmpeg failed; last stderr lines:\n${stderr.split(/\r?\n/).slice(-25).join("\n")}`);
        reject(new Error(`ffmpeg exited ${code}`));
      }
    });
  });
}

function describeArgs(args: string[]): string {
  // Truncate the filter_complex arg in logs since it can be very long.
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-filter_complex" && args[i + 1]) {
      out.push(a, args[i + 1].length > 80 ? `<filter graph, ${args[i + 1].length} chars>` : args[i + 1]);
      i++;
    } else {
      out.push(a);
    }
  }
  return out.join(" ");
}
