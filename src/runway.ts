import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Download, type Locator, type Page } from "playwright";
import { MODEL_LABEL, type ResolvedJob } from "./types.js";

const execFileAsync = promisify(execFile);

export interface DriverOptions {
  generationUrl: string;
  generationTimeoutMs: number;
  upscaleTimeoutMs: number;
  pollIntervalMs: number;
  debugDir: string;
}

export async function launchContext(profileDir: string): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1920, height: 1080 },
    channel: "chrome"
  });
}

export async function ensureLoggedIn(page: Page, generationUrl: string): Promise<boolean> {
  await page.goto(generationUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (await isSignedIn(page)) {
    return true;
  }
  return false;
}

export async function waitForLogin(page: Page, generationUrl: string, timeoutMs = 10 * 60 * 1000): Promise<boolean> {
  await page.goto(generationUrl, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) {
      return true;
    }
    await page.waitForTimeout(2500);
  }
  return false;
}

async function isSignedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/(login|signin|signup)/i.test(url) || /auth\.runwayml/i.test(url)) {
    return false;
  }
  const passwordVisible = await page
    .locator("input[type='password']")
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (passwordVisible) {
    return false;
  }
  // Detect a Runway team URL (e.g. /video-tools/teams/<slug>/...) as signal of logged-in state
  return /\/teams\//i.test(url);
}

export async function runJob(
  page: Page,
  job: ResolvedJob,
  options: DriverOptions,
  log: (msg: string) => void
): Promise<{ output: string; sessionUrl: string }> {
  const tag = `[${job.name}]`;
  log(`${tag} starting`);
  await navigateUntilReady(page, options.generationUrl, log, tag);
  await openCustomVideoTool(page);

  try {
    await configureModel(page, job.model);
    await configureAspect(page, job.aspect);
    await configureDuration(page, job.duration);
    await configureResolution(page, job.resolution);
  } catch (error) {
    await screenshot(page, options.debugDir, `${job.name}-configure-failed`);
    throw error;
  }
  await uploadReferences(page, job.refs);
  await fillPrompt(page, job.prompt);

  log(`${tag} clicking Generate`);
  const accepted = await clickGenerateAndConfirm(page, options.debugDir, job.name);
  if (!accepted) {
    await screenshot(page, options.debugDir, `${job.name}-generate-not-accepted`);
    throw new Error(`Generate not accepted for job ${job.name}`);
  }
  const sessionUrl = page.url();
  log(`${tag} submitted; sessionUrl=${sessionUrl}`);

  log(`${tag} waiting for generation to finish (timeout ${Math.round(options.generationTimeoutMs / 60000)}m)`);
  const generated = await waitForGenerationComplete(page, options.generationTimeoutMs, options.pollIntervalMs);
  if (!generated) {
    await screenshot(page, options.debugDir, `${job.name}-generation-timeout`);
    throw new Error(`Generation timed out for job ${job.name}`);
  }
  log(`${tag} generation complete`);

  if (job.upscale) {
    log(`${tag} clicking upscale`);
    if (!await clickUpscale(page)) {
      await screenshot(page, options.debugDir, `${job.name}-upscale-click-failed`);
      throw new Error(`Could not click upscale for job ${job.name}`);
    }
    const upscaled = await waitForUpscaleComplete(page, options.upscaleTimeoutMs, options.pollIntervalMs);
    if (!upscaled) {
      await screenshot(page, options.debugDir, `${job.name}-upscale-timeout`);
      throw new Error(`Upscale timed out for job ${job.name}`);
    }
    log(`${tag} upscale complete`);
  }

  mkdirSync(job.outputDir, { recursive: true });
  const outPath = await downloadVideo(page, job.outputDir, job.name);
  if (!outPath) {
    await screenshot(page, options.debugDir, `${job.name}-download-failed`);
    throw new Error(`Download failed for job ${job.name}`);
  }
  log(`${tag} downloaded -> ${outPath}`);
  return { output: outPath, sessionUrl };
}

