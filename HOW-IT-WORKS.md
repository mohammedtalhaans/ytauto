# How ytauto works (internals)

This is the deep-dive doc — what every stage actually does, and *why* certain things were built the way they were. It's mostly the lessons from making the Runway browser automation reliable.

If you just want to use the tool, [README.md](README.md) is enough.

---

## Big picture

ytauto is a state machine over a JSON manifest. Each "stage" reads the manifest, does its work, updates the manifest, and stops. Stages are idempotent — re-running only does the work that isn't already recorded as done.

```
src/
├── cli.ts                    # entry; arg parsing; routes to stages
├── manifest.ts               # JSON load/save/slugify; project dir helpers
├── codex.ts                  # spawns `codex exec ...` for text generation
├── imagegen.ts               # spawns `codex exec --enable image_generation -i ...` and extracts base64 PNG from session rollout
├── runway.ts                 # ALL Playwright/Runway interactions
├── pool.ts                   # 2-tab worker pool with submit-stagger + retry
├── types.ts                  # manifest schema + DEFAULT_DEFAULTS
└── stages/
    ├── ideate.ts             # 2-pass codex → outline + segments + auto-composition
    ├── artifacts.ts          # imagegen → ref PNG per character/setting/prop + critique loop
    ├── frames.ts             # imagegen → first-frame PNG per segment (mandatory, multi-ref)
    ├── generate.ts           # warmup + pool → MP4 per segment
    └── stitch.ts             # ffmpeg concat → final.mp4
```

---

## Stage 1: ideate (two passes)

**Input:** the user's one-line idea + `--segments N`.
**Output:** writes the bulk of `manifest.json` (title, logline, story beats, characters, settings, props, style + audio bibles, segments) and a human-readable `script.md`.

Ideate runs as **two sequential codex calls**, both `gpt-5.5` with `model_reasoning_effort=high`. Splitting it lets pass 1 nail down the global plan (which all segments must share) before pass 2 fills in per-segment details — preventing cross-segment drift in style/audio/identity.

### Pass 1 — outline ([`prompts/ideate-outline.md`](prompts/ideate-outline.md))

Renders the template with `{{idea}}` and `{{segmentCount}}`, then calls:

```
codex exec --model gpt-5.5 -c model_reasoning_effort=high \
           --skip-git-repo-check --sandbox workspace-write \
           --output-last-message <tmpfile> -
```

Asks for **strict JSON** matching this shape:

```jsonc
{
  "title": "...",
  "logline": "...",
  "hookMoment": "the eye-catching 3-5s opening — concrete physical event, kinetic, scroll-stopping",
  "storyBeats": ["beat 1 incorporates the hook", "beat 2", "..."],   // one per intended segment
  "characters": [{ "name": "alex", "description": "50-90 word identity block" }],
  "settings":   [{ "name": "apartment-kitchen", "description": "30-60 word setting" }],
  "props":      [{ "name": "silver-locket", "description": "25-50 word prop" }],
  "style": { "era", "lens", "grade", "filmStock", "motion" },   // global style bible
  "audio": { "music", "ambient", "sfxMotif", "mixNote" }        // global audio bible
}
```

The outline JSON is parsed, validated (titles, hookMoment ≥20 chars, beats, style bible, audio bible all required), and stored in the manifest. The bibles are the central trick: they describe ONE coherent look + ONE coherent audio bed that every segment will inherit verbatim. The `hookMoment` is segment 1's mandatory opening — pass 2 places it as the literal first 3–5s timestamp block.

### Pass 2 — segments ([`prompts/ideate-segments.md`](prompts/ideate-segments.md))

Receives the entire pass-1 outline JSON as input plus the segment-duration target. Codex emits one segment per `storyBeats[i]` in order. Each segment is just:

- `prompt` — Seedance field-card with **3–5 timestamp blocks of 3–5s each** (fast pacing default), using `@<refname>` Seedance reference syntax to bind to uploaded assets
- `refs` — names from the outline that appear on screen (characters + setting + props)
- `firstFrameDescription` — REQUIRED, no nulls — a still-frame composition for gpt-image-2 to render
- `duration` — within 5–15s

**Segment 1 is special**: its first timestamp block is required to be the literal `hookMoment` from pass 1, 3–5s long, kinetic. Pass 2 is told to make it visually arresting from frame 1 — never an establishing shot.

