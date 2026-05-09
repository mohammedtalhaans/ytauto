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
                            ▼
                       final.mp4
```

No API keys for the LLMs/image gen — uses your **ChatGPT subscription** (via the Codex CLI's `imagegen` tool) and your **Runway unlimited subscription** (via a Playwright-driven Chrome). Only paid component is Runway's compute, which you already have.

---

## What you need installed

| Tool                | Why                                                         | Verify with         |
|---------------------|-------------------------------------------------------------|---------------------|
| Node 22+            | run the CLI                                                 | `node --version`    |
| Codex CLI 0.129+    | text generation (ideate) and image generation (gpt-image-2) | `codex --version`   |
| ChatGPT Plus / Pro  | required entitlement for image_gen tool inside Codex        | `codex login`       |
| Runway subscription | actual video generation                                     | `runwayml.com`      |
| ffmpeg              | stitch segments                                             | `ffmpeg -version`   |
| Python 3.x          | (only used internally by Codex CLI image extraction)        | `python --version`  |

---

## Setup

```powershell
git clone <this-repo>
cd ytauto
npm install
npx playwright install chromium
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
ytauto stage <slug> <ideate|artifacts|frames|generate|stitch> [--concurrency N]
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
├── script.md             # human-readable script written by ideate
├── artifacts/
│   ├── character-<name>.png    # one per character
│   └── setting-<name>.png      # one per setting
├── frames/
│   └── <seg-name>.png          # one per segment (first-frame still)
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
      "refs": ["man", "kitchen"],            // names from characters[]/settings[]
      "firstFrameDescription": "...",         // null if no custom first frame
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

## Editing between stages

The whole point of the manifest-driven design is that you can intervene between stages.

- Don't like the script? Edit `segments[i].prompt`, then `ytauto run <slug>` will pick up where it left off.
- Want a segment shorter? Change `segments[i].duration` to 4-15.
- Want one specific segment in 16:9 but the rest in 9:16? Change just that segment's `aspect`.
- Want to swap a generated character image for one you drew yourself? Drop your file at `artifacts/character-<name>.png`, set `characters[i].imagePath` accordingly. The next run will use it as a reference.
- Want to skip a first-frame for a specific segment? Set its `firstFrameDescription` to null **and** delete `firstFrameImagePath`.
- Disable the Topaz upscale for a single segment? Set `segments[i].upscale: false` and re-run generate (delete the existing mp4 if you want to re-do it).

If you change a character/setting `description`, **delete its `imagePath`** so the artifacts stage regenerates the reference image.

---

## How long does it take?

Rough wall-clock per segment, on a typical Runway queue:

| Step           | Time                |
|----------------|---------------------|
| ideate         | ~30-40s             |
| 1 image gen    | ~50-70s             |
| 1 video gen    | ~18-25 min          |
| 4K upscale     | ~3-5 min per clip   |
| Download       | <10s                |
| Stitch         | <1s                 |

A 1-minute video (4 × 15s segments, parallel-2):

- ideate: <1 min
- artifacts: ~5 min (5 image gens)
- frames: ~5 min (4 first-frames)
- generate: ~50 min (2 batches of 2)
- stitch: <1s

**~60-80 minutes total**, mostly Runway's queue.

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