async function navigateUntilReady(page: Page, generationUrl: string, log: (msg: string) => void, tag: string): Promise<void> {
  // Sometimes Runway's home page hangs on initial render (loading spinner
  // never resolves). Detect this by checking whether the prompt textbox or
  // the Custom-tool's nav appears within a generous window. If not, reload
  // and retry. Up to 4 attempts with full page reload.
  const totalDeadline = Date.now() + 4 * 60 * 1000;
  for (let attempt = 1; attempt <= 4 && Date.now() < totalDeadline; attempt++) {
    if (attempt === 1) {
      await page.goto(generationUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    } else {
      log(`${tag} page didn't become interactive — reload attempt ${attempt}`);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    // Ready signal: prompt box visible OR a sidebar Custom button visible.
    const ready = await Promise.race([
      promptBox(page).first().isVisible({ timeout: 1500 }).catch(() => false),
      page.getByRole("button", { name: "Custom", exact: true }).first().isVisible({ timeout: 1500 }).catch(() => false),
      page.getByText("Custom", { exact: true }).first().isVisible({ timeout: 1500 }).catch(() => false)
    ]);
    if (ready) {
      return;
    }
    // Try forcing the team-tool URL on attempt 2+
    if (attempt >= 2) {
      const url = page.url();
      const teamMatch = url.match(/\/teams\/([^/]+)\//);
      if (teamMatch) {
        const target = `https://app.runwayml.com/video-tools/teams/${teamMatch[1]}/ai-tools/generate?tool=video&mode=tools`;
        await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        await page.waitForTimeout(3000);
      }
    }
  }
  throw new Error(`Runway page never became interactive after navigation (gave up after attempts)`);
}

async function dismissOverlays(_page: Page): Promise<void> {
  // Disabled: experimental click on overlay-dismiss buttons appeared to
  // interfere with the Generate flow on the first worker. Re-enable only
  // with very specific selectors if/when needed.
}

async function openCustomVideoTool(page: Page): Promise<void> {
  await dismissOverlays(page);
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await promptBox(page).count() > 0) {
      return;
    }
    await clickFirstVisible([
      page.getByRole("button", { name: "Custom", exact: true }),
      page.getByText("Custom", { exact: true })
    ]).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(2500);
    if (await promptBox(page).count() > 0) {
      return;
    }
    await clickFirstVisible([
      page.getByLabel("Video", { exact: true }),
      page.getByText("Video", { exact: true })
    ]).catch(() => undefined);
    await page.waitForTimeout(2000);
    if (await promptBox(page).count() > 0) {
      return;
    }
    // Last-ditch on this attempt: navigate the URL hard with the right query params
    const url = page.url();
    const teamMatch = url.match(/\/teams\/([^/]+)\//);
    if (teamMatch) {
      const target = `https://app.runwayml.com/video-tools/teams/${teamMatch[1]}/ai-tools/generate?tool=video&mode=tools`;
      if (url !== target) {
        await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        await page.waitForTimeout(2500);
      }
    } else {
      await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForTimeout(2500);
    }
  }
}

function promptBox(page: Page): Locator {
  return page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']");
}

async function configureModel(page: Page, model: ResolvedJob["model"]): Promise<void> {
  const target = MODEL_LABEL[model];
  // The model picker trigger has aria-label="Video models" (or similar) and its
  // visible text is the currently-selected model name.
  const triggerCandidates: Locator[] = [
    page.locator("button[aria-label='Video models']"),
    page.getByRole("button", { name: /^Video models$/i }),
    page.getByRole("button", { name: /video models/i }),
    page.getByRole("button", { name: /^model$/i })
  ];
  let trigger: Locator | undefined;
  for (const candidate of triggerCandidates) {
    const first = candidate.first();
    if (await first.isVisible({ timeout: 1500 }).catch(() => false)) {
      trigger = first;
      break;
    }
  }
  if (!trigger) {
    throw new Error(`Could not find model trigger for ${model}`);
  }
  const text = (await trigger.innerText().catch(() => "")).trim();
  if (target.test(text)) {
    return;
  }
  await trigger.click({ timeout: 8000 });
  await pickRoleOption(page, target);
}

async function configureAspect(page: Page, aspect: ResolvedJob["aspect"]): Promise<void> {
  const trigger = page.locator("button[aria-label='Aspect ratio']").first();
  const text = (await trigger.innerText().catch(() => "")).trim();
  if (text === aspect) {
    return;
  }
  await trigger.click({ timeout: 8000 });
  await pickRoleOption(page, new RegExp(`^${escapeRegex(aspect)}$`));
}

async function configureDuration(page: Page, duration: number): Promise<void> {
  const trigger = page.locator("button[aria-label='Duration']").first();
  const text = (await trigger.innerText().catch(() => "")).trim();
  if (new RegExp(`^${duration}\\s*s$`, "i").test(text)) {
    return;
  }
  await trigger.click({ timeout: 8000 });
  await pickRoleOption(page, new RegExp(`^${duration}\\s*(seconds?|s)$`, "i"));
}

async function configureResolution(page: Page, resolution: ResolvedJob["resolution"]): Promise<void> {
  // Resolution trigger may show "720p" or "1080p" as text directly. Find a button whose text matches a resolution.
  const triggerCandidates: Locator[] = [
    page.locator("button[aria-label='Resolution']"),
    page.getByRole("button", { name: /^(720p|1080p|4K)$/i })
  ];
  for (const candidate of triggerCandidates) {
    const button = candidate.first();
    if (!await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      continue;
    }
    const text = (await button.innerText().catch(() => "")).trim();
    if (new RegExp(`^${escapeRegex(resolution)}$`, "i").test(text)) {
      return;
    }
    await button.click({ timeout: 8000 });
    try {
      await pickRoleOption(page, new RegExp(`^${escapeRegex(resolution)}$`, "i"));
    } catch (error) {
      if (isOptionDisabledError(error)) {
        console.warn(`[runway] resolution ${resolution} not available for current model/duration/aspect; keeping ${text || "default"}`);
        return;
      }
      throw error;
    }
    return;
  }
  // Resolution selector may not exist for some models; non-fatal.
}

async function uploadReferences(page: Page, refs: string[]): Promise<void> {
  if (!refs.length) {
    return;
  }
  for (const path of refs) {
    if (!existsSync(path)) {
      throw new Error(`Reference file not found: ${path}`);
    }
  }
  const fileInput = page.locator("input[type='file']").first();
  try {
    await fileInput.setInputFiles(refs);
  } catch {
    for (const path of refs) {
      await fileInput.setInputFiles(path);
      await page.waitForTimeout(1500);
    }
  }
  // Wait for upload to complete: each ref shows up as IMG_<n> in the references panel.
  // Runway also shows a transient "Started uploading N files" toast that disappears when done.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const body = await readBody(page);
    const labelCount = countImgLabels(body);
    const stillUploading = /(started uploading|uploading\s+\d+|uploading\.\.\.)/i.test(body);
    if (labelCount >= refs.length && !stillUploading) {
      // All refs visible and no in-progress toast — done.
      await page.waitForTimeout(1500);
      return;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`Reference upload did not complete within 120s (saw ${countImgLabels(await readBody(page))}/${refs.length} thumbnails)`);
}

function countImgLabels(body: string): number {
  const matches = body.match(/\bIMG_\d+\b/g);
  return matches ? new Set(matches).size : 0;
}

// Hard limit Runway enforces on the prompt textarea. Mirrors MAX_PROMPT_CHARS
// in src/types.ts. Defensive truncation here guarantees we never exceed it
// even if a manually-edited manifest sneaks past ideate's validation.
const RUNWAY_MAX_PROMPT_CHARS = 3500;

async function fillPrompt(page: Page, prompt: string): Promise<void> {
  let safePrompt = prompt;
  if (safePrompt.length > RUNWAY_MAX_PROMPT_CHARS) {
    console.warn(
      `[runway] prompt is ${safePrompt.length} chars > ${RUNWAY_MAX_PROMPT_CHARS}; truncating to fit Runway's limit`
    );
    safePrompt = safePrompt.slice(0, RUNWAY_MAX_PROMPT_CHARS);
  }
  const box = promptBox(page).first();
  await box.click({ timeout: 15000 });
  // Clear existing content
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.press("Delete").catch(() => undefined);
  try {
    await box.fill(safePrompt);
  } catch {
    await page.keyboard.insertText(safePrompt);
  }
}

async function clickGenerateAndConfirm(page: Page, debugDir: string, jobName: string): Promise<boolean> {
  await dismissOverlays(page);
  // Click-retry strategy: each click attempt waits up to 30s for either a
  // /v1/tasks 200 (canonical queue signal) or "in queue / generating" body
  // text. If neither appears, the click likely didn't fire — click again.
  // Up to 3 clicks per call.
  const maxClicks = 3;
  for (let attempt = 1; attempt <= maxClicks; attempt++) {
    const taskResponsePromise = page
      .waitForResponse(
        (response) => response.url().includes("/v1/tasks") && response.request().method() === "POST",
        { timeout: 30000 }
      )
      .catch(() => undefined);

    const generate = page.getByRole("button", { name: "Generate", exact: true }).first();
    try {
      await generate.click({ timeout: 15000 });
    } catch (clickError) {
      console.warn(`[${jobName}] generate click ${attempt} failed: ${(clickError as Error).message}`);
    }

    const perClickDeadline = Date.now() + 30000;
    let networkDone = false;
    let uiActive = false;
    while (Date.now() < perClickDeadline) {
      const body = await readBody(page);
      if (isBlocked(body)) {
        await screenshot(page, debugDir, `${jobName}-generate-blocked`);
        return false;
      }
      if (hasActiveText(body)) {
        uiActive = true;
        break;
      }
      networkDone = await Promise.race([
        taskResponsePromise.then(() => true).catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))
      ]);
      if (networkDone) break;
    }

    if (networkDone) {
      const response = await taskResponsePromise;
      if (response) {
        const status = response.status();
        if (status >= 400) {
          let body = "";
          try { body = (await response.text()).slice(0, 300); } catch { /* */ }
          console.error(`[${jobName}] /v1/tasks returned ${status}: ${body}`);
          await screenshot(page, debugDir, `${jobName}-generate-task-${status}`);
          if (attempt < maxClicks) {
            console.warn(`[${jobName}] retrying click after server error (attempt ${attempt}/${maxClicks})`);
            await page.waitForTimeout(3000);
            continue;
          }
          return false;
        }
        try {
          const json = await response.json();
          const taskId = json?.task?.id;
          if (taskId) {
            console.log(`[${jobName}] queued as task ${taskId}`);
          }
        } catch { /* */ }
        return true;
      }
    }
    if (uiActive) {
      console.log(`[${jobName}] queue confirmed via UI text (attempt ${attempt})`);
      return true;
    }
    if (attempt < maxClicks) {
      console.warn(`[${jobName}] click ${attempt} produced no /v1/tasks POST and no "in queue" text — retrying`);
      await page.waitForTimeout(3000);
    }
  }
  await screenshot(page, debugDir, `${jobName}-generate-exhausted-clicks`);
  return false;
}

