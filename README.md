# ytauto

End-to-end pipeline for generating long-form YouTube videos from a one-line idea, using:

- **codex CLI / GPT-5.5** — script + segment planning.
- **gpt-image-2** (via your ChatGPT subscription, no API key) — character / setting reference images and per-segment first-frame stills.
- **Runway Seedance 2.0** (via Playwright, your unlimited subscription) — actual video generation, up to 2 segments in parallel.
- **ffmpeg** — concat segments into `final.mp4`.

This is a continuation of the [`videogen`](../videogen) Runway driver. ytauto orchestrates everything around it.

## How it works

A *project* is one folder under `projects/<slug>/` representing one final video. Each stage is idempotent — re-running a stage only does the work that isn't already done.

```
projects/<slug>/
├── manifest.json          # all state (re-run safe)
├── script.md              # human-readable script (after ideate)
├── artifacts/             # character + setting reference PNGs
├── frames/                # per-segment first-frame stills (optional)
├── segments/              # one mp4 per segment from Runway
├── debug-out/             # screenshots on failure
└── final.mp4              # final concatenated video
```

### Stages

| stage     | what it does                                                                     |
|-----------|----------------------------------------------------------------------------------|
| ideate    | codex plans the video: title, characters, settings, segments with rough prompts  |
| artifacts | gpt-image-2 generates one reference image per character / setting                |
| frames    | gpt-image-2 generates a first-frame still per segment that requested one         |
| generate  | Runway generates each segment's mp4 (up to 2 in parallel)                        |
| stitch    | ffmpeg concatenates segments into final.mp4                                      |

## Setup

```powershell
npm install
npx playwright install chromium
npm run build
node dist/cli.js login   # sign into Runway in the Playwright Chrome window
```

Pre-reqs already installed on your machine: codex CLI 0.129+ (logged into ChatGPT), Python 3.13+, ffmpeg.

## Use

```powershell
# 1) plan a video from a one-liner. runs the ideate stage immediately.
node dist/cli.js new "a short story about a knight learning to bake bread"

# inspect / edit:
node dist/cli.js show <slug>
# (open projects/<slug>/manifest.json or script.md and tweak prompts before generating videos)

# 2) run remaining stages end-to-end (artifacts -> frames -> generate -> stitch)
node dist/cli.js run <slug>

# or one stage at a time
node dist/cli.js stage <slug> artifacts
node dist/cli.js stage <slug> frames
node dist/cli.js stage <slug> generate
node dist/cli.js stage <slug> stitch

# list projects
node dist/cli.js list
```

`run` only progresses stages whose status is `pending`. To force-rerun a stage, use `stage` (it resets that stage's status first).

## Editing between stages

You're meant to open `manifest.json` between stages and tweak things. Common edits:

- Reword a `segments[i].prompt` after seeing the script.
- Change `segments[i].duration` (4-15s) or `aspect` per segment.
- Set `segments[i].upscale = true` to do a Topaz 4K pass at generation time.
- Add/remove `segments[i].refs` to control which character/setting images are attached.
- Set `firstFrameDescription` to null on segments that don't need a custom first frame.

If you change a character/setting `description`, delete its `imagePath` so the artifacts stage regenerates it.

## Concurrency

Runway allows max 2 concurrent generations per account. The `generate` stage opens 2 tabs in one Chrome and feeds them from the segment queue. Override with `--concurrency 1` for serial.

## Troubleshooting

- **codex exec failed (exit 5)** during artifacts/frames — check `codex login`. The skill needs ChatGPT Plus/Pro with image-generation entitlement.
- **needs_selector_configuration** at generate stage — run `node dist/cli.js login` to verify the Playwright profile is signed in.
- **A segment fails during generate** — re-run `ytauto run <slug>`. The failed segments stay marked failed in the manifest; rerun retries only those.
- **Stitch error "Non-monotonous DTS"** — pass `--reencode` (TODO) or set all segments to the same aspect/resolution. By default ffmpeg uses `-c copy` which requires consistent codec/resolution across clips.
