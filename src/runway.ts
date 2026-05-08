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
  await page.goto(options.generationUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await openCustomVideoTool(page);

  await configureModel(page, job.model);
  await configureAspect(page, job.aspect);
  await configureDuration(page, job.duration);
  await configureResolution(page, job.resolution);
  await uploadReferences(page, job.refs);
  await fillPrompt(page, job.prompt);

  log(`${tag} clicking Generate`);
  const accepted = await clickGenerateAndConfirm(page);
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

async function openCustomVideoTool(page: Page): Promise<void> {
  if (await promptBox(page).count() > 0) {
    return;
  }
  await clickFirstVisible([
    page.getByRole("button", { name: "Custom", exact: true }),
    page.getByText("Custom", { exact: true })
  ]).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(2500);
  if (await promptBox(page).count() === 0) {
    await clickFirstVisible([
      page.getByLabel("Video", { exact: true }),
      page.getByText("Video", { exact: true })
    ]).catch(() => undefined);
    await page.waitForTimeout(2000);
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
    await pickRoleOption(page, new RegExp(`^${escapeRegex(resolution)}$`, "i"));
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
  await page.waitForTimeout(4000);
}

async function fillPrompt(page: Page, prompt: string): Promise<void> {
  const box = promptBox(page).first();
  await box.click({ timeout: 15000 });
  // Clear existing content
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.press("Delete").catch(() => undefined);
  try {
    await box.fill(prompt);
  } catch {
    await page.keyboard.insertText(prompt);
  }
}

async function clickGenerateAndConfirm(page: Page): Promise<boolean> {
  const startUrl = page.url();
  const generate = page.getByRole("button", { name: "Generate", exact: true }).first();
  await generate.click({ timeout: 15000 });
  // Wait for either URL change or active-generation text, twice in a row
  const deadline = Date.now() + 90000;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const body = await readBody(page);
    if (isBlocked(body)) {
      return false;
    }
    if (page.url() !== startUrl || hasActiveText(body)) {
      consecutive++;
      if (consecutive >= 2) {
        return true;
      }
    } else {
      consecutive = 0;
    }
    await page.waitForTimeout(3000);
  }
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
    if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {
      await target.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      return;
    }
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