async function waitForGenerationComplete(page: Page, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const body = await readBody(page);
    if (!hasActiveText(body) && (hasPostGenText(body) || await hasFourKButton(page))) {
      consecutive++;
      if (consecutive >= 2) {
        return true;
      }
    } else {
      consecutive = 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await page.waitForTimeout(Math.min(pollIntervalMs, remaining));
  }
  return false;
}

async function clickUpscale(page: Page): Promise<boolean> {
  if (await clickLatestFourKButton(page)) {
    await page.waitForTimeout(1500);
    await clickFirstAvailable([
      page.getByRole("button", { name: /Upscale to 4k.*Topaz/i }),
      page.getByRole("button", { name: /^upscale$/i }),
      page.getByText(/Upscale to 4k.*Topaz/i)
    ]).catch(() => false);
    return true;
  }
  return clickFirstAvailable([
    page.getByRole("button", { name: /upscale/i }),
    page.getByText(/upscale/i)
  ]);
}

async function waitForUpscaleComplete(page: Page, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const body = await readBody(page);
    if (!hasActiveText(body) && /\b4K\.mp4\b/i.test(body) && await hasDownloadAffordance(page)) {
      consecutive++;
      if (consecutive >= 2) {
        return true;
      }
    } else {
      consecutive = 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await page.waitForTimeout(Math.min(pollIntervalMs, remaining));
  }
  return false;
}

