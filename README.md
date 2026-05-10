# ytauto

End-to-end pipeline that turns a one-line idea into a finished, multi-segment YouTube video — fully automated.

```
"a one-minute love story, 4 scenes, contemporary indie cinema"
                            │
              ▼ ideate pass 1 (codex / gpt-5.5 high)
     outline: title, story beats, characters, settings, props,
              style bible, audio bible
                            │
              ▼ ideate pass 2 (codex / gpt-5.5 high)
     per-segment Seedance prompts (timestamp blocks,
     2-4 shots each, mandatory first-frame descriptions),
     style + audio + character descriptors auto-prepended,
     every prompt validated ≤3500 chars
                            │
                ▼ artifacts (gpt-image-2 via ChatGPT Plus)
     one ref PNG per character + setting + prop,
     each scored by codex critique → regen once if <7/10
                            │
                ▼ frames (gpt-image-2)
     one first-frame PNG per segment, multi-ref edit
     (character + setting + prop refs)
                            │
                ▼ generate (Runway Seedance 2.0 via Playwright)
     one MP4 per segment, up to 2 in parallel, 4K Topaz upscale
                            │
                ▼ stitch (ffmpeg concat)
                            │
              ▼ polish (ffmpeg drawtext + edge-tts)
     burn segment locationCards as on-screen text;
     generate TTS narration; duck Seedance audio
     and mix narration over the top
                            │
                            ▼
                       final.mp4
```

