/**
 * End-to-end check of the built extension (`dist/`) in Playwright's Chromium.
 *
 * Both ReplayBR hosts are served from fixtures through `context.route`, so no
 * request reaches the real site and Cloudflare is never involved. Everything
 * else is real: the extension page, ffmpeg.wasm, the zip.
 *
 * Run with `bun run e2e` (builds first).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { chromium } from "playwright";

const DIST = resolve(import.meta.dir, "../dist");
const FIXTURES = resolve(import.meta.dir, "fixtures");
const DATE = "2026-08-13";
const VIDEO = "https://replays.replaybr.com.br/video/four-play-3";

// One play with two cameras and one with a single camera, in the same hour.
const REPLAYS = {
  replays: [
    {
      timestamp: `${DATE}T20:34:25`,
      camera1_url: `${VIDEO}/a/camera1.mp4`,
      camera2_url: `${VIDEO}/a/camera2.mp4`,
    },
    { timestamp: `${DATE}T20:48:28`, camera1_url: `${VIDEO}/b/camera1.mp4` },
  ],
};

// The same shape as the real chunk: the inactive Set, then the export
// registration carrying the mapping.
const CHUNK =
  'let n=new Set(["golacos-society-2"]);' +
  'e.s(["getFieldInterval",0,r,"humanReadableFieldNameMapping",0,' +
  '{olaria:"Olaria","four-play-3":"Four Play - Quadra 3","golacos-society-2":"Golaços"},' +
  '"isFieldInactive",0,function(e){return!!e&&n.has(e)}],1);';

const profile = await mkdtemp(join(tmpdir(), "replaybr-e2e-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  acceptDownloads: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});

try {
  await context.route("https://www.replaybr.com.br/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("/replay")) {
      return route.fulfill({
        contentType: "text/html",
        body: '<script src="/_next/static/chunks/fields.js"></script>',
      });
    }
    return route.fulfill({ contentType: "text/javascript", body: CHUNK });
  });
  await context.route("https://replays.replaybr.com.br/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/available-hours") return route.fulfill({ json: REPLAYS });
    const camera = url.pathname.endsWith("camera2.mp4") ? "cam2.mp4" : "cam1.mp4";
    return route.fulfill({ path: join(FIXTURES, camera), contentType: "video/mp4" });
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);

  // The field list came from the (fixture) site, without the inactive one.
  // A PrimeVue-style select: the trigger opens a panel with a filter on top.
  await page.waitForSelector("#field .select-trigger:not([disabled])");
  await page.click("#field .select-trigger");
  const options = await page.$$eval('#field [role="option"]', (els) =>
    els.map((o) => o.textContent),
  );
  assert.deepEqual(options, ["Four Play - Quadra 3", "Olaria"]);
  assert.equal(await page.isVisible("#selection-notice"), false);

  // A slug the list doesn't know is offered as is.
  await page.fill("#field .select-filter", "campo-novo");
  assert.equal(await page.textContent('#field [role="option"]'), "Usar slug: campo-novo");

  // The court is searched by name, not scrolled to; Enter picks the match.
  await page.fill("#field .select-filter", "four 3");
  await page.keyboard.press("Enter");
  assert.equal(await page.isVisible("#field .select-panel"), false);
  assert.equal(await page.textContent("#field .select-label"), "Four Play - Quadra 3");
  await page.fill("#date", DATE);
  await page.dispatchEvent("#date", "change");
  await page.waitForSelector("#hour:not([disabled])");
  assert.equal(await page.inputValue("#hour"), "20");
  // four-play-3 swaps by default.
  assert.equal(await page.isChecked("#swap"), true);

  const started = performance.now();
  await page.click("#generate");
  await page.waitForFunction(
    () => document.getElementById("progress")?.textContent?.startsWith("Pronto"),
    undefined,
    { timeout: 120_000 },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  assert.equal(await page.textContent("#progress"), "Pronto — 2 vídeo(s).");
  assert.equal(await page.isVisible("#failures"), false);

  // Both clips share the two-column frame: 2 x 320 by 240.
  const sizes = await page.$$eval(".clip video", (videos) =>
    Promise.all(
      (videos as HTMLVideoElement[]).map(
        (v) =>
          new Promise<string>((done) => {
            const read = () => done(`${v.videoWidth}x${v.videoHeight}`);
            if (v.readyState >= 1) read();
            else v.addEventListener("loadedmetadata", read, { once: true });
          }),
      ),
    ),
  );
  assert.deepEqual(sizes, ["640x240", "640x240"]);

  // camera1 is red and camera2 blue; with swap on, camera2 goes on the left.
  const left = await page.$eval(".clip video", (video) => {
    const v = video as HTMLVideoElement;
    return new Promise<number[]>((done) => {
      v.addEventListener(
        "seeked",
        () => {
          const canvas = document.createElement("canvas");
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(v, 0, 0);
          done([...ctx.getImageData(10, 120, 1, 1).data.slice(0, 3)]);
        },
        { once: true },
      );
      v.currentTime = 0.5;
    });
  });
  const [red, , blue] = left as [number, number, number];
  assert.ok(blue > 150 && red < 100, `left side should be blue, got rgb(${left.join(",")})`);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#actions button"),
  ]);
  assert.equal(download.suggestedFilename(), `replays-four-play-3-${DATE}-20.zip`);
  const zip = await JSZip.loadAsync(await Bun.file((await download.path())!).arrayBuffer());
  assert.deepEqual(Object.keys(zip.files), ["01_20-34-25.mp4", "02_20-48-28.mp4"]);

  console.log(`✓ e2e ok: 2 clips rendered in ${seconds} s, zip with both`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