**Reference syntax**: every visible asset is cited as `@<name>` inside timestamp blocks (e.g. `Tight close-up on @maya picking up @silver-locket from @subway-platform tile.`). This is the [pexoai `seedance-2.0-prompter`](https://github.com/pexoai/pexo-skills/tree/main/skills/seedance-2.0-prompter) skill's atomic-element pattern: subject identity → asset reference (much stronger than free-text), camera language → text, scene → hybrid (asset + descriptive text).

Critically, pass 2 is told **NOT** to include character/setting/prop descriptions inside the prompt. The pipeline auto-prepends them in the next step. Pass 2 keeps the base prompt tight — under a budget the pipeline calculates so the final composed prompt stays ≤3500 chars.

### Composition — `composeSegmentPrompt()` in [`src/stages/ideate.ts`](src/stages/ideate.ts)

After pass 2 returns, every segment's final Runway prompt is built as:

```
Style: <era>; <lens>; <grade>; <filmStock>; <motion>.
Global audio bed: music — <music>; ambient — <ambient>; SFX motif — <sfxMotif>; mix — <mixNote>.

[<character-name>]: <verbatim 50-90 word identity block>
[<another-character>]: <verbatim>

<the field-card prompt from pass 2, with timestamp blocks and segment-specific Sound:/Music: lines>
```

The style line, the global audio line, and the verbatim character descriptors are **identical across every segment** that includes them. This is what eliminates drift: when Seedance gets the same style+audio+identity strings four times in a row, the four output clips look like one film, not four random renders.

### 3500-char hard limit

Runway's prompt textarea caps at 3500 characters. Composed prompts are validated:

```
for each segment:
  composed = composeSegmentPrompt(...)
  if composed.length > 3500: collect violation
```

If any segment exceeds the limit, pass 2 is **retried** (up to 3 attempts total) with appended instructions like:
*"Previous attempt had segment 'X' at 3812 chars after auto-prepending ~900 chars of style/audio/character blocks. Tighten EVERY segment's base prompt to ≤2500 chars."*

If 3 attempts all fail, ideate throws — you see exactly which segment overshot and by how much.

A defensive truncation also lives in `runway.ts → fillPrompt()` so even a manually-edited manifest can never blow past 3500 at submit time.

### Model + reasoning effort

Both passes use `gpt-5.5` with `model_reasoning_effort=high` (passed via `-c`). The high reasoning is essential for pass 2 — it has to plan timestamp arithmetic, choose camera moves that fit the action density, AND keep the result under a tight character budget. Lower reasoning produces sloppy budget violations.

---

## Stage 2: artifacts

**Input:** `manifest.characters[]`, `manifest.settings[]`, and `manifest.props[]` from ideate.
**Output:** one PNG per asset under `projects/<slug>/artifacts/`.

Three asset kinds, each with a distinct `buildPrompt()` template:

- **character** — full-body reference sheet, 85mm portrait lens feel, neutral standing pose, plain light-grey seamless background, 2:3 portrait
- **setting** — empty interior photograph (no people), 28mm equivalent eye-level, 16:9
- **prop** — product-photo style, 100mm macro lens feel, plain neutral background, 1:1 square

The prompts also inject a hint from the global style bible (`Lens feel: <style.lens>. Tonal palette: <style.grade>.`) so artifacts already match the look the videos will be rendered in.

For each asset whose `imagePath` is missing, [`src/stages/artifacts.ts`](src/stages/artifacts.ts) calls [`src/imagegen.ts`](src/imagegen.ts) — then runs the **critique loop** (next subsection) before accepting the result.

### The critique loop

A wrong-ethnicity, wrong-hair-colour, or missing-engraving artifact will silently corrupt every downstream segment that references it (because frames + segments inherit the artifact's appearance). To catch this before it propagates, every freshly generated artifact is scored by codex BEFORE we move on.

```
generate image
critique:
  spawn `codex exec -m gpt-5.5 -c model_reasoning_effort=medium -i <generated.png> -`
  prompt: "Compare image to descriptor; checklist for kind=character is age/ethnicity/eyes/hair/clothing/distinguishing/pose/background. Output JSON {score:1-10, issues:[...]}"
if score < 7:
  log + delete the rejected PNG
  rebuild prompt with appended: "Fix these specific issues from the previous attempt: <issues joined>."
  generate ONCE more, accept the result
else:
  accept
```

Codex with `-i <png>` attaches the image as vision input, so the model can actually see what was produced. We use medium reasoning here — full high is overkill for a checklist comparison, and it'd nearly double the artifact-stage runtime.

The critique soft-fails open: if codex itself errors, the image is accepted as-is and we log a warning. Worst case, we lose the safety net for that one artifact.

To disable the critique entirely (e.g. while debugging) pass `critique: false` in `ArtifactsOptions`. Default is on.

### imagegen.ts — calling gpt-image-2 without an API key

This is the trickiest non-Runway part. The Anthropic-style "skill" `gpt-image-2` from agentspace-so/agent-skills is a bash wrapper around Codex CLI. We re-implemented it in Node.

**The Codex CLI exposes an `imagegen` tool** behind the `image_generation` feature flag. When that tool runs, the generated image is written *as a base64 string* into the rollout JSONL file the CLI keeps under `~/.codex/sessions/YYYY/MM/DD/`. There's no direct file output.

So our flow is:

```
1. Snapshot ~/.codex/sessions/ (set of rollout-*.jsonl paths)
2. Spawn `codex exec --skip-git-repo-check --sandbox read-only --color never \
                    --enable image_generation [-i <ref>]... -`
   feeding "Use the imagegen tool to generate the image for the following request..."
3. Wait for codex to exit
4. Diff the sessions dir → find new rollout-*.jsonl files
5. Scan each line of each new file for a JSON-quoted base64 blob ≥ 200 chars
   that starts with PNG / JPEG / WebP magic bytes
6. base64-decode the largest match → write to <outPath>
```

That's why image gen takes ~50-70s per call: most of the time is the LLM internally thinking about the image, then encoding the result.

**Two non-obvious flags:**
- `--enable image_generation` is required — the tool is feature-flagged.
- `--ephemeral` must NOT be passed — ephemeral sessions don't persist the rollout file we need to read.

### Plan requirement

If `codex login` is on a free-tier ChatGPT account, Codex returns *"I can't generate images in this session because the built-in image_gen tool is not available"*. The wrapper detects "no image payload found" and throws. **You need ChatGPT Plus or Pro.**

---

## Stage 3: frames

**Input:** every segment in the manifest (each has a mandatory `firstFrameDescription` from ideate pass 2) + the matching character / setting / prop reference PNGs.
**Output:** one PNG per segment under `projects/<slug>/frames/`.

Same `imagegen.ts` mechanism. The difference: we pass **all** referenced artifacts as `-i` flags simultaneously — characters AND settings AND props — so Codex's `imagegen` does multi-image-to-image composition.

The constructed prompt has four parts:

1. **Per-image role labels** — `Image 1: character reference — alex / Image 2: setting reference — apartment-kitchen / Image 3: prop reference — silver-locket`. gpt-image-2 reads these as explicit role tags for each input.
2. **The composition instruction** — verbatim `firstFrameDescription` from the manifest.
3. **Per-kind preservation clauses** — split by ref kind:
   - characters: *"Preserve from the character reference(s) (alex): face, hair, clothing, body proportions — exactly. Do not redesign the character."*
   - settings: *"Preserve from the setting reference(s) (apartment-kitchen): room layout, furniture placement, lighting direction, color palette — exactly."*
   - props: *"Preserve from the prop reference(s) (silver-locket): exact shape, material, colour, engravings or marks — pixel-faithful. The same physical object must appear."*
4. **Style-bible match** — `Match the global look: <lens>. Grade: <grade>. Stock: <filmStock>.` So the first frame already inherits the project's grade and lens feel.

Frames are now MANDATORY — pass 2 of ideate refuses to emit `firstFrameDescription: null`, so every segment gets one. The first-frame is then attached to Runway alongside the artifact refs at generate time, so the video starts visually anchored.

If you genuinely want a segment to start in motion (no anchored first frame), manually edit the manifest to set `firstFrameDescription` to empty/missing AND delete `firstFrameImagePath` — the frames stage will skip it.

---

## Stage 4: generate (the hard part)

This is where 80% of the engineering went. We're driving Runway's web UI via Playwright on a persistent Chrome profile.

[`src/stages/generate.ts`](src/stages/generate.ts) launches a single `BrowserContext` (persistent profile under `runway-profile/`), warms it up, and hands off to `runPool` which manages the worker tabs.

### `runPool` ([src/pool.ts](src/pool.ts))

```
queue = [pending segments]
earliestSlotMs = 0           // global "next allowed Generate-click time"

for each worker (concurrency=2):
  while queue.length:
    job = queue.shift()
    pick:
      acquireSubmissionSlot()   # wait until earliestSlotMs, then push it +30s
      page = context.newPage()
      try { runJob(page, job) } catch retry up to 2x with fresh page
      page.close()
```

Two workers run concurrently. They share the same Chrome context (same login). Each pulls jobs off the queue until empty.

The 30s `submitGapMs` exists because Runway's frontend gets confused if two Generate clicks land within seconds of each other from the same account — the second one silently doesn't queue. Staggering by 30s makes Runway treat them as distinct submissions and they both end up running in parallel server-side.

### `launchContext` warmup

Empirically, the FIRST tab opened on a freshly-launched persistent context can't reliably submit a Generate — Runway's React doesn't fully hydrate before our click goes out. So before any worker runs, we open one throwaway page, navigate, wait for `networkidle` + 15s, close it. That warms cookies / JWT / asset cache, and subsequent workers find a "warm" context.

### `runJob` ([src/runway.ts](src/runway.ts))

For each segment:

1. **`navigateUntilReady(page, generationUrl)`** — `page.goto`, wait for `networkidle`, sanity-check that the prompt textbox or the "Custom" sidebar button is visible. If not, reload + retry up to 4 attempts. On attempt 2+, force-navigate to the team-specific URL `/video-tools/teams/<slug>/ai-tools/generate?tool=video&mode=tools`. Catches the case where Runway hangs on the `/home` redirect.
2. **`openCustomVideoTool(page)`** — click the "Custom" tab if the prompt box isn't already visible. Uses a 4-attempt retry with last-ditch hard navigation.
3. **`configureModel / configureAspect / configureDuration / configureResolution`** — open the dropdown via `aria-label='…'`, click the option via `getByRole('option', {name: …})`. Each one early-returns if the trigger button's text already shows the desired value (avoids clicking dropdowns unnecessarily).
4. **`uploadReferences(page, refs)`** — refs are `{name, path}` pairs. Each file is read into a Buffer in memory and uploaded via `setInputFiles({name: '<refname>.png', mimeType: 'image/png', buffer})` so the file lands at the Seedance backend with the bare ref name. This is what makes the `@<refname>` syntax in the segment prompt actually bind — without the rename, files would arrive as `character-leo.png` and `@leo` wouldn't match. The first-frame is included as `@first-frame`. After upload kicks off, poll the page body for `IMG_<n>` thumbnail labels until count ≥ refs.length **and** no "Started uploading…" toast is showing — clicking Generate before uploads commit silently breaks the queue submission. Timeout 120s.
5. **`fillPrompt(page, prompt)`** — focus the prompt contenteditable, select-all + delete (clear stale state from previous tab), then `fill()`.
6. **`clickGenerateAndConfirm(page)`** — see below.
7. **`waitForGenerationComplete`** — passive poll the page body every 60s for absence of "in queue / generating" text **AND** presence of "upscale / download / 4K.mp4" text. Two consecutive passes needed (avoid transient flicker). Up to 60 min.
8. **(if `upscale: true`)** **`clickUpscale + waitForUpscaleComplete`** — click the "4K" button next to the latest output card, then click "Upscale to 4K with Topaz AI". Wait until body says `4K.mp4` and a download button is visible.
9. **`downloadVideo(page, outputDir, jobName)`** — find the download icon at the lower right of the latest output, click, capture the Playwright `download` event, save as `<jobName>.mp4`.

### Click-Generate retry — the painful one

`clickGenerateAndConfirm` was the single hardest piece to make reliable. The two complications:

**(a)** Runway sometimes silently doesn't queue a Generate click. The button click registers (Playwright doesn't error), but no `/v1/tasks` POST goes out and the page state never transitions. We never figured out the deterministic root cause — likely some React-state-not-yet-committed timing issue.

**(b)** The "in queue" text doesn't always render in the Playwright tab even when the submission was actually queued. Body inspection is unreliable.

The robust strategy that finally works:

```
listen for `POST /v1/tasks` response on the page
click Generate
within 30s:
  if isBlocked(body): screenshot + return false  // explicit error
  if hasActiveText(body): return true            // UI confirmation
  if /v1/tasks response arrived:
    if status >= 400: log + screenshot + retry
    if status 200: parse task.id, return true
    
if no signal after 30s: click again (up to 3 attempts total)
if all 3 attempts produce no signal: screenshot + return false
```

The `/v1/tasks` 200 response **is** the canonical queue-submission signal. URL change is an unreliable signal (refs can create sessionId-bearing URLs *before* the click). Body text is an unreliable signal (UI doesn't always update). Network response is reliable.

### Soft-fallback: 1080p disabled

Runway disables `1080p` for some `model + duration + aspect` combinations (e.g. Seedance 2.0 + 15s + 9:16 force-caps at 720p). Our `pickRoleOption` detects `aria-disabled="true"` on the resolution option and throws `OptionDisabledError`. `configureResolution` catches that and just keeps the currently-selected resolution. The script logs a warning but keeps going.

### Failure recovery: pool retries

If `runJob` throws — page hung, click never registered, upload timed out, anything — `pool.ts` opens a fresh page and tries again, up to 2 attempts per job. Most transient Runway flakiness recovers on retry 2.

---

## Stage 5: stitch

[`src/stages/stitch.ts`](src/stages/stitch.ts) writes a `concat.txt` with one `file '<absolute path>'` line per segment, then runs:

```
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy final.mp4
```

`-c copy` is stream copy (no re-encode). Fast (<1s) but requires every segment to share the same codec, resolution, framerate. For a single project that's always true (Runway exports identical specs), so we don't re-encode. If you mix aspect ratios within one project, you'd need to add a `--reencode` flag (currently TODO — would force `-c:v libx264 -c:a aac -pix_fmt yuv420p`).

---

## State machine semantics

`Manifest.stages[name].status` ∈ `pending | running | done | failed | skipped`.

`run` walks `STAGE_ORDER` and runs every stage whose status isn't `done`. After a stage runs successfully it sets the status to `done` with a `completedAt` timestamp. Failure sets `failed` with an `error` message.

`stage` resets the named stage's status to `pending` first, so it always runs even if previously marked done.

The manifest is the **single source of truth**. If you delete `final.mp4`, `stitch` will rebuild it on next run (because `stitch.ts` doesn't currently check `done` to skip — actually it does check `stages.stitch.status`, but it's still cheap to redo). If you delete a `segments/<name>.mp4`, `generate` will re-do that one segment because its `videoStatus === "done" && existsSync(videoPath)` check fails.

---

## Persistent profile lifecycle

`runway-profile/` is a normal Chromium user-data-dir. It holds:

- Login cookies for Runway
- `localStorage` (Runway's session preferences)
- IndexedDB (probably some draft state)
- Cache

You sign in once via `node dist/cli.js login`. That writes the auth cookies. Every future `node dist/cli.js run …` reuses them. If Runway invalidates the session (long inactivity, password change, IP shift), `navigateUntilReady` will detect it via `isSignedIn(page)` and the worker will fail with `login_needed` — re-run `login` to refresh.

The profile is gitignored, so cloning the repo gives you a fresh empty profile every time.

---

## Why concurrency=2 and not more

Runway caps active generations per account at 2 (for the user's plan). Submitting a 3rd while 2 are running gets the `please wait for your last generation to complete` block message, which our `isBlocked()` detects and surfaces. `concurrency: 2` matches the cap exactly — pool keeps both slots saturated until the queue drains.

If your account has a different cap, override:

```powershell
node dist/cli.js run <slug> --concurrency 1
```

---

## Lessons (in case you ever debug Runway automation)

1. **`/v1/tasks` 200 is the only canonical queue signal.** Don't trust URL changes, body text, or button states.
2. **Reference uploads are async S3 uploads** — wait for the thumbnails to render *and* the "Started uploading" toast to clear before clicking Generate.
3. **First click on a fresh persistent context is unreliable.** Warm the context with a throwaway page first.
4. **The "Generate" button can no-op silently.** Always retry up to N times listening for the `/v1/tasks` response.
5. **Stagger concurrent submissions by ~30s.** Two Generate clicks within seconds of each other from the same account confuses Runway's frontend; the second silently doesn't queue.
6. **Runway gates resolution by model+duration+aspect.** Detect `aria-disabled` on dropdown options and soft-fall back to whatever's currently selected.
7. **Position-based DOM heuristics need a 1920×1080 viewport.** The download/upscale buttons are at bottom-right of the latest-output card — their absolute coordinates depend on viewport width.
8. **Use `channel: "chrome"`, not bundled Chromium.** Less bot-detection friction.
