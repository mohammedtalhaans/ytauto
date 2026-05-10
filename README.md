# ytauto

End-to-end pipeline that turns a one-line idea into a finished, multi-segment YouTube video — fully automated.

```
"a 30-second monsoon-night romance in 1995 Mumbai..."
                            │
              ▼ ideate pass 1 (codex / gpt-5.5 high)
     outline: title, hook, story beats with function tags,
     narration script, location cards, characters, settings,
     props, style bible, spectacle hints
                            │
              ▼ ideate pass 2 (codex / gpt-5.5 high)
     per-segment Seedance prompts: 3-5 timestamp blocks,
     dense scene description, 6-10 SFX events with character +
     spatial position, MANDATORY first-frame AND last-frame
     descriptions, @<refname> binding syntax, NO music line
     (pure diegetic/foley audio), validated ≤3500 chars
                            │
                ▼ artifacts (gpt-image-2 via ChatGPT Plus)
     one ref PNG per character + setting + prop,
     each scored by codex vision critique → regen once if <7/10
                            │
                ▼ frames (gpt-image-2, multi-ref)
     first-frame AND last-frame PNG per segment,
     last-frame REUSED across cuts when description matches
     next segment's first-frame (continuity bridging)
                            │
                ▼ generate (Runway Seedance 2.0 via Playwright)
     one MP4 per segment, up to 2 in parallel,
     refs uploaded as bare <name>.png so @<name> binds,
     start↔end frame interpolation, 4K Topaz upscale
                            │
                ▼ stitch (ffmpeg concat -c copy)
                            │
              ▼ polish (ffmpeg + edge-tts)
     • Generate TTS narration via Microsoft Azure neural voices
     • Generate per-word subtitle cues, merge to phrase-level
     • Burn synced captions (bottom-center) + location cards
       (top-left) onto each segment
     • Duck Seedance audio under narration and mix
                            │
                            ▼
                       final.mp4 + final.raw.mp4
                       narration.mp3 + narration.vtt + narration.ass
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

### Prerequisites checklist

Before cloning, make sure you have these accounts/tools (all are linked in the table above):

- [ ] **ChatGPT Plus or Pro** subscription. Free-tier ChatGPT cannot drive the `image_gen` tool inside Codex CLI — the pipeline will fail at the artifacts stage. Upgrade if you don't have it.
- [ ] **Runway unlimited subscription**. Plan-tier matters for the per-account concurrent-generation cap (defaults to 2 — you can override with `--concurrency`). The pipeline drives Runway's web UI, not the API; no API key needed but you must be able to log in normally.
- [ ] **Codex CLI 0.129+** installed and logged into the ChatGPT Plus/Pro account: `codex --version`, `codex login`, then `codex login status` should say "Logged in using ChatGPT".
- [ ] **Node 22+, ffmpeg, Python 3.x** on your PATH.

Verify the image-gen feature is unlocked:

```powershell
codex features list | findstr image_generation     # should show: stable | true
```

If that line is missing or shows `false`, you're either not logged in or your ChatGPT account is on free-tier — fix that before continuing.

### Install + first run

```powershell
git clone <this-repo>
cd ytauto
npm install
npx playwright install chromium
pip install edge-tts          # free TTS for the polish stage (no API key needed)
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
# 1. Plan — codex generates the outline + per-segment Seedance prompts
node dist/cli.js new "your idea here" --segments 2     # 2 × 15s = 30s
# OR
node dist/cli.js new "your idea here" --segments 4     # 4 × 15s = 60s

# 2. (Optional) Inspect / tweak the plan
node dist/cli.js show <slug>
notepad projects\<slug>\script.md             # human-readable summary
notepad projects\<slug>\manifest.json         # canonical state — edit anything here

