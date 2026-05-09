# Prompt, Context & Artifact Engineering for ytauto

How to write **idea inputs**, edit **manifest segments**, and tweak the **per-stage prompt templates** so the pipeline produces the highest-quality, most consistent video possible.

This is a synthesis of current (May 2026) practitioner consensus across:

- Runway's own help center (Seedance 2.0, Gen-4 prompting, Camera Terms guides)
- ByteDance Seedance 2.0 model card + community guides (fal.ai, Replicate, WaveSpeed, Magic Hour, Atlabs, redreamality.com)
- OpenAI's gpt-image-1/2 official cookbook and API docs
- AI-video creator practitioner literature (selfielab, AI Magicx, Blue Lightning, Magic Hour, Cybercorsairs)

If you only read one section, read [TL;DR rules of thumb](#tldr-rules-of-thumb).

> **Pipeline architecture as of v0.2 (May 2026):** ideate now runs as **two passes** with `gpt-5.5` at high reasoning effort.
> Pass 1 produces a global outline (title, story beats, characters, settings, **props**, **style bible**, **audio bible**).
> Pass 2 turns the outline into per-segment Seedance prompts. The pipeline then automatically prepends the style bible, audio bible, and verbatim character descriptors to every segment prompt — so all clips share one look + one audio bed + one character identity, with zero per-segment drift.
> Hard limit: **every final segment prompt is validated ≤3500 chars** (Runway's textarea cap) and defensively re-truncated at submit.
> Artifacts run a **codex critique loop** — the generated PNG is scored by gpt-5.5 against the descriptor; score <7/10 triggers ONE regeneration with feedback.
> First-frame generation is **mandatory for every segment** (no nulls), and includes character + setting + prop refs as multi-image input.

---

## TL;DR rules of thumb

1. **Describe physical reality, not abstract feeling.** "She raises her right hand to her cheek" beats "she feels overwhelmed." The model can't render emotions; it can only render bodies.
2. **One action verb + one camera move per shot.** Compound instructions ("she runs and jumps while the camera orbits and zooms") collapse.
3. **The first 2-3 instructions in your prompt carry the most weight.** Put the most important thing first.
4. **Prompt format for 15s clips: 3-shot timestamp blocks.** `[00:00-00:05] … [00:05-00:10] … [00:10-00:15] …` Seedance reads these as cut points. Prose-style descriptions get rendered as a single take.
5. **Photographic framing language unlocks photorealism.** `"85mm f/1.4, shallow depth of field, soft window light from left"` works. `"stunning, hyperrealistic, 8K"` makes it worse.
6. **Reference images carry identity. Verbatim text descriptors carry identity continuity across calls.** Use both. Always.
7. **Generate refs at `quality=high` and use 16:9 / 2:3 aspect ratios that match your final video aspect.** Cropping a 1024×1024 ref into 9:16 video loses detail.
8. **Lock lighting in the ref. Lock lighting in the prompt. Lock it in post.** Drift across clips is mostly a lighting problem.
9. **The Seedance Generate button has a ~5% silent-fail rate.** ytauto retries 3x — your prompt isn't usually the cause when something doesn't queue.
10. **Topaz upscale is for clean-source video.** Don't add `"film grain"` or `"vignette"` to your Seedance prompt; Topaz reads them as noise and hurts the upscale.

---

## 1. Stage-by-stage: where each prompt lives

| Stage | Prompt source | What you can edit |
|---|---|---|
| `ideate` pass 1 | [`prompts/ideate-outline.md`](prompts/ideate-outline.md) — codex template (gpt-5.5 high) | The outline JSON shape, character/setting/prop description rules, style + audio bible spec |
| `ideate` pass 2 | [`prompts/ideate-segments.md`](prompts/ideate-segments.md) — codex template (gpt-5.5 high) | The Seedance field-card format, timestamp-block rules, character budget |
| `ideate` (per-project) | The `idea` string passed to `ytauto new "<idea>"` | Most leverage is here. Spend time on this. |
| `ideate` (composition) | [`composeSegmentPrompt()` in `src/stages/ideate.ts`](src/stages/ideate.ts) | How the style bible, audio bible, and character descriptors get prepended to each segment's base prompt |
| `artifacts` | Hardcoded prompts + critique in [`src/stages/artifacts.ts`](src/stages/artifacts.ts) | `buildPrompt()` per kind (character / setting / prop), critique threshold |
| `frames` | Hardcoded prompts in [`src/stages/frames.ts`](src/stages/frames.ts) | The multi-ref preservation clauses and style-bible injection |
| `generate` | Each `manifest.json` `segments[i].prompt` | Edit the manifest after `ideate` to override what codex produced — keep ≤3500 chars |

After `ytauto new "..."`, **always read `script.md` and `manifest.json`** before running `ytauto run`. The 30 seconds you spend tuning a segment prompt saves 25 minutes of regeneration.

---

## 2. Writing the idea (input to `ideate`)

The idea you pass to `ytauto new "..."` becomes part of [`prompts/ideate.md`](prompts/ideate.md), and codex produces the per-segment JSON from it. **High-leverage moves:**

✅ **Specify the spine in one line.** Subject, setting trajectory, mood, length. *"a man's morning routine in his city apartment, four 15-second scenes following him from waking up to leaving for work, calm cinematic with natural light"* — already gives codex enough to produce 4 distinct shots.

✅ **Constrain the setting count.** If you say "in a kitchen" and want 4 segments, codex will have to invent variation within one room (which is fine and often more cinematic than 4 different rooms).

✅ **State the mood/genre.** "calm cinematic", "tense thriller", "warm documentary", "noir-lit", "playful upbeat". This propagates into every segment prompt.

✅ **Anchor the era / wardrobe / aesthetic.** "1970s wardrobe and color palette" or "modern minimalist apartment, Scandinavian design" — codex will keep these consistent across segments.

✅ **Mention any motion/camera signature.** "handheld documentary feel" or "locked-off macro shots" — codex bakes this into each segment's prompt.

❌ **Don't write the segments yourself in the idea.** Let codex produce them and edit them in the manifest. The idea is the seed, not the script.

❌ **Don't say "make it good" or "amazing".** Vague quality language doesn't constrain anything.

❌ **Don't mention things Seedance can't do reliably:** complex multi-character interaction, readable on-screen text, brand logos, exact body poses.

---

## 3. Character reference image (gpt-image-2 in `artifacts` stage)

Goal: a single canonical PNG that Seedance treats as the visual identity document for every segment featuring this character.

**What works:**

- Full-body or 3/4-length, front-facing or slight 3/4 turn
- Plain neutral background (white, light grey)
- Flat even lighting (NOT golden hour, NOT dramatic — flat)
- Specific descriptors: age in years, ethnicity + skin tone, eye color, hair color/length/texture/style, complete clothing top-to-bottom, distinguishing marks
- One unique visual identifier (scar, glasses, sleeve tattoo) — this becomes the model's high-salience anchor
- Photorealistic photographic language: `"85mm portrait, soft window light"`

**Template (drop this into `src/stages/artifacts.ts` `buildPrompt('character', asset)`):**

```
Photorealistic full-body character reference sheet.
[gender], [exact age, e.g. "32 years old"], [ethnicity + skin tone].
[eye color]. [hair: color, length, texture, style].
Wearing [complete clothing description, head to toe].
[distinguishing marks or accessories].
Neutral standing pose, front-facing, arms relaxed at sides.
Plain light grey background. Flat even studio lighting, no harsh shadows.
85mm portrait lens feel, sharp focus throughout.
Visible skin pores, fabric texture, fine hair detail.
No motion blur. No text. No watermark. No logos.
Portrait aspect 2:3.
```

**What NOT to do:**

- ❌ Cinematic dramatic lighting in the ref → bakes that exact light direction into the model's identity space, then over-applies elsewhere.
- ❌ Reference shot in a specific environment ("portrait in a forest") → contaminates identity with environment cues.
- ❌ Stylized aesthetic words ("ethereal", "epic", "cinematic"): these compete with photorealism and produce the worst of both.

---

## 4. Setting reference image (gpt-image-2 in `artifacts` stage)

Goal: an environment plate that defines the room/space — to be combined with the character ref for first-frame stills, and attached to Seedance as a setting anchor.

**What works:**

- Wide-to-medium shot (28-35mm equivalent) — gives Seedance reframing room without fish-eye distortion
- No people in the shot (Seedance must populate the space)
- Specific: time of day, light source(s), color temperature, key furniture/props
- Locked diffuse-ish lighting — easier to modulate per segment via prompt later

**Template (replace `buildPrompt('setting', asset)`):**

```
Photorealistic interior photograph of [room type, style, era].
[3-5 specific details: furniture, props, architectural features, materials].
[time of day]. [light source description: e.g. "soft morning light from east-facing window, single warm practical lamp lit"].
Color palette: [2-3 dominant tones].
Medium-wide shot, eye-level, 28mm equivalent.
No people. No figures. No text. No watermark.
Sharp throughout. Clean cinematic feel. 16:9 aspect.
```

**Pro move: state the same lighting in the Seedance prompt later.** If your room ref says `"warm 2700K floor lamp, soft window light from left"`, copy that phrase verbatim into the segment's `prompt` field. This is the single most effective way to keep lighting consistent across the gpt-image-2 → Seedance handoff.

---

## 5. First-frame still (gpt-image-2 multi-ref in `frames` stage)

Goal: a still that shows the character in the setting at the exact moment the video segment begins. This becomes Seedance's Keyframe input.

**Critical pattern: the "preservation clause" structure.**

Every multi-image edit call needs three sentences:

1. What the new image is (the action/composition you want)
2. What must be preserved from each input (face from ref1, room from ref2)
3. Physical realism reinforcement (shadows, scale, no composite artifacts)

**Template (replace the `prompt` arg in `runFrames`):**

```
Image 1: character reference — [character.name]
Image 2: setting reference — [setting.name]

Compose Image 1's character into Image 2's room. Character is [exact pose / position / action for the segment's first frame, e.g., "standing at the kitchen counter, hands resting on the edge, looking down at a coffee cup"].

Preserve from Image 1: face, hair, clothing, body proportions — exactly. Do not redesign the character.
Preserve from Image 2: room layout, furniture placement, lighting direction, color palette — exactly.
Match character's shadow and scale to the room's lighting direction. Photorealistic. No composite artifacts.

Cinematic medium shot. Sharp focus on character. 16:9 aspect.
No text. No watermark.
```

**When `firstFrameDescription` is empty:** skip frame generation for that segment. Seedance will start from a clean prompt-only state, which is fine for transition shots or when you don't want to anchor the start frame.

**Pitfall:** if your character ref was a 1024×1536 portrait and your setting ref was 1536×1024 landscape, gpt-image-2 will pick one aspect or compromise. Specify the **target aspect explicitly** in the prompt — Seedance wants 16:9 (=1792×1024) for the keyframe, since 9:16 keyframes can letterbox.

---

## 6. Seedance 2.0 segment prompt (per-segment in manifest)

This is the prompt Seedance reads when generating each 15s clip. **Edit `manifest.json segments[i].prompt`** for max control.

### Structure

Use the **field-card format** with explicit shot timing:

```
[Style/Era] · [Duration] · [Scene context]

[Character]: [Name + 1-line identity reminder + wardrobe pin]

[00:00-00:05] [Shot size]. [Action — one verb]. [Camera — one move].
   [Environment detail]. [Lighting].

[00:05-00:11] [Shot size]. [Action — one verb]. [Camera — one move].

[00:11-00:15] [Shot size, usually tighter]. [Hold or reaction beat]. [Locked-off or minimal move].

Sound: [ambient layer — source + surface]. SFX: [event @ timestamp].
Music: [genre/mood], enters at 3s, resolves at 14s.
[Dialogue if any: Character delivery: "5-10 words max."]

No text on screen. No subtitles. No captions. No watermarks. No overlays.
No face distortion. No extra hands. Anatomically correct.
No wardrobe changes. No color grade shifts.
Clean image, no film grain, no vignette.
9:16 · 720p · 15s.
```

### Camera vocabulary that maps cleanly

| Term | Behavior |
|---|---|
| `dolly-in` / `push in` | Camera moves toward subject |
| `dolly-out` / `pull back` | Camera retreats |
| `tracking shot` | Camera follows subject laterally |
| `pan left` / `pan right` | Pivot in place, no lateral movement |
| `crane up` / `crane down` | Vertical lift/lower |
| `orbit` | Camera circles subject |
| `handheld` | Organic shake, doc feel |
| `gimbal` | Smooth stabilized movement |
| `locked-off` | Static camera |
| `rack focus` | Focus shifts foreground ↔ background |
| `low-angle upward` / `high-angle down` | Below/above subject |
| `extreme macro` | Tight detail shot |

**Speed modifiers pair cleanly:** `"slow dolly-in, 1-2 feet"`, `"fast whip pan right"`.

**Camera-model naming works:** `"Sony Venice"`, `"ARRI Alexa"`, `"35mm anamorphic"` — the model has learned these aesthetic signatures.

### What Seedance 2.0 is bad at

- Multi-character interaction (>2 characters drifts)
- Readable on-screen text or brand logos
- Exact pose specification (you'll get a plausible pose, not the one you described)
- Compound actions per shot
- Long single takes >10s without cuts (drift accumulates)
- Singing with lyrics

### Negative prompts

Seedance has no negative-prompt field, but **explicit positive constraints at the END of the prompt do work** — particularly for visual artifacts:

```
No text on screen. No subtitles. No captions. No watermarks. No overlays.
No face distortion. No extra hands. Anatomically correct.
No wardrobe changes. No color grade shifts. Clean image, no film grain.
```

Don't stack more than ~3-4 prohibitions; the model has a soft instruction ceiling around 8 total directives.

---

## 7. Audio

Seedance 2.0 generates audio in the same pass as video (`generateAudio: true`, on by default). Three-layer system, max 3 simultaneous.

### Dialogue

- ≤10 words per line
- Wrap in quotes for lip-sync activation: `Character says: "I'll be back by morning."`
- Label emotion BEFORE the line: `she softly whispers "..."` not just the raw text
- **Lock the camera during speech** — no head-movement instructions while dialogue is active, otherwise lip-sync breaks
- Best framing: medium close-up or three-quarter — NOT profile (kills lip-sync), NOT wide (face too small)
- Single speaker is reliable. Multi-character lip-sync is broken.

### Ambient / SFX

- Source + surface anchors audio: `"boots on wet cobblestone"` not `"footstep sounds"`
- Timestamp cues work: `"SFX: thunder crack at 3s"`
- The model auto-infers ambient from visuals — a rain scene generates rain audio without prompting. State explicitly only when you want to ensure or strengthen it.

### Music / BGM

- Genre + mood > technical music terms: `"lo-fi ambient piano"`, `"tense orchestral build"`, `"upbeat indie folk"`
- Fade control prevents abrupt cutoffs against the upscale: `"Music enters at 3s, fades at 14s. Silence holds final 0.5s."`
- Tempo treated as guidance, not locked behavior

### Mix priority

Always state in this exact order:

```
Dialogue prominent, music low, ambient subtle.
```

This single line significantly improves audio mix balance.

---

## 8. Cross-segment continuity

For a multi-segment video where the same character appears across multiple settings, you need three layers of consistency:

### Layer 1: identity anchor (every segment)

Always attach the original character reference PNG to every segment. Don't substitute it with a generated still from a previous clip — that causes cumulative drift, and by clip 4 your character looks different.

In ytauto: `manifest.json segments[i].refs` should include the character's name, which `runGenerate` looks up to find `characters[].imagePath`.

### Layer 2: scene continuity anchor (between adjacent clips)

For chained scenes (clip N's last frame is clip N+1's first frame), extract the last frame of clip N and add it as an extra ref or set it as the keyframe for clip N+1.

ytauto doesn't currently auto-extract last frames. To do this manually:

```powershell
ffmpeg -sseof -0.1 -i segments/01-foo.mp4 -update 1 -q:v 1 frames/01-foo-lastframe.png
# then add this path to segments[1].firstFrameImagePath in the manifest
```

### Layer 3: verbatim descriptor in every prompt

Maintain a **single canonical character descriptor string** (~40-80 words) and copy it into the prompt of every segment. Even minor wording changes cause drift.

ytauto's `ideate` template doesn't enforce this yet — codex tends to abbreviate the character description differently per segment. **Manual tweak:** after `ideate`, copy a single descriptor string and inject it into every `segments[i].prompt`'s opening line.

Example string to inject:

```
[Character]: Mara, 32 years old, South Asian woman, warm medium-brown skin,
light hazel eyes, dark auburn shoulder-length hair parted left, wearing a
fitted charcoal crewneck, dark slim jeans, white canvas sneakers.
```

### Wardrobe pinning

Re-describe clothing in every segment prompt, even if there's a wardrobe-visible reference image. References handle visual geometry; prompt handles semantic constraint. Both layers are required.

Append: `"Do not alter clothing category or primary color."`

---

## 9. Common failure modes (with fixes)

| Symptom | Likely cause | Fix |
|---|---|---|
| **Robotic/flat delivery** | Emotion not specified | Label emotion before dialogue: `"she urgently whispers"`. Add `"natural performance, organic movement"` |
| **Character drift between clips** | Drifting descriptor wording, missing ref attachment | Lock canonical descriptor string. Always attach character ref. Add `"Maintain facial proportions and skin tone throughout"` |
| **Color/tone shift mid-clip** | Multiple style references competing | Single visual anchor. Strip color adjectives from action beat. Add `"consistent color palette, no grade shift"` |
| **Broken/extra hands** | Model uncertainty on extremities | Add `"anatomically correct hands, five fingers"`. Reframe to head shots when hands aren't needed. |
| **On-screen text bleed** | Model leaked text from training | Always include `"No subtitles. No captions. No on-screen text. No watermarks."` |
| **Costume change mid-clip** | Long take >10s + loose conditioning | Stay <10s per take. Add `"Do not alter clothing category or primary color"` |
| **Overcrowded prompt collapse** | >8 simultaneous instructions | One verb + one camera move per shot. Split scenes. |
| **Audio cutout** | Wrong format / overlong reference | MP3 only. Trim to ≤15s. |
| **Face morphing in first 5 frames** | Strong motion + strong identity ref | Start each clip with low-motion. Subtle gestures before complex movement. |
| **Wardrobe drift** | Missing positive constraint | Re-describe clothing in EVERY segment prompt. |
| **Lighting inconsistency across clips** | Unspecified lighting in prompts | Copy the same lighting descriptor string verbatim across all clips in the same setting. Color-match in DaVinci Resolve in post. |

---

## 10. Reusable templates

### Template A: a single 15-second 9:16 portrait clip

```
Cinematic editorial portrait. 15 seconds.

[Character descriptor — 30-50 words, copied verbatim across segments]

[00:00-00:05] Medium shot. [Subject begins action — one verb]. Slow dolly-in.
   [Environment detail]. [Lighting source].

[00:05-00:11] Medium close-up. [Subject continues action — one verb]. Locked-off camera.

[00:11-00:15] Tight close-up. [Subject hold/reaction]. Locked-off, minimal breath movement.

Sound: [ambient: source + surface]. SFX: [optional, e.g., "kettle whistle at 8s"].
Music: [genre/mood], enters at 3s, resolves at 14s.
Dialogue prominent, music low, ambient subtle.

No text on screen, no subtitles, no captions, no watermarks.
No face distortion, no extra hands, anatomically correct.
No wardrobe changes, no color grade shifts. Clean image, no film grain.
9:16 · 720p · 15s.
```

### Template B: a 60-second narrative across 4 segments

For each segment, use Template A but vary:

- **Segment 1 (setup):** wide establishing → medium → close. Establish character + first setting.
- **Segment 2 (development):** medium throughout. Different setting, same character. Match cuts.
- **Segment 3 (turn):** dynamic camera (orbit, dolly, handheld). Different setting.
- **Segment 4 (resolution):** locked-off close-ups. Final beat. Often the most emotional shot.

**For continuity between adjacent segments**, set `segments[i].firstFrameImagePath` to a last-frame extract from `segments[i-1]` (manual ffmpeg one-liner above).

### Template C: dialogue-driven shot

```
Cinematic close-up. 8 seconds. Locked-off camera.

[Character descriptor]

Subject sits at a wooden kitchen table, hands wrapped around a coffee mug.
Eyes glistening, looking just left of camera.
Subject softly says: "It wasn't supposed to end like this."

Lighting: soft morning window light from left, warm 3000K, gentle fill from right.
Sound: low ambient room tone, distant traffic. Music: understated piano, enters at 2s, fades at 7s.
Dialogue prominent, music low, ambient subtle.

No subtitle overlays. No text on screen. No watermarks.
Maintain facial proportions and skin tone. Anatomically correct hands.
Clean image, no film grain.
9:16 · 720p · 8s.
```

---

## 11. Hard limits to remember

| Constraint | Value | Note |
|---|---|---|
| Seedance duration | 4–15s | `auto` lets model infer |
| 9:16 + 15s resolution cap | 720p | 1080p disabled at this combo (ytauto soft-falls back) |
| Aspect ratios | 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 | |
| Max refs in Seedance | 9 images + 3 videos + 3 audio | "Rule of 12" total |
| Reference image format | JPG/PNG/WebP, ≤30 MB each | |
| Reference video format | ≤50 MB combined, ≤15s | |
| Reference audio format | MP3 (recommended), ≤15 MB each, ≤15s | WAV/AAC/FLAC may fail silently |
| Prompt length sweet spot | 60–150 words single-shot, 200–400 multi-shot | Soft 3500-char ceiling |
| Audio layers | Max 3 simultaneous | Dialogue + SFX + BGM |
| Characters per clip | 1–2 recommended | More = drift |
| gpt-image-2 max edge | 3840px | Must be multiple of 16 |
| gpt-image-2 quality settings | low / medium / high | `high` mandatory for refs going into Seedance |
| ytauto concurrency | 2 (Runway plan cap) | Override with `--concurrency` |

---

## 12. ytauto-specific recommendations

### Improvements you could make to the pipeline

1. **Inject a verbatim character descriptor into every segment prompt.** Currently codex re-words the character per segment, causing drift. After `ideate`, write a script that copies `manifest.characters[0].description` into each `segments[i].prompt` as a leading line.

2. **Auto-extract last frames for chained continuity.** Add a stage between `generate` and `stitch` (or end of `generate`) that uses ffmpeg to pull `segments/<seg>.mp4`'s last frame to `frames/<next-seg>-prev-lastframe.png`, then reference it in the next segment's run. This requires re-running generate on segment N+1 after segment N completes.

3. **Color-match in post.** ytauto's `stitch` does a clean concat. For higher quality, swap to a re-encode step that applies a unified LUT or runs a histogram-match across all segments. This is a one-line ffmpeg change with `-vf colormatch` or a separate DaVinci Resolve pass.

4. **Improve the artifacts.ts prompt templates.** The current templates are minimal. Bake in the photographic language (`"85mm portrait, soft window light"`) and the explicit detail requirements (eye color, distinguishing marks, lighting flat).

5. **Improve the ideate.md template.** Add the Seedance shot-timing format as the required output for `segments[i].prompt`. Currently codex produces prose, which is inferior to timestamped shot blocks.

### Sources

- [Runway: Creating with Seedance 2.0](https://help.runwayml.com/hc/en-us/articles/50488490233363)
- [Runway: Camera Terms, Prompts & Examples](https://help.runwayml.com/hc/en-us/articles/47313504791059)
- [Runway: Gen-4 Video Prompting Guide](https://help.runwayml.com/hc/en-us/articles/39789879462419)
- [Runway: AI Character References Tips](https://runwayml.com/resources/ai-character-references-tips)
- [fal.ai: How to Use Seedance 2.0 Like a Pro](https://fal.ai/learn/tools/how-to-use-seedance-2-0)
- [Replicate: Seedance 2.0 Model Card](https://replicate.com/bytedance/seedance-2.0)
- [Cutout.pro: Seedance 2.0 Audio Guide](https://www.cutout.pro/learn/blog-seedance-2-0-audio-guide/)
- [Magic Hour: How to Use Seedance 2.0](https://magichour.ai/blog/how-to-use-seedance-20)
- [Magic Hour: Character Consistency](https://magichour.ai/blog/how-to-keep-characters-consistent-in-ai-video)
- [Atlabs: Ultimate Seedance 2.0 Prompting Guide — 47 Prompts](https://www.atlabs.ai/blog/the-ultimate-seedance-2.0-prompting-guide-47-prompts-2026)
- [redreamality.com: Seedance 2.0 Usage Guide](https://redreamality.com/blog/seedance-2-guide/)
- [WaveSpeed: Seedance 2.0 Best Settings](https://wavespeed.ai/blog/posts/blog-seedance-2-0-best-settings/)
- [WaveSpeed: Seedance 2.0 Complete Guide](https://wavespeed.ai/blog/posts/seedance-2-0-complete-guide-multimodal-video-creation/)
- [glbgpt.com: Seedance 2.0 Limits Explained](https://www.glbgpt.com/hub/seedance-2-0-limits-explained-max-duration-file-sizes-how-to-bypass-them/)
- [AI Magicx: Long-Form AI Video Character Consistency Guide 2026](https://www.aimagicx.com/blog/long-form-ai-video-character-consistency-guide-2026)
- [Blue Lightning: Consistent AI Characters and Scenes in Runway](https://bluelightningtv.com/2025/05/19/how-to-create-consistent-ai-characters-and-scenes-in-runway-vs-midjourney-omni-reference/)
- [selfielab: Runway Gen-4 Consistent Characters Guide 2026](https://selfielab.me/blog/runway-gen-4-consistent-characters-guide-2026-20260310)
- [Cybercorsairs: Long Seamless AI Videos via Frame Chaining](https://cybercorsairs.com/kling-v2-1-create-long-seamless-ai-videos/)
- [OpenAI Cookbook: gpt-image-1 / gpt-image-2 prompting](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide)
- [OpenAI: Image Generation API guide](https://developers.openai.com/api/docs/guides/image-generation)
- [fal.ai: GPT Image 2 Prompting](https://fal.ai/learn/tools/prompting-gpt-image-2)
- [Atlas Cloud: GPT Image 2 + Seedance 2.0 Drama Workflow](https://www.atlascloud.ai/blog/guides/ultimate-drama-workflow-gpt-image-2-seedance-2-0)

---

## When the model is wrong

Practitioner consensus changes faster than any guide. If something here contradicts what you observe across 5+ runs, your runs are probably the truth — Runway updates Seedance silently, and the prompt-format fashions shift quarterly.

The structural rules (one verb per shot, photographic framing for refs, verbatim descriptors for identity, lock lighting in three places) have held since Gen-3 in 2023 — those are durable. Specific magic words (which lens to name, which mood word to use) drift. Re-test quarterly.