async function downloadVideo(page: Page, outputDir: string, jobName: string): Promise<string | undefined> {
  const direct = await downloadViaOutputIcon(page, outputDir, jobName);
  if (direct) {
    return direct;
  }
  for (const locator of [
    page.getByRole("button", { name: /^4K$/i }).last().locator("xpath=following::button[1]"),
    page.getByRole("button", { name: /^download$/i }),
    page.getByRole("button", { name: /download/i })
  ]) {
    const button = locator.first();
    if (!await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      continue;
    }
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 }).catch(() => undefined);
    await button.click().catch(() => undefined);
    const download = await downloadPromise;
    if (download) {
      return saveDownload(download, outputDir, jobName);
    }
  }
  return undefined;
}

async function downloadViaOutputIcon(page: Page, outputDir: string, jobName: string): Promise<string | undefined> {
  await scrollToBottom(page);
  if (!await hasOutputDownloadIcon(page)) {
    return undefined;
  }
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 }).catch(() => undefined);
  const clicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button")]
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          button,
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          text: (button.textContent ?? "").trim(),
          aria: button.getAttribute("aria-label"),
          title: button.getAttribute("title")
        };
      })
      .filter((c) =>
        c.x > 1100 &&
        c.y > 500 &&
        c.w >= 20 &&
        c.w <= 40 &&
        c.h >= 10 &&
        c.h <= 40 &&
        !c.text &&
        !c.aria &&
        !c.title
      )
      .sort((a, b) => b.y - a.y);
    const top = candidates[0];
    if (!top) {
      return false;
    }
    top.button.click();
    return true;
  });
  if (!clicked) {
    return undefined;
  }
  const download = await downloadPromise;
  return download ? saveDownload(download, outputDir, jobName) : undefined;
}