# 3. Generate everything (artifacts → frames → segments → stitch → polish)
node dist/cli.js run <slug>
```

When `run` finishes, your video is at `projects\<slug>\final.mp4`.

### Tips for writing a good idea

The brief you pass to `ytauto new "..."` is the single highest-leverage input. **Detailed briefs produce dramatically better videos.** Cover these in 3-6 sentences:

- **Setting** — era, location, time of day, weather. *"1995 Mumbai during a city-wide blackout"* not *"a city"*.
- **Characters** — name, age, ethnicity, occupation, what they're wearing. *"28-year-old Aanya, a graphic designer in a faded teal cotton sari"* not *"a woman"*.
- **The central image / hook** — the one visually arresting moment that makes the video work. *"the entire skyline cascades into darkness leaving only their two flickering candle clusters visible"*.
- **Aesthetic** — lens, grade, motion philosophy, era reference. *"warm tungsten-amber grade with a teal monsoon sky, Super 16mm grain, intimate handheld with shallow depth-of-field"*.
- **Audio direction** — the score / SFX feel you want. *"sparse Indian classical — harmonium drone, light tabla rain rhythm"*. (Note: Pass 2 doesn't write a music line into the prompt — Seedance generates pure foley/SFX. Use this brief description for the human-readable bible only.)
- **Emotional thesis** — the one-line "what's this about". *"The romance is not declaration but recognition: two strangers each doing one small beautiful thing in the dark, and seeing the other doing it too."*

For more detailed tips (per-stage prompt locations, weak-vs-strong block examples, Seedance vocabulary that works), see [PROMPTING.md](PROMPTING.md).

### Example briefs that produced strong outputs

```
"a 30-second monsoon-night romance in 1995 Mumbai during a city-wide
 blackout. 28-year-old Aanya, a graphic designer in a faded teal
 cotton sari, lights twelve clay diyas... [continued for 200 words]"

"a 30-second cybernetic samurai assassin infiltrates a holographic
 Tokyo penthouse to retrieve a stolen memory crystal, fighting through
 corporate guards with a plasma katana — 4 scenes, kinetic neo-noir
 cyberpunk"

"a 30-second educational infographic explainer for an audience who
 knows nothing about hedge funds — what they are, who can invest, how
 they make money..."
```

### Re-running and iterating

Stages are **idempotent**. If a stage fails or you want to redo one:

```powershell
# Force-run a single stage (resets its status to pending first)
node dist/cli.js stage <slug> ideate
node dist/cli.js stage <slug> artifacts
node dist/cli.js stage <slug> frames
node dist/cli.js stage <slug> generate    # picks up where it failed; skips done segments
node dist/cli.js stage <slug> stitch
node dist/cli.js stage <slug> polish      # re-burn captions/cards or regenerate TTS

# Or just `run` again — it skips stages that are already `done`
node dist/cli.js run <slug>
```

To completely redo something:
- **Redo a single artifact**: delete its `.png` AND its `imagePath` in the manifest, then `stage artifacts`.
- **Redo a single segment's video**: delete its `segments/<name>.mp4` AND set `videoStatus: "pending"` in the manifest, then `stage generate`.
- **Redo the polish (e.g. new narration)**: delete `narration.mp3` + `narration.vtt` + `narration.ass`, then `stage polish`. (`final.raw.mp4` is the canonical pre-polish source — polish always reads from it, so re-running won't accumulate burned-in text.)

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
├── manifest.json              # canonical state (every stage reads/writes it)
├── manifest.json.bak          # snapshot at project creation
├── script.md                  # human-readable script: title, narration, hook, beats, prompts
├── artifacts/
│   ├── character-<name>.png        # one per character (2:3 portrait reference sheet)
│   ├── setting-<name>.png          # one per setting (16:9 empty interior)
│   └── prop-<name>.png             # one per key prop (1:1 product-style)
├── frames/
│   ├── <seg-name>.png              # first-frame for each segment
│   ├── <last-seg-name>-last.png    # last-frame for the FINAL segment only
│   │                               # (non-final segments' lastFrame = next segment's
│   │                               # firstFrame file, no extra gen)
├── segments/
│   └── <seg-name>.mp4              # one per segment (Runway output, optionally 4K)
├── concat.txt                  # ffmpeg input list for stitch
├── final.raw.mp4               # raw stitch output, snapshotted on first polish run
├── final.stitch.mp4            # transient working copy used by polish (cleaned up)
├── narration.mp3               # TTS audio from edge-tts
├── narration.vtt               # phrase-level WEBVTT for human inspection
├── narration.ass               # ASS-format subtitle file ffmpeg burns into video
├── final.mp4                   # the deliverable (with captions + cards + narration)
├── debug-out/                  # Runway/Playwright screenshots when something fails
└── run.log                     # full timestamped log of the most recent run
```

