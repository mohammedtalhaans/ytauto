// Hypothesis: on a fresh URL, the first Generate click only creates a session
// shell (URL gains sessionId) but doesn't queue. To queue, all inputs must be
// set on a URL that already has sessionId. So: pre-click Generate on the
// clean page (no refs, no prompt) to create the session, then configure,
// upload refs, fill prompt on the resulting session URL, then click Generate
// again to actually queue.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const profileDir = resolve("runway-profile");
const outDir = resolve("debug-out");
mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1920, height: 1080 },
  channel: "chrome",
  acceptDownloads: true
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const shot = (n) => page.screenshot({ path: resolve(outDir, `pre-${Date.now()}-${n}.png`), fullPage: true });
const dumpUrl = (label) => console.log(`[pre] url ${label}: ${page.url()}`);

console.log("[pre] navigate to home");
await page.goto("https://app.runwayml.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
dumpUrl("after navigate");

// If already on session URL, force navigation to a clean one for the test
const teamMatch = page.url().match(/\/teams\/([^/]+)\//);
const team = teamMatch ? teamMatch[1] : "laurahayes";
const cleanUrl = `https://app.runwayml.com/video-tools/teams/${team}/ai-tools/generate?tool=video&mode=tools`;
if (page.url().includes("sessionId=")) {
  console.log("[pre] forcing clean URL");
  await page.goto(cleanUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  dumpUrl("after force clean");
}

// First Generate click on truly empty state — type a tiny stub so the click registers
console.log("[pre] type stub prompt 'x' to enable Generate");
const promptBox = page.locator("[role='textbox'][aria-label='Prompt'][contenteditable='true']").first();
await promptBox.click();
await promptBox.fill("x");
await page.waitForTimeout(1500);

console.log("[pre] FIRST Generate click (just to create session URL)");
const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
await genBtn.click({ timeout: 15000 });

// Wait for URL to gain sessionId
const sessionWait = Date.now() + 30000;
while (Date.now() < sessionWait) {
  if (/[?&]sessionId=/i.test(page.url())) break;
  await page.waitForTimeout(1000);
}
dumpUrl("after first click");
await shot("01-after-first-click");

// Check whether body shows queue/generating immediately
const body0 = await page.locator("body").innerText().catch(() => "");
const queuedAfterFirst = /in queue|generation is in queue|generating|processing|will start/i.test(body0);
console.log("[pre] queued after first click?", queuedAfterFirst);
if (queuedAfterFirst) {
  console.log("[pre] First click already queued — interesting! Probably stub prompt was enough.");
}

// Now configure aspect/duration on session URL
const aspectTrigger = page.locator("button[aria-label='Aspect ratio']").first();
if ((await aspectTrigger.innerText().catch(() => "")).trim() !== "9:16") {
  await aspectTrigger.click();
  await page.waitForTimeout(700);
  await page.getByRole("option", { name: /^9:16$/ }).first().click();
  await page.waitForTimeout(700);
}
const durTrigger = page.locator("button[aria-label='Duration']").first();
if (!/^15\s*s$/i.test((await durTrigger.innerText().catch(() => "")).trim())) {
  await durTrigger.click();
  await page.waitForTimeout(700);
  await page.getByRole("option", { name: /^15\s*seconds?$/i }).first().click();
  await page.waitForTimeout(700);
}
await shot("02-after-config");

// Upload refs now that we're on a session URL
const refs = [
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/character-tulip.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/artifacts/setting-windowsill.png"),
  resolve("projects/a-30-second-time-lapse-of-a-single-tulip-blooming-in-a-sunli/frames/02-full-bloom.png")
];
console.log("[pre] uploading refs on session URL");
const fileInput = page.locator("input[type='file']").first();
await fileInput.setInputFiles(refs);
const upDeadline = Date.now() + 60000;
while (Date.now() < upDeadline) {
  const body = await page.locator("body").innerText().catch(() => "");
  const matches = body.match(/\bIMG_\d+\b/g);
  const count = matches ? new Set(matches).size : 0;
  if (count >= 3 && !/started uploading|uploading\.\.\./i.test(body)) {
    console.log("[pre] all 3 refs visible");
    break;
  }
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(1500);
await shot("03-after-uploads");

// Replace stub prompt with real one
console.log("[pre] replacing prompt with real text");
await promptBox.click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Delete");
await promptBox.fill("Cinematic 15s time-lapse: a single red-pink tulip in a clear glass vase on a sunlit windowsill, petals opening into full bloom as warm afternoon light shifts across the sill. Locked-off macro camera, natural realistic motion. No subtitles, no captions, no visible text.");
await page.waitForTimeout(1500);
await shot("04-after-prompt");

// SECOND Generate click
console.log("[pre] SECOND Generate click");
await genBtn.click({ timeout: 15000 });
await page.waitForTimeout(2500);
await shot("05-after-second-click");
dumpUrl("after second click");

const finalDeadline = Date.now() + 90000;
let queued = false;
while (Date.now() < finalDeadline) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (/please wait for your last generation|switch to credits mode|insufficient credits/i.test(body)) {
    console.log("[pre] BLOCKED");
    await shot("blocked");
    break;
  }
  if (/in queue|generation is in queue|generating|processing/i.test(body)) {
    console.log("[pre] QUEUED");
    queued = true;
    await shot("queued");
    break;
  }
  await page.waitForTimeout(2500);
}
if (!queued) {
  console.log("[pre] timed out without queue");
  await shot("timeout");
}
console.log("[pre] holding 60s");
await page.waitForTimeout(60000);
await ctx.close();