async function hasDownloadAffordance(page: Page): Promise<boolean> {
  if (await hasOutputDownloadIcon(page)) {
    return true;
  }
  for (const locator of [
    page.getByRole("button", { name: /^download$/i }),
    page.getByRole("button", { name: /download/i })
  ]) {
    if (await locator.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function hasOutputDownloadIcon(page: Page): Promise<boolean> {
  await scrollToBottom(page);
  return page.evaluate(() => [...document.querySelectorAll("button")].some((button) => {
    const rect = button.getBoundingClientRect();
    return rect.x > 1100 &&
      rect.y > 500 &&
      rect.width >= 20 &&
      rect.width <= 40 &&
      rect.height >= 10 &&
      rect.height <= 40 &&
      !(button.textContent ?? "").trim() &&
      !button.getAttribute("aria-label") &&
      !button.getAttribute("title");
  })).catch(() => false);
}

async function clickLatestFourKButton(page: Page): Promise<boolean> {
  if (!await hasFourKButton(page)) {
    return false;
  }
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button")]
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          button,
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          text: (button.textContent ?? "").trim()
        };
      })
      .filter((c) =>
        c.text === "4K" &&
        c.x > 1000 &&
        c.y > 300 &&
        c.w > 30 &&
        c.h > 20
      )
      .sort((a, b) => b.y - a.y);
    const top = candidates[0];
    if (!top) {
      return false;
    }
    top.button.click();
    return true;
  });
}