### `manifest.json` schema (abbreviated)

```jsonc
{
  "slug": "...",
  "idea": "the original one-liner",
  "title": "Codex-generated title",
  "logline": "Codex-generated one-line summary",
  "titleCard": "MUMBAI BLACKOUT • 1995",        // optional global card on segment 0
  "hookMoment": "the eye-catching opening shot — executed in segment[0]'s opening 3-5s",
  "narrationScript": "60-130 word continuous TTS script paced ~2 words/second; spoken by polish stage",
  "spectacleHints": ["Segment 1: ...", "Segment 2: ..."],
  "storyBeats": ["...", "..."],                  // descriptions only; function/locationCard live on segments
  "defaults": {
    "model": "seedance-2",
    "aspect": "9:16",
    "duration": 15,
    "resolution": "1080p",                       // soft-falls back to 720p when Runway disables it
    "upscale": true,                             // 4K Topaz pass after each generation
    "narrate": true,                             // polish stage mixes TTS narration into final.mp4
    "narrationVoice": "en-US-AriaNeural",        // any edge-tts voice id
    "titleCards": true                           // polish burns segment locationCards on-screen
  },
  "style": {
    "era": "contemporary 2020s indie cinema",
    "lens": "35mm anamorphic, shallow DoF",
    "grade": "warm teal-orange, lifted blacks",
    "filmStock": "digital cinema, gentle grain",
    "motion": "handheld realism with sparing slow dolly-ins"
  },
  "audio": {                                     // documentation only — NOT auto-prepended into prompts
    "music": "(reference for human readability; pass 2 doesn't write music into segment prompts)",
    "ambient": "...",
    "sfxMotif": "...",
    "mixNote": "..."
  },
  "characters": [
    { "name": "alex", "description": "20-30 word identity block", "imagePath": "...artifacts/character-alex.png" }
  ],
  "settings": [
    { "name": "kitchen", "description": "30-60 word setting", "imagePath": "...artifacts/setting-kitchen.png" }
  ],
  "props": [
    { "name": "silver-locket", "description": "25-50 word prop", "imagePath": "...artifacts/prop-silver-locket.png" }
  ],
  "segments": [
    {
      "name": "01-coffee",
      "prompt": "[Style + character descriptors auto-prepended] + base prompt with 3-5 timestamp blocks + SFX line + negatives footer",
      "duration": 15,
      "aspect": "9:16",
      "model": "seedance-2",
      "resolution": "1080p",
      "upscale": true,
      "beatFunction": "setup|inciting|rising|climax|resolution",
      "locationCard": "TOKYO • 02:14 AM",        // burned by polish stage as top-left text
      "refs": ["alex", "apartment-kitchen", "silver-locket"],
      "firstFrameDescription": "...",            // mandatory — every segment gets one
      "firstFrameImagePath": "...frames/01-coffee.png",
      "lastFrameDescription": "...",             // mandatory — must equal segment[i+1].firstFrameDescription for non-final segments (continuity bridge)
      "lastFrameImagePath": "...frames/02-next.png OR 01-coffee-last.png if final",
      "videoStatus": "pending|done|failed",
      "videoPath": "...segments/01-coffee.mp4",
      "videoError": "..."                        // present only on failure
    }
  ],
  "stages": {
    "ideate":    { "status": "done", "completedAt": "..." },
    "artifacts": { "status": "done", "completedAt": "..." },
    "frames":    { "status": "done", "completedAt": "..." },
    "generate":  { "status": "running|pending|failed|done" },
    "stitch":    { "status": "pending" },
    "polish":    { "status": "pending" }         // TTS narration + caption burn-in
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

## Story comprehension (narration + captions + cards + beat structure + continuity)

Pure visual storytelling can't communicate plot in 30-60 seconds with multiple cuts — even with great cinematography, viewers experience N cool unrelated shots, not a story. The pipeline solves this on five axes:

1. **TTS narration over the video.** Pass 1 of ideate emits a `narrationScript` paced to the total video length (~2 words/second of footage). The polish stage generates this as TTS via [edge-tts](https://github.com/rany2/edge-tts) (free, Microsoft Azure neural voices, no API key) and mixes it into `final.mp4`, ducking the Seedance audio under it to ~30%. This carries the "who/what/why/stakes/payoff" that visuals alone can't.
2. **Synced captions burned into the video.** edge-tts also emits time-coded subtitle cues. Polish merges those into phrase-length chunks, writes them as ASS subtitle data with explicit PlayResY for predictable libass sizing, and burns them onto the bottom-center of each frame as bold white text with black outline. They appear and disappear in sync with the spoken narration — the viewer sees the words being spoken at the moment they're spoken.
3. **On-screen title + location cards.** Each segment can have a `locationCard` field (`"PENTHOUSE • FLOOR 87"`, `"ROOFTOP — 12s LEFT"`, `"MUMBAI BLACKOUT • 1995"`) that the polish stage burns onto the **top-left** for ~3 seconds at the start of the segment (top-left so it doesn't compete with the bottom-center captions). The whole video can also have a project-level `titleCard` that replaces segment 1's card to introduce the piece. Tiny text overlay, enormous orientation lift.
4. **Explicit beat structure.** Pass 1's `storyBeats` includes a `function` tag per beat (`setup` / `inciting` / `rising` / `climax` / `resolution`) which propagates to `Segment.beatFunction`. Pass 2 reads the function and shapes shots accordingly — setup segments are character-introductions with held shots and lower spectacle; climax segments are maximum-density VFX peaks; resolution segments anchor on character reaction. The visual rhythm across segments is what makes the stitched video feel like a story instead of N trailer shots.
5. **Continuity bridging via shared end/start frames.** Pass 2 emits BOTH `firstFrameDescription` AND `lastFrameDescription` per segment. For non-final segments, lastFrame must EQUAL the next segment's firstFrame word-for-word. The frames stage detects this match and **reuses the same PNG file across the cut** so segment N's ending pixels are byte-identical to segment N+1's opening pixels. Combined with Seedance's start↔end frame interpolation (the model is given both endpoints and renders the in-between motion), the cut between stitched segments is invisible at the model level — not just at the prompt level.

To disable any of these: edit `manifest.defaults`.
- `narrate: false` skips TTS narration AND captions (captions are tied to TTS).
- `titleCards: false` skips the top-left location/title card overlay.
- Both off → polish stage no-ops, `final.mp4` is just the raw stitched concat.

To change voice: `manifest.defaults.narrationVoice` accepts any [edge-tts voice ID](https://github.com/rany2/edge-tts#changing-voices) (e.g. `"en-US-GuyNeural"` for male, `"en-US-DavisNeural"`, `"en-GB-SoniaNeural"`, `"en-IN-NeerjaNeural"` for Indian English, etc.).

The polish stage is **idempotent and safe to re-run**: on first run it snapshots the raw stitched output to `final.raw.mp4`, then always reads from `final.raw.mp4` on subsequent runs. This avoids the "burned-in text accumulates across re-runs" bug.

---

## How coherence is enforced (style + identity + audio approach)

The single biggest threat to a stitched multi-segment video is **drift** — the character's hair color shifts between clips, the grade jumps from warm to cold, the apartment is suddenly a different layout. The pipeline fights this on three axes:

1. **Style bible (auto-prepended)** — `manifest.style = { era, lens, grade, filmStock, motion }` is generated once in pass 1. The composition step automatically prepends a tight `Style: <lens>; <grade>.` line to **every** segment prompt, identical text every time. So all clips share one look. (Era and motion live in the human-readable `script.md` but stay out of the prompt — they're already implied by the per-segment camera language.)

2. **Verbatim character descriptors (auto-prepended)** — every character has a tight 20–30 word identity block (age, ethnicity, eyes, hair, clothing top-to-bottom, one distinguishing feature). Whenever a segment references that character, the EXACT SAME description is prepended to the prompt — never paraphrased. Same string in → same face out (within Seedance's identity-stability range). The `@<refname>` upload-bound reference image is the primary identity carrier; the text descriptor reinforces against drift.

3. **Audio approach (SFX-only, NO music)** — Pass 2 does NOT write a `Music:` line. Seedance generates each segment's audio entirely from the SFX list (6–10 specific diegetic events with sound character + spatial position + timestamp) plus implicit ambient. This produces a pure foley/ambient/diegetic track per clip. Cross-segment audio coherence comes from the recurring SFX motif and consistent ambient cues. Music for the final video is the **TTS narration only** — added in the polish stage. (The `manifest.audio` bible from pass 1 stays for human reference in `script.md` but isn't injected into Seedance prompts.)

Pass 2 is told NOT to include character/setting/prop descriptions in its segment prompts. It writes only the action/camera/SFX field-card. The pipeline does the descriptor prepending after the fact. This is what makes the design retry-safe: edit a character description in the manifest, and every segment's prompt updates automatically on the next stage run.

The style bible also seeds the artifact and first-frame stages: artifact prompts inherit `lens` + `grade` hints, and first-frame prompts inherit the full style cue plus per-kind preservation clauses for character / setting / prop refs.

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
- **Want to change the narration?** Edit `manifest.narrationScript`, delete `narration.mp3` + `narration.vtt` + `narration.ass`, and re-run `ytauto stage <slug> polish`. Polish will regenerate TTS + captions and re-burn the final.
- **Want a different voice?** Edit `manifest.defaults.narrationVoice` to any [edge-tts voice ID](https://github.com/rany2/edge-tts#changing-voices). Delete `narration.mp3` to force TTS regeneration, then re-run polish.
- **Want to disable narration / captions / cards?** Set `manifest.defaults.narrate: false` and/or `titleCards: false`. Re-run polish — it'll detect the toggle and produce a clean (un-burned) final.
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

### `Reference upload did not complete within Ns (saw N-1/N thumbnails)`

Runway's S3 upload pipeline was slow. The pipeline **scales the timeout with ref count** (`max(120s, refs × 30s + 60s)` — so 10 refs gets 360s) and accepts `N-1 of N` thumbnails as success (Runway's UI sometimes lags rendering the last one even after server commit). If you still hit this:

- **Re-run the generate stage** — `ytauto stage <slug> generate` skips already-done segments and retries the failed ones. Most upload flakes recover.
- **Reduce ref count for that segment** — edit `segments[i].refs` to drop non-essential refs (settings often duplicate; props that aren't on screen don't need to be there).
- **Shrink the reference PNGs** — gpt-image-2 sometimes produces 4 MB+ PNGs which are slow to upload. Open in any image editor and re-export with quality reduced.

### `Runway page never became interactive`

The persistent profile cookie expired or Runway is showing a maintenance page. Run `node dist/cli.js login` again to refresh.

### Stitch error: "Non-monotonous DTS"

ffmpeg's `-c copy` requires identical codec/resolution across all clips. If you mixed aspect ratios or durations across segments, the output may have container-level inconsistencies. Easiest fix: re-encode (currently requires editing `src/stages/stitch.ts` to pass `--reencode` true).

---

## Architecture

For internals (why parallelism is non-trivial, how queue detection works, what every stage actually does), see [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## Getting better videos

How to write the idea, edit segment prompts, and tune reference image generation for max consistency and quality — see [PROMPTING.md](PROMPTING.md). Synthesizes Runway/Seedance 2.0 + gpt-image-2 best practices, with templates ready to paste.