No API keys for the LLMs/image gen — uses your **ChatGPT subscription** (via the Codex CLI's `imagegen` tool) and your **Runway unlimited subscription** (via a Playwright-driven Chrome). Only paid component is Runway's compute, which you already have.

---

## What you need installed

| Tool                | Why                                                         | Verify with                |
|---------------------|-------------------------------------------------------------|----------------------------|
| Node 22+            | run the CLI                                                 | `node --version`           |
| Codex CLI 0.129+    | text generation (ideate) and image generation (gpt-image-2) | `codex --version`          |
| ChatGPT Plus / Pro  | required entitlement for image_gen tool inside Codex        | `codex login`              |
| Runway subscription | actual video generation                                     | `runwayml.com`             |
| ffmpeg              | stitch segments + polish (drawtext + audio mix)             | `ffmpeg -version`          |
| Python 3.x          | Codex CLI image extraction + edge-tts narration             | `python --version`         |
| edge-tts            | free TTS (Microsoft Azure neural voices, no API key)        | `pip install edge-tts`     |

---

## Setup

```powershell
git clone <this-repo>
cd ytauto
npm install
npx playwright install chromium
pip install edge-tts          # free TTS for the polish stage's narration
npm run build

# Sign into Runway inside the Playwright Chrome profile (one-time)
node dist/cli.js login
```

That `login` command opens a Chrome window pointed at Runway. Sign in there. The profile saves under `runway-profile/` — Playwright reuses it for every future run, so you don't need to log in again.

The Codex CLI must already be logged into a ChatGPT account that has Plus/Pro (free tier doesn't have image-generation entitlement). Test with:

```powershell
codex login status     # should say "Logged in using ChatGPT"
codex features list | findstr image_generation   # should show stable + true
```

---

## Use

### Quick path

```powershell
# 1. Plan
node dist/cli.js new "your idea here" --segments 4

# 2. (Optional) Inspect / tweak the plan
node dist/cli.js show <slug>
notepad projects\<slug>\manifest.json

# 3. Generate everything (artifacts → frames → segments → final.mp4)
node dist/cli.js run <slug>
```

When `run` finishes, your video is at `projects\<slug>\final.mp4`.

### CLI reference

```
ytauto new "<idea>" [--segments N] [--slug <slug>]
ytauto run <slug> [--concurrency N] [--profile <dir>]
ytauto stage <slug> <ideate|artifacts|frames|generate|stitch|polish> [--concurrency N]
ytauto list
ytauto show <slug>
ytauto login [--profile <dir>]
```

- **`new`** — creates `projects/<slug>/` and immediately runs ideate (codex generates plan).
- **`run`** — runs every remaining (non-`done`) stage in order.
- **`stage`** — force-runs a single stage; resets that stage's status to `pending` first.
- **`list`** — print every project + per-stage status icons.
- **`show`** — dump `manifest.json`.
- **`login`** — open the Playwright profile to sign into Runway once.

### Defaults

Defined in [src/types.ts](src/types.ts):

```ts
export const DEFAULT_DEFAULTS: Manifest["defaults"] = {
  model: "seedance-2",
  aspect: "9:16",
  duration: 15,
  resolution: "1080p",   // soft-falls back to 720p when Runway disables it
  upscale: true          // 4K Topaz pass after each generation
};
```

Concurrency: **2** (matches Runway's per-account parallel-generation cap).

To change a default permanently, edit `src/types.ts` and rebuild. To override per-project, edit `manifest.json` after `new`.

---

## Project layout

Every video lives under one folder, fully self-contained:

```
projects/<slug>/
├── manifest.json         # canonical state (every stage reads/writes it)
├── manifest.json.bak     # snapshot at project creation
├── script.md             # human-readable script: title, style+audio bibles, beats, segment prompts
├── artifacts/
│   ├── character-<name>.png    # one per character (2:3 portrait reference sheet)
│   ├── setting-<name>.png      # one per setting (16:9 empty interior)
│   └── prop-<name>.png         # one per key prop (1:1 product-style ref)
├── frames/
│   └── <seg-name>.png          # one per segment (first-frame still, MANDATORY)
├── segments/
│   └── <seg-name>.mp4          # one per segment (Runway output, optionally 4K)
├── debug-out/                  # screenshots when something fails
├── concat.txt                  # ffmpeg input list
└── final.mp4                   # the deliverable
```

### `manifest.json` schema (abbreviated)

```jsonc
{
  "slug": "...",
  "idea": "the original one-liner",
  "title": "Codex-generated title",
  "logline": "Codex-generated one-line summary",
  "hookMoment": "the eye-catching opening shot — executed in segment[0]'s opening 3-5s",
  "storyBeats": ["...", "..."],
  "defaults": { "model": "seedance-2", "aspect": "9:16", "duration": 15, "resolution": "1080p", "upscale": true },
  "style": {
    "era": "contemporary 2020s indie cinema",
    "lens": "35mm anamorphic, shallow DoF",
    "grade": "warm teal-orange, lifted blacks",
    "filmStock": "digital cinema, gentle grain",
    "motion": "handheld realism with sparing slow dolly-ins"
  },
  "audio": {
    "music": "solo piano + warm strings, 70 bpm, lyrical romantic theme in C major",
    "ambient": "soft urban hum, distant traffic, occasional birdsong",
    "sfxMotif": "muted antique pocket-watch tick — recurs each time the locket appears",
    "mixNote": "music underscored, ambient subtle, foreground sound prominent"
  },
  "characters": [
    { "name": "alex", "description": "...", "imagePath": "...artifacts/character-alex.png" }
  ],
  "settings": [
    { "name": "kitchen", "description": "...", "imagePath": "...artifacts/setting-kitchen.png" }
  ],
  "props": [
    { "name": "silver-locket", "description": "...", "imagePath": "...artifacts/prop-silver-locket.png" }
  ],
  "segments": [
    {
      "name": "01-coffee",
      "prompt": "Cinematic 15s clip ...",
      "duration": 15,
      "aspect": "9:16",
      "model": "seedance-2",
      "resolution": "1080p",
      "upscale": true,
      "refs": ["alex", "apartment-kitchen", "silver-locket"],   // names from characters[]/settings[]/props[]
      "firstFrameDescription": "...",         // mandatory — every segment gets one
      "firstFrameImagePath": "...frames/01-coffee.png",
      "videoStatus": "pending|done|failed",
      "videoPath": "...segments/01-coffee.mp4",
      "videoError": "..."                     // present only on failure
    }
  ],
  "stages": {
    "ideate":    { "status": "done", "completedAt": "..." },
    "artifacts": { "status": "done", "completedAt": "..." },
    "frames":    { "status": "done", "completedAt": "..." },
    "generate":  { "status": "running|pending|failed|done" },
    "stitch":    { "status": "pending" }
  },
  "finalPath": "...final.mp4"
}
```

**Idempotency:** every stage checks the manifest before doing work. `artifacts` skips assets that already have an `imagePath`. `frames` skips segments whose `firstFrameImagePath` exists. `generate` skips segments with `videoStatus === "done"` whose `videoPath` exists. `stitch` always re-runs (it's cheap — just an ffmpeg concat).

---

## Pacing and the opening hook (mandatory)

Vertical short-form video lives or dies in the first 3–5 seconds. Every project produced by this pipeline therefore has TWO hard rules baked into ideate:

1. **Mandatory opening hook** — segment 1's first 3–5s must be a kinetic, eye-catching, scroll-stopping moment (one specific physical event — a locket spinning on subway tile, a hand snapping fingers and every city light flicking on, a face emerging from water in extreme macro). Pass 1 of ideate produces a `hookMoment` field describing it; pass 2 places it as the literal opening timestamp block of segment 1. The pipeline validates this — if pass 1 returns a vague or missing `hookMoment`, ideate errors out.
2. **Fast pacing default** — 3–5 timestamp shot blocks of 3–5s each per 15s segment (not 2 of 7-8s). Multiple action verbs across each segment, story progression in EVERY beat, kinetic camera moves (handheld, whip-pan, snap zoom, tracking) favored over locked-off. The slow contemplative beat is allowed once per segment, not as the default.

These show up in `manifest.hookMoment`, in `script.md`, and as the opening lines of `segments[0].prompt`. To override the hook for a project, edit `manifest.hookMoment` AND segment 1's first timestamp block, then re-run.

---

## `@<refname>` reference binding

Every uploaded reference is bound by name. Inside segment prompts, characters / settings / props are cited as `@<name>` (matching the kebab-case names from the outline). Example:

```
[00:00-00:04] Tight close-up on @maya's hand picking up @silver-locket
              from the @subway-platform tile. Slow dolly-in.
```

Under the hood, refs are uploaded to Runway as `<name>.png` (the artifact file is renamed at upload time via in-memory buffer + filename override) so the Seedance backend sees `@maya` bind to `maya.png`, `@silver-locket` bind to `silver-locket.png`, etc. This is dramatically stronger asset-identity binding than free-text "the woman in the rust-red coat".

The first-frame is auto-attached as `@first-frame`. Pass 2 may explicitly cite it in segment 1's opening block to lock the visual start.

This is implemented per the [pexoai `seedance-2.0-prompter` skill](https://github.com/pexoai/pexo-skills/tree/main/skills/seedance-2.0-prompter) — atomic-element mapping (subject identity → asset reference, camera language → text, scene → hybrid, etc.).

---

## Story comprehension (narration + title cards + beat structure + continuity)

Pure visual storytelling can't communicate plot in 60 seconds with multiple cuts — even with great cinematography, viewers experience 4 cool unrelated shots, not a story. The pipeline solves this on four axes:

1. **TTS narration over the video.** Pass 1 of ideate emits a `narrationScript` paced to the total video length (~2 words/second of footage). The polish stage generates this as TTS via [edge-tts](https://github.com/rany2/edge-tts) (free, Microsoft Azure neural voices, no API key) and mixes it into `final.mp4`, ducking the Seedance music to ~30%. This carries the "who/what/why/stakes/payoff" that visuals alone can't.
2. **On-screen title + location cards.** Each segment can have a `locationCard` field (`"PENTHOUSE • FLOOR 87"`, `"ROOFTOP — 12s LEFT"`) that the polish stage burns onto the bottom-left for ~3 seconds at the start of the segment. The whole video can also have a project-level `titleCard` that replaces segment 1's card to introduce the piece. Tiny text overlay, enormous orientation lift.
3. **Explicit beat structure.** `storyBeats` is now `[{function, description, locationCard}]` where `function` is `setup` / `inciting` / `rising` / `climax` / `resolution`. Pass 2 reads the function and shapes shots accordingly — setup segments are character-introductions with held shots and lower spectacle; climax segments are maximum-density VFX peaks; resolution segments anchor on character reaction. The visual rhythm across the 4 segments is what makes the stitched video feel like a story instead of 4 trailer shots.
4. **Continuity bridging between segments.** Pass 2 is told to write each segment so segment N's last block ends in a pose/composition that segment N+1's `firstFrameDescription` deliberately picks up from. Cuts read as continuous time instead of hard jumps.

The narration alone handles ~60% of the comprehension lift; cards add ~20%; beat structure + continuity carry the visual storytelling itself for ~20%. All four together are what make a 1-min multi-segment video actually communicate.

To disable any of these: edit `manifest.defaults`. `narrate: false` skips TTS+mix. `titleCards: false` skips the drawtext overlay. The polish stage no-ops if both are off.

To change voice: `manifest.defaults.narrationVoice` accepts any [edge-tts voice ID](https://github.com/rany2/edge-tts#changing-voices) (e.g. `"en-US-GuyNeural"` for male, `"en-US-DavisNeural"`, `"en-GB-SoniaNeural"`, etc.).

---

## How coherence is enforced (style + audio + identity)

The single biggest threat to a stitched multi-segment video is **drift** — the character's hair color shifts, the music genre changes between clips, the grade jumps from warm to cold, the apartment is suddenly a different layout. The pipeline fights this on three axes:

1. **Style bible** — `manifest.style = { era, lens, grade, filmStock, motion }` is generated once in pass 1 of ideate. The composition step automatically prepends a `Style: <era>; <lens>; <grade>; <filmStock>; <motion>.` line to **every** segment prompt, identical text every time. So all 4 clips share one look.
2. **Audio bible** — `manifest.audio = { music, ambient, sfxMotif, mixNote }` works the same way. Seedance 2.0 generates audio per-clip from the prompt; by feeding the same `music` and `ambient` strings to every clip, the four audio tracks sound like one continuous bed when stitched. The `sfxMotif` is a recurring leitmotif (a ticking watch, a wind chime) that ties beats together.
3. **Verbatim character descriptors** — every character has a 50–90 word identity block (age, ethnicity, eyes, hair, complete clothing, distinguishing marks). Whenever a segment references that character, the EXACT SAME description is prepended to the prompt — never paraphrased. Same string in → same face out (within Seedance's identity-stability range).

Pass 2 of ideate is told NOT to include these descriptions in its segment prompts. It writes only the action/camera/audio field-card. The pipeline does the prepending after the fact. This is what makes the design retry-safe: edit a character description in the manifest, and every segment's prompt updates automatically on the next stage run.

The same bibles also seed the artifact and first-frame stages: artifact prompts inherit `lens` + `grade` hints, and first-frame prompts inherit the full style cue plus per-kind preservation clauses for character / setting / prop refs.

### Hard 3500-character cap

Runway's prompt textarea is capped at 3500 characters. After composition, every segment prompt is validated against this. If any segment overshoots (because pass 2 was too verbose), the pipeline retries pass 2 up to 2 more times with feedback like *"segment X was 3812 chars after auto-prepending ~900 chars of style/audio/character; tighten every base prompt to ≤2500 chars."* If 3 attempts all fail, ideate errors out and tells you which segment broke. A defensive truncation also lives in `runway.ts → fillPrompt()` so a manually-edited manifest can never exceed the limit at submit time.

### Artifact critique loop

After each artifact is generated, codex (gpt-5.5 vision input via `-i <png>`) scores the result 1–10 against the original descriptor — checking age, ethnicity, eye color, hair, clothing top-to-bottom, distinguishing marks, etc. Score below 7 triggers ONE regeneration with concrete fix-this feedback. This catches the "wrong ethnicity" / "missing engraving on the locket" failures that would otherwise silently poison every downstream segment.

To turn it off (e.g. when iterating quickly): edit `src/stages/artifacts.ts` and pass `critique: false` in `ArtifactsOptions`, or let it run — it adds ~30s per artifact.

### Mandatory first frames

Every segment gets a first-frame still rendered by gpt-image-2 from the segment's `firstFrameDescription`, conditioned on the segment's character + setting + prop reference images simultaneously. The frame is then attached to Runway alongside the same artifact refs, so each video starts visually anchored. Pass 2 of ideate refuses to emit `firstFrameDescription: null` — every segment is forced through this anchor.

If you genuinely want a segment to start mid-motion with no anchor, you can manually clear `firstFrameDescription` in the manifest and delete `firstFrameImagePath`; the frames stage will skip it.

---

## Editing between stages

The whole point of the manifest-driven design is that you can intervene between stages.

- **Don't like the script?** Edit `segments[i].prompt`, then `ytauto run <slug>` will pick up where it left off. Keep the result ≤3500 chars.
- **Want a segment shorter?** Change `segments[i].duration` to 4-15.
- **Want one specific segment in 16:9 but the rest in 9:16?** Change just that segment's `aspect`.
- **Want to swap a generated character image for one you drew yourself?** Drop your file at `artifacts/character-<name>.png`, set `characters[i].imagePath` accordingly. The next run will use it as a reference.
- **Want to swap a prop?** Same pattern — `artifacts/prop-<name>.png` + `props[i].imagePath`.
- **Want to globally re-grade everything?** Edit `manifest.style.grade` (and/or `lens`, `era`, etc.). Then `ytauto stage <slug> ideate` is NOT needed — the bibles are only re-applied during fresh ideate. To propagate a manual style edit to existing segment prompts, you'll need to manually edit the `Style: ...` line at the top of every segment's prompt, OR delete the segments and re-run ideate.
- **Want different music across the whole project?** Edit `manifest.audio.music` and re-edit each segment prompt's `Music:` line, or simpler — delete `manifest.segments` + the `ideate` stage status, and re-run ideate.
- **Want to skip a first-frame for a specific segment?** Set its `firstFrameDescription` to empty/missing **and** delete `firstFrameImagePath`. The frames stage will skip it. (Default behavior is to force one for every segment.)
- **Disable the Topaz upscale for a single segment?** Set `segments[i].upscale: false` and re-run generate (delete the existing mp4 if you want to re-do it).
- **Re-run ideate from scratch?** Delete `manifest.segments[]`, set `manifest.stages.ideate.status = "pending"`, and re-run.

If you change a character / setting / prop `description`, **delete its `imagePath`** so the artifacts stage regenerates the reference image. The critique loop will re-score the new generation.

---

## How long does it take?

Rough wall-clock per segment, on a typical Runway queue:

| Step                       | Time                |
|----------------------------|---------------------|
| ideate pass 1 (outline)    | ~60-90s (high reasoning) |
| ideate pass 2 (segments)   | ~90-120s (high reasoning) |
| 1 image gen                | ~50-70s             |
| 1 artifact critique pass   | ~25-35s             |
| 1 video gen                | ~18-25 min          |
| 4K upscale                 | ~3-5 min per clip   |
| Download                   | <10s                |
| Stitch                     | <1s                 |

A 1-minute video (4 × 15s segments, ~3 characters + 2 settings + 1 prop = 6 artifacts, parallel-2):

- ideate (2 passes): ~3 min
- artifacts: ~10 min (6 image gens + 6 critiques)
- frames: ~5 min (4 first-frames, multi-ref)
- generate: ~50 min (2 batches of 2)
- stitch: <1s

**~70-90 minutes total**, mostly Runway's queue.

---

## Troubleshooting

### `imagegen: codex exec failed`

Your Codex CLI's `image_gen` tool is gated. Confirm:

```powershell
codex features list | findstr image_generation
```

Should show `stable | true`. If not:
- `codex login` with a ChatGPT Plus/Pro account.
- Free-tier ChatGPT *cannot* drive `image_gen`.

### `Generate not accepted` / nothing in queue after Generate

The script clicks Generate up to 3 times. If all 3 fire `/v1/tasks` with no response **and** no "in queue" text appears in the page body, it gives up. Most common causes:

- **Runway is at concurrency limit for your account** — go cancel pending sessions in the Runway UI and retry.
- **Runway changed the Generate button DOM** — open `projects/<slug>/debug-out/` for the failure screenshots.

### `Reference upload did not complete within 120s`

Runway's S3 upload was slow or failed. Retry. If persistent, shrink the reference PNGs (gpt-image-2 sometimes hits 4 MB+ which is slow to upload).

### `Runway page never became interactive`

The persistent profile cookie expired or Runway is showing a maintenance page. Run `node dist/cli.js login` again to refresh.

### Stitch error: "Non-monotonous DTS"

ffmpeg's `-c copy` requires identical codec/resolution across all clips. If you mixed aspect ratios or durations across segments, the output may have container-level inconsistencies. Easiest fix: re-encode (currently requires editing `src/stages/stitch.ts` to pass `--reencode` true).

---

## Architecture

For internals (why parallelism is non-trivial, how queue detection works, what every stage actually does), see [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## Getting better videos

How to write the idea, edit segment prompts, and tune reference image generation for max consistency and quality — see [PROMPTING.md](PROMPTING.md). Synthesizes Runway/Seedance 2.0 + gpt-image-2 best practices, with templates ready to paste.