async function hasFourKButton(page: Page): Promise<boolean> {
  return page.evaluate(() => [...document.querySelectorAll("button")].some((button) => {
    const rect = button.getBoundingClientRect();
    return (button.textContent ?? "").trim() === "4K" &&
      rect.x > 1000 &&
      rect.y > 300 &&
      rect.width > 30 &&
      rect.height > 20;
  })).catch(() => false);
}

class OptionDisabledError extends Error {
  readonly disabled = true as const;
  constructor(message: string) {
    super(message);
    this.name = "OptionDisabledError";
  }
}

function isOptionDisabledError(error: unknown): boolean {
  return error instanceof Error && (error as Partial<OptionDisabledError>).disabled === true;
}

async function pickRoleOption(page: Page, name: RegExp): Promise<void> {
  const candidates: Locator[] = [
    page.getByRole("option", { name }),
    page.getByRole("menuitem", { name }),
    page.getByRole("menuitemradio", { name }),
    page.getByRole("radio", { name }),
    page.locator("[role='option']:visible").filter({ hasText: name }),
    page.locator("[role='menuitem']:visible").filter({ hasText: name })
  ];
  for (const candidate of candidates) {
    const target = candidate.first();
    if (!await target.isVisible({ timeout: 1500 }).catch(() => false)) {
      continue;
    }
    const disabled = await target.evaluate((el: Element) => {
      const aria = el.getAttribute("aria-disabled");
      const data = el.getAttribute("data-disabled");
      return aria === "true" || data === "true" || data === "";
    }).catch(() => false);
    if (disabled) {
      // Close any open popover before bubbling
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new OptionDisabledError(`option matching ${name} is disabled (Runway constraint)`);
    }
    await target.click({ timeout: 5000 });
    await page.waitForTimeout(400);
    return;
  }
  throw new Error(`Could not find option matching ${name}`);
}

async function clickFirstVisible(locators: Locator[]): Promise<void> {
  for (const locator of locators) {
    const target = locator.first();
    if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {
      await target.click({ timeout: 8000 });
      return;
    }
  }
  throw new Error("No visible candidate to click");
}

async function clickFirstAvailable(locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    const target = locator.first();
    if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {
      await target.click({ timeout: 8000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function readBody(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
}

function hasActiveText(body: string): boolean {
  return /in queue|generation is in queue|will start|generating|processing|upscaling/i.test(body);
}

function hasPostGenText(body: string): boolean {
  return /upscale|\bdownload\b|\b4K\.mp4\b/i.test(body);
}

function isBlocked(body: string): boolean {
  return /please wait for your last generation to complete|switch to credits mode|insufficient credits|out of credits/i.test(body);
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(800);
}

async function saveDownload(download: Download, outputDir: string, jobName: string): Promise<string> {
  const suggested = download.suggestedFilename() || `${jobName}.mp4`;
  const ext = extname(suggested) || ".mp4";
  const localPath = resolve(join(outputDir, `${jobName}${ext}`));
  await download.saveAs(localPath);
  if (extname(localPath).toLowerCase() !== ".zip") {
    return localPath;
  }
  const extracted = await extractLargestMp4(localPath, outputDir, jobName);
  return extracted ?? localPath;
}

async function extractLargestMp4(zipPath: string, outputDir: string, jobName: string): Promise<string | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }
  const extractDir = join(outputDir, `${jobName}-extracted`);
  mkdirSync(extractDir, { recursive: true });
  const zipEsc = zipPath.replace(/'/g, "''");
  const dstEsc = extractDir.replace(/'/g, "''");
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipEsc}' -DestinationPath '${dstEsc}' -Force`
  ]).catch(() => undefined);
  const mp4s = listFilesRecursive(extractDir)
    .filter((file) => extname(file).toLowerCase() === ".mp4")
    .sort((a, b) => statSync(b).size - statSync(a).size);
  return mp4s[0];
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursive(full) : [full];
  });
}

async function screenshot(page: Page, debugDir: string, label: string): Promise<void> {
  try {
    mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: join(debugDir, `${Date.now()}-${label}.png`), fullPage: true });
  } catch {
    // best-effort
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
