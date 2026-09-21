#!/usr/bin/env node
// Playwright video recorder built on top of capture.mjs's login/session and
// step mechanics. Produces two 1920x1080 .webm product clips with an
// injected on-screen caption bar, read-only against LadderOps staging.
//
// Usage: node record.mjs [clip-a|clip-b|all|qm-assets|qm-qr-labels|qm-all]

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(process.env.RECORD_OUT_DIR || path.join(__dirname, "../../.video-out"));
const VIDEO_TMP_DIR = path.join(OUT_DIR, "_tmp");
const DELIVERY_DIR = process.env.RECORD_DELIVERY_DIR || path.join(os.homedir(), "Desktop", "ladderops-clips");
const FRAMES_DIR = path.join(DELIVERY_DIR, "frames");

const BASE_URL = process.env.CAPTURE_BASE_URL || "https://staging.ladderops.tech";
const USERNAME = process.env.CAPTURE_USERNAME || "chief";
// No default. This repository is public, and a password with a fallback
// value here is a working credential for an internet-facing environment
// published to anyone who clones it. Supply it in the environment:
//
//   CAPTURE_PASSWORD=... node record.mjs
//
// Fails immediately rather than part-way through a login, so the error
// names the cause instead of surfacing as a stuck selector.
const PASSWORD = process.env.CAPTURE_PASSWORD;
if (!PASSWORD) {
  console.error(
    "[record] CAPTURE_PASSWORD is not set.\n" +
      "  This script signs in to a deployed environment, so the password is\n" +
      "  supplied at run time and never committed. Export it and re-run.",
  );
  process.exit(1);
}
const TENANT = process.env.CAPTURE_TENANT || "ridgeview";

const VIEWPORT = { width: 1920, height: 1080 };
const STORAGE_STATE_PATH = path.join(OUT_DIR, "_storage-state.json");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(VIDEO_TMP_DIR, { recursive: true });
fs.mkdirSync(DELIVERY_DIR, { recursive: true });
fs.mkdirSync(FRAMES_DIR, { recursive: true });

function log(msg) {
  console.log(`[record] ${msg}`);
}

// ---------------------------------------------------------------------------
// Login + session (mechanics verbatim from tools/capture/capture.mjs)
// ---------------------------------------------------------------------------

/** Fill the login form and land on the authenticated dashboard. */
async function login(page) {
  await page.goto(BASE_URL, { waitUntil: "load" });
  await page.locator("#username").waitFor({ state: "visible", timeout: 30000 });
  // The login form hydrates a beat after DOM paint; filling before React
  // attaches its handlers silently no-ops the fill (fields read back empty
  // on submit). A short settle avoids that race.
  await page.waitForTimeout(1000);

  await page.locator("#username").click();
  await page.locator("#username").fill(USERNAME);
  await page.locator("#password").click();
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#tenant").click();
  await page.locator("#tenant").fill(TENANT);

  const values = {
    username: await page.locator("#username").inputValue(),
    password: await page.locator("#password").inputValue(),
    tenant: await page.locator("#tenant").inputValue(),
  };
  if (!values.username || !values.password || !values.tenant) {
    throw new Error(`Login form did not accept fill(): ${JSON.stringify(values)}`);
  }

  await page.locator('button[type="submit"]').click();
  // Greeting is time-of-day dependent ("Good morning/afternoon/evening"), so
  // match any of them rather than hardcoding one.
  await page.getByText(/Good (morning|afternoon|evening)/).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
}

/** Flip the app from its default dark theme to light for marketing captures. */
async function switchToLightTheme(page) {
  const htmlClass = await page.locator("html").getAttribute("class");
  if (htmlClass && htmlClass.includes("light")) return; // already light (e.g. via restored storageState)
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.waitForTimeout(400);
  const after = await page.locator("html").getAttribute("class");
  if (!after || !after.includes("light")) {
    throw new Error(`Theme toggle did not switch to light (html class="${after}")`);
  }
}

/**
 * Logs in on a throwaway (unrecorded) context and saves storageState (cookies
 * + localStorage, which is where the JWT and the next-themes preference both
 * live) so the actual recorded context can open straight into an
 * authenticated, light-themed session with zero login footage in the clip.
 */
async function buildAuthenticatedStorageState(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  log("Logging in to capture session storageState (not recorded)...");
  await login(page);
  await switchToLightTheme(page);
  await context.storageState({ path: STORAGE_STATE_PATH });
  await context.close();
  log(`Session storageState saved to ${STORAGE_STATE_PATH}`);
}

// ---------------------------------------------------------------------------
// Caption bar
// ---------------------------------------------------------------------------

/**
 * Registers an init script that (re)creates the caption bar DOM on every
 * navigation/document load in this page (page.goto is a full navigation in
 * this app, so a plain page.evaluate-injected div would be wiped each time).
 * Client-side route transitions don't reload the document, so the bar simply
 * persists across those.
 */
async function installCaptionBar(page) {
  await page.addInitScript(() => {
    function ensureBar() {
      let bar = document.getElementById("__rec_caption_bar");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "__rec_caption_bar";
        Object.assign(bar.style, {
          position: "fixed",
          left: "50%",
          bottom: "56px",
          transform: "translateX(-50%)",
          maxWidth: "80vw",
          background: "rgba(26,35,50,0.92)",
          color: "#ffffff",
          padding: "22px 40px",
          borderRadius: "18px",
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          fontSize: "28px",
          fontWeight: "600",
          lineHeight: "1.35",
          textAlign: "center",
          zIndex: "2147483647",
          boxShadow: "0 10px 34px rgba(0,0,0,0.4)",
          pointerEvents: "none",
          opacity: "0",
          transition: "opacity 450ms ease",
          whiteSpace: "pre-line",
        });
        (document.body || document.documentElement).appendChild(bar);
      }
      return bar;
    }
    window.__setCaptionText = (text) => {
      const bar = ensureBar();
      if (!text) {
        bar.style.opacity = "0";
        return;
      }
      bar.textContent = text;
      bar.style.opacity = "1";
    };
    if (document.readyState !== "loading") ensureBar();
    else document.addEventListener("DOMContentLoaded", ensureBar);

    // ---------------------------------------------------------------------
    // Hide the app's build-version debug chip (components/build-version-
    // indicator.tsx in ladderops-pwa): a small pill in the top-nav showing
    // the running bundle's short git SHA (or "dev"), mounted next to the
    // theme toggle. Not appropriate for a public marketing clip. Primary
    // selector targets its stable Tailwind class combo; the text-content
    // fallback covers both its states (neutral "<7-hex-chars>"/"dev" pill,
    // or the amber "Update available" button) in case classes shift. Runs
    // on a MutationObserver + interval because the badge's real SHA arrives
    // async (after its own /api/version fetch resolves).
    function hideDebugChrome() {
      document.querySelectorAll(".font-mono.text-\\[10px\\].text-muted-foreground").forEach((el) => {
        el.style.display = "none";
      });
      document.querySelectorAll("span, div, button").forEach((el) => {
        if (el.children.length > 0) return;
        const t = (el.textContent || "").trim();
        if (/^[0-9a-f]{7}$/i.test(t) || t === "dev") {
          el.style.display = "none";
        }
      });
    }
    // MutationObserver.observe(document.documentElement, ...) can throw
    // ("parameter 1 is not of type 'Node'") when this init script's very
    // first invocation runs before document.documentElement exists yet
    // (Playwright fires addInitScript on an initial placeholder document as
    // well as the real navigated one) - an uncaught exception here would
    // abort the rest of this synchronous script, silently skipping the
    // setInterval registration below it. Deferring to DOMContentLoaded (same
    // guard ensureBar already uses above) sidesteps that entirely.
    function startDebugChromeGuard() {
      try {
        const debugObserver = new MutationObserver(hideDebugChrome);
        debugObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      } catch {
        // best-effort; the setInterval below still catches it shortly after
      }
      hideDebugChrome();
      setInterval(hideDebugChrome, 500);
    }
    if (document.readyState !== "loading") startDebugChromeGuard();
    else document.addEventListener("DOMContentLoaded", startDebugChromeGuard);
  });
}

/** Swaps the caption bar text (or fades it out if text is falsy) and settles. */
async function setCaption(page, text, settleMs = 500) {
  await page.evaluate((t) => {
    if (window.__setCaptionText) window.__setCaptionText(t);
  }, text);
  if (settleMs) await page.waitForTimeout(settleMs);
}

// ---------------------------------------------------------------------------
// Deliberate mouse motion helpers
// ---------------------------------------------------------------------------

/** Moves the mouse to an element's center with visible multi-step motion before acting on it. */
async function moveMouseToLocator(page, locator, opts = {}) {
  const box = await locator.boundingBox();
  if (!box) return null;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cur = opts.from || { x: Math.max(x - 260, 20), y: Math.max(y - 140, 20) };
  await page.mouse.move(cur.x, cur.y);
  await page.waitForTimeout(120);
  await page.mouse.move(x, y, { steps: opts.steps ?? 24 });
  await page.waitForTimeout(opts.settleMs ?? 220);
  return { x, y };
}

async function clickWithMotion(page, locator, opts = {}) {
  await moveMouseToLocator(page, locator, opts);
  await locator.click(opts.clickOpts || {});
}

/**
 * Scrolls the page down smoothly and slowly for the camera. Deliberately
 * uses window.scrollBy (not page.mouse.wheel) - on the incident edit form,
 * a wheel event landing on whatever happens to be under the fixed cursor
 * position as content scrolls past it can land on a native
 * <input type="datetime-local"> and increment/decrement its value via the
 * browser's built-in scroll-to-adjust behavior, which marked the form dirty
 * and fired a real autosave PUT during testing - exactly the "no field
 * focus, no save" rule this read-only walkthrough must not break. A
 * programmatic scroll can't touch any element's value.
 */
async function wheelScroll(page, totalDy, opts = {}) {
  const steps = opts.steps ?? 6;
  const pause = opts.pause ?? 550;
  const perStep = totalDy / steps;
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "smooth" }), perStep);
    await page.waitForTimeout(pause);
  }
}

// ---------------------------------------------------------------------------
// Water-supply map helpers (verbatim mechanics from capture.mjs)
// ---------------------------------------------------------------------------

async function clusterBounds(page) {
  const markerCount = await page.locator(".maplibregl-marker").count();
  const boxes = [];
  for (let i = 0; i < markerCount; i++) {
    const box = await page.locator(".maplibregl-marker").nth(i).boundingBox();
    if (box) boxes.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  if (boxes.length === 0) return null;
  const meanX = boxes.reduce((s, b) => s + b.x, 0) / boxes.length;
  const meanY = boxes.reduce((s, b) => s + b.y, 0) / boxes.length;
  const dists = boxes.map((b) => Math.hypot(b.x - meanX, b.y - meanY));
  const sortedDists = [...dists].sort((a, b) => a - b);
  const medianDist = sortedDists[Math.floor(sortedDists.length / 2)];
  const inliers = boxes.filter((b, i) => dists[i] <= Math.max(medianDist * 3, 50));
  const cx = inliers.reduce((s, b) => s + b.x, 0) / inliers.length;
  const cy = inliers.reduce((s, b) => s + b.y, 0) / inliers.length;
  const minX = Math.min(...inliers.map((b) => b.x));
  const maxX = Math.max(...inliers.map((b) => b.x));
  const minY = Math.min(...inliers.map((b) => b.y));
  const maxY = Math.max(...inliers.map((b) => b.y));
  return { cx, cy, minX, maxX, minY, maxY, count: inliers.length, total: boxes.length };
}

async function panBy(page, viewport, dx, dy) {
  const startX = viewport.width / 2;
  const startY = viewport.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
}

async function zoomAndRecenterOnce(page, viewport, wheelDelta) {
  const before = await clusterBounds(page);
  if (!before) return;
  await page.mouse.move(before.cx, before.cy, { steps: 16 });
  await page.waitForTimeout(200);
  await page.mouse.wheel(0, wheelDelta);
  await page.waitForTimeout(2500);

  const after = await clusterBounds(page);
  if (!after) return;
  const dx = viewport.width / 2 - (after.minX + after.maxX) / 2;
  const dy = viewport.height / 2 - (after.minY + after.maxY) / 2;
  await panBy(page, viewport, dx, dy);
  await page.waitForTimeout(1500);
}

async function allMarkers(page) {
  const markerCount = await page.locator(".maplibregl-marker").count();
  const markers = [];
  for (let i = 0; i < markerCount; i++) {
    const el = page.locator(".maplibregl-marker").nth(i);
    const box = await el.boundingBox();
    const text = (await el.innerText().catch(() => "")).trim();
    if (box) markers.push({ text, box, el });
  }
  return markers;
}

/** A marker whose label is NOT a cluster count (i.e. an individual, clickable pin). */
function firstIndividualMarker(markers) {
  return markers.find((m) => !Number.isFinite(parseInt(m.text, 10))) || null;
}

// ---------------------------------------------------------------------------
// Clip A: NERIS incident reporting walkthrough (read-only)
// ---------------------------------------------------------------------------

async function recordClipA(browser) {
  const videoDir = path.join(VIDEO_TMP_DIR, "clip-a");
  fs.rmSync(videoDir, { recursive: true, force: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    storageState: STORAGE_STATE_PATH,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  await installCaptionBar(page);

  const t0 = Date.now();
  log("Clip A: navigating to /incidents...");
  await page.goto(BASE_URL + "/incidents", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr").length >= 5,
    undefined,
    { timeout: 20000 }
  );
  await page.waitForTimeout(600);
  // Mark when the cold-cache first-load spinner is genuinely gone and real
  // content is on screen - the recorded context always eats several seconds
  // of "Loading..." here (fresh profile, no HTTP cache), which post-
  // processing trims from the front of the final clip.
  const readyMarkMs = Date.now() - t0;

  await setCaption(page, "One incident, entered once.", 0);
  await page.waitForTimeout(7000);

  // RFD-2026-094: FIRE type, ~60% complete, real address/date/type data - the
  // same known-good demo incident capture.mjs uses for its incident-edit
  // screenshot, so the walkthrough shows a representative filled-in report
  // rather than a blank shell.
  const searchBox = page.locator('input[placeholder*="Search"]').first();
  await moveMouseToLocator(page, searchBox);
  await searchBox.click();
  await searchBox.fill("RFD-2026-094");
  await page.waitForTimeout(1400);
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr").length >= 1,
    undefined,
    { timeout: 10000 }
  );

  const row = page.locator("table tbody tr", { hasText: "RFD-2026-094" }).first();
  const rowCell = row.locator("td").nth(1);
  await clickWithMotion(page, rowCell);
  await page.waitForTimeout(2200);

  await setCaption(page, "NERIS-aligned fields, built in.", 400);

  const editButton = page.getByRole("button", { name: "Edit Incident" });
  await editButton.waitFor({ timeout: 15000 });
  await clickWithMotion(page, editButton);
  await page
    .getByText("Loading incident")
    .waitFor({ state: "hidden", timeout: 20000 })
    .catch(() => {});
  await page.getByText("Incident Overview", { exact: false }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);

  const sectionHeader = page.getByText("1. Incident Overview");
  await clickWithMotion(page, sectionHeader);
  await page.waitForTimeout(1400);

  // Scroll slowly through the expanded section - read-only, no field focus.
  await wheelScroll(page, 1700, { steps: 8, pause: 850 });

  // Scroll back up so the section header (with its validation pill/badge) is
  // back in frame for the validation caption beat.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(400);
  await sectionHeader.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);

  await setCaption(
    page,
    "Validation catches problems before you submit, not after it bounces.",
    500
  );
  await page.waitForTimeout(7000);

  await setCaption(
    page,
    "LadderOps.\nNERIS reporting for volunteer and combo departments.\nladderops.tech",
    500
  );
  await page.waitForTimeout(7500);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Clip A: scripted duration ~${elapsed}s`);

  await context.close();
  const video = page.video();
  const recordedPath = video ? await video.path() : null;
  return { recordedPath, readyMarkMs };
}

// ---------------------------------------------------------------------------
// Clip B: Water supply & hydrant mapping (read-only)
// ---------------------------------------------------------------------------

async function recordClipB(browser) {
  const videoDir = path.join(VIDEO_TMP_DIR, "clip-b");
  fs.rmSync(videoDir, { recursive: true, force: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    storageState: STORAGE_STATE_PATH,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  await installCaptionBar(page);

  const t0 = Date.now();
  log("Clip B: navigating to /water-sources...");
  await page.goto(BASE_URL + "/water-sources", { waitUntil: "domcontentloaded" });
  const mapButton = page.getByRole("button", { name: "Map" });
  await mapButton.waitFor({ timeout: 15000 });
  // Same cold-cache-spinner reasoning as Clip A - mark real content, trim later.
  const readyMarkMs = Date.now() - t0;

  await setCaption(page, "Hydrants, dry hydrants, cisterns, draft sites. One map.", 400);
  await clickWithMotion(page, mapButton);
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(4500); // map tiles + marker clustering settle
  await page.waitForTimeout(2000);

  await setCaption(page, "NFPA 291 flow data built in.", 400);
  // Same wheel-zoom + recenter sequence capture.mjs uses on this map, run a
  // few passes so markers spread from one packed cluster into distinguishable
  // pins.
  await zoomAndRecenterOnce(page, VIEWPORT, -1800);
  await page.mouse.move(24, 24);
  await page.waitForTimeout(600);
  await zoomAndRecenterOnce(page, VIEWPORT, -1800);
  await page.mouse.move(24, 24);
  await page.waitForTimeout(600);
  await zoomAndRecenterOnce(page, VIEWPORT, -1600);
  await page.waitForTimeout(1200);

  const markers = await allMarkers(page);
  const individual = firstIndividualMarker(markers);
  if (individual) {
    const target = page.locator(".maplibregl-marker").nth(markers.indexOf(individual));
    await clickWithMotion(page, target);
    await page.waitForTimeout(2200);
  }

  await setCaption(page, "Built for tanker task forces, not city grids.", 500);
  await page.waitForTimeout(5200);

  await setCaption(page, "Part of the LadderOps platform.\nladderops.tech", 500);
  await page.waitForTimeout(5500);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Clip B: scripted duration ~${elapsed}s`);

  await context.close();
  const video = page.video();
  const recordedPath = video ? await video.path() : null;
  return { recordedPath, readyMarkMs };
}

// ---------------------------------------------------------------------------
// Clip C: Quartermaster asset register + detail (read-only)
// ---------------------------------------------------------------------------

async function recordClipQmAssets(browser) {
  const videoDir = path.join(VIDEO_TMP_DIR, "clip-qm-assets");
  fs.rmSync(videoDir, { recursive: true, force: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    storageState: STORAGE_STATE_PATH,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  await installCaptionBar(page);

  const t0 = Date.now();
  log("Clip QM-assets: navigating to /quartermaster/assets...");
  await page.goto(BASE_URL + "/quartermaster/assets", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr").length >= 8,
    undefined,
    { timeout: 20000 }
  );
  await page.waitForTimeout(600);
  // Same cold-cache-spinner reasoning as clips A/B - mark real content, trim later.
  const readyMarkMs = Date.now() - t0;

  await setCaption(page, "Every SCBA, every saw, every radio. One register.", 0);
  await page.waitForTimeout(6000);

  // Slow hover-scroll down the table body (mouse wheel over the table, not
  // window.scrollBy - the table sits in its own inner overflow-auto div) so
  // the full mixed-gear register is visibly on screen for the camera, then
  // settle back near the top before clicking in.
  const tableBody = page.locator("table tbody").first();
  const tableBox = await tableBody.boundingBox();
  if (tableBox) {
    await page.mouse.move(tableBox.x + tableBox.width / 2, tableBox.y + tableBox.height / 2);
  }
  await page.mouse.wheel(0, 220);
  await page.waitForTimeout(1600);
  await page.mouse.wheel(0, 220);
  await page.waitForTimeout(1600);
  await page.mouse.wheel(0, -440);
  await page.waitForTimeout(1400);
  await page.waitForTimeout(4500);

  // SCBA-12 carries a real custody assignment (issued to Engine 1) so the
  // detail view's Custodian field shows actual data, not "None".
  const row = page.locator("table tbody tr", { hasText: "SCBA-12" }).first();
  const rowCell = row.locator("td").first();
  await clickWithMotion(page, rowCell);
  await page
    .getByText("Loading asset")
    .waitFor({ state: "hidden", timeout: 15000 })
    .catch(() => {});
  await page.getByText("SCBA-12", { exact: true }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);

  await setCaption(page, "Status, assignment, and service history on every asset.", 400);
  // Scroll slowly through Status/Condition/Custodian, then the Compliance
  // (service/inspection due-state) and Custody history sections below the
  // fold - read-only, no field focus.
  await wheelScroll(page, 1000, { steps: 8, pause: 900 });
  await page.waitForTimeout(7000);

  // NOTE: this build's Asset model has a parent_asset_id column, but there is
  // no composite/parent-child UI anywhere in the frontend (no way to set or
  // view it) - confirmed by reading lib/types/quartermaster.ts and every
  // quartermaster page/component. Per the shoot brief, the "truck knows
  // what's on the truck" composite-asset caption is skipped entirely rather
  // than staged against a feature that doesn't exist in the UI.

  await setCaption(
    page,
    "LadderOps Quartermaster.\nPart of the platform.\nladderops.tech",
    500
  );
  await page.waitForTimeout(12000);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Clip QM-assets: scripted duration ~${elapsed}s`);

  await context.close();
  const video = page.video();
  const recordedPath = video ? await video.path() : null;
  return { recordedPath, readyMarkMs };
}

// ---------------------------------------------------------------------------
// Clip D: Quartermaster QR label sheet (read-only, scope-filter click only)
// ---------------------------------------------------------------------------

async function recordClipQmQrLabels(browser) {
  const videoDir = path.join(VIDEO_TMP_DIR, "clip-qm-qr-labels");
  fs.rmSync(videoDir, { recursive: true, force: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    storageState: STORAGE_STATE_PATH,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  await installCaptionBar(page);

  const t0 = Date.now();
  // Enter through the Quartermaster hub (card launcher) rather than deep-
  // linking straight to /quartermaster/assets or /quartermaster/print: every
  // subsequent hop below is a HubCard click (components/layout/hub-card.tsx
  // uses next/navigation's router.push, a client-side transition) or a
  // page.goBack() through that same client-side history, so only THIS one
  // page.goto ever triggers a full document reload/loading spinner. An
  // earlier version of this clip did a second page.goto (assets -> print)
  // mid-recording, which produced a real multi-second blank "Loading..."
  // screen inside the finished clip - the postProcess trim only removes the
  // cold-load prefix at the very front, not a loading flash in the middle.
  log("Clip QM-qr-labels: navigating to /quartermaster (hub)...");
  await page.goto(BASE_URL + "/quartermaster", { waitUntil: "domcontentloaded" });
  const assetRegisterCard = page.getByRole("button", { name: "Asset Register" });
  const printLabelsCard = page.getByRole("button", { name: "Print labels" });
  await assetRegisterCard.waitFor({ timeout: 20000 });
  await printLabelsCard.waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  // Same cold-cache-spinner reasoning as clips A/B - mark real content, trim later.
  const readyMarkMs = Date.now() - t0;

  await clickWithMotion(page, assetRegisterCard);
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr").length >= 8,
    undefined,
    { timeout: 20000 }
  );
  await page.waitForTimeout(2600);

  log("Clip QM-qr-labels: back to hub, then into Print labels...");
  await page.goBack({ waitUntil: "domcontentloaded" });
  await printLabelsCard.waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await clickWithMotion(page, printLabelsCard);
  const assetsScopeButton = page.getByRole("button", { name: "Assets", exact: true });
  await assetsScopeButton.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);

  await setCaption(page, "Pick the gear. One click.", 400);
  // Default scope is "All" (assets + storage locations); one click on
  // "Assets" narrows the sheet to just gear labels.
  await clickWithMotion(page, assetsScopeButton);
  await page.waitForTimeout(3600);

  await setCaption(page, "A printable QR label sheet, straight from the browser.", 500);
  await wheelScroll(page, 700, { steps: 6, pause: 800 });
  await page.waitForTimeout(3000);

  await setCaption(page, "Every label points at the asset's live record.", 500);
  // Each label card's "Asset" kind tag is a leaf <span> with that exact text;
  // its parent is the label card div. More precise than a class-substring
  // selector, since every card/child element's CSS-module class contains
  // the literal string "label" (labelKind, labelTag, labelQr, labelGrid...).
  const firstLabelKind = page.getByText("Asset", { exact: true }).first();
  const firstLabel = firstLabelKind.locator("xpath=..");
  await moveMouseToLocator(page, firstLabel, { steps: 20, settleMs: 300 });
  await page.waitForTimeout(6200);

  await setCaption(page, "LadderOps Quartermaster.\nladderops.tech", 500);
  await page.waitForTimeout(6300);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Clip QM-qr-labels: scripted duration ~${elapsed}s`);

  await context.close();
  const video = page.video();
  const recordedPath = video ? await video.path() : null;
  return { recordedPath, readyMarkMs };
}

// ---------------------------------------------------------------------------
// Post-processing: trim cold-load prefix, encode h264 mp4, extract 6 stills
// ---------------------------------------------------------------------------

function ffprobeDuration(filePath) {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]).toString().trim();
  return parseFloat(out);
}

/**
 * Trims the cold-cache loading prefix (readyMarkMs, minus a small lead-in so
 * the very first frames of the deliverable already show real content) off
 * the raw Playwright .webm, re-encodes it to h264 mp4, and extracts 6 evenly
 * spaced still frames alongside it.
 */
function postProcess(rawVideoPath, readyMarkMs, outName) {
  const trimStart = Math.max(0, readyMarkMs / 1000 - 0.3);
  const mp4Path = path.join(DELIVERY_DIR, `${outName}.mp4`);

  log(`Encoding ${outName}.mp4 (trimming ${trimStart.toFixed(2)}s cold-load prefix)...`);
  execFileSync("ffmpeg", [
    "-y",
    "-i",
    rawVideoPath,
    "-ss",
    trimStart.toFixed(2),
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Path,
  ]);

  const duration = ffprobeDuration(mp4Path);
  log(`${outName}.mp4 duration: ${duration.toFixed(1)}s`);

  const frameCount = 6;
  const framePaths = [];
  for (let i = 1; i <= frameCount; i++) {
    const t = (duration * i) / (frameCount + 1);
    const framePath = path.join(FRAMES_DIR, `${outName}_f${i}.png`);
    execFileSync("ffmpeg", [
      "-y",
      "-ss",
      t.toFixed(2),
      "-i",
      mp4Path,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-q:v",
      "2",
      framePath,
    ]);
    framePaths.push(framePath);
  }

  return { mp4Path, duration, framePaths };
}

// ---------------------------------------------------------------------------

async function main() {
  const which = process.argv[2] || "all";
  const browser = await chromium.launch({ headless: true });
  const outputs = {};
  try {
    await buildAuthenticatedStorageState(browser);

    if (which === "all" || which === "clip-a") {
      const { recordedPath, readyMarkMs } = await recordClipA(browser);
      log(`Clip A raw video: ${recordedPath} (readyMark ${readyMarkMs}ms)`);
      outputs.clipA = postProcess(recordedPath, readyMarkMs, "clip-3-neris-reporting");
    }
    if (which === "all" || which === "clip-b") {
      const { recordedPath, readyMarkMs } = await recordClipB(browser);
      log(`Clip B raw video: ${recordedPath} (readyMark ${readyMarkMs}ms)`);
      outputs.clipB = postProcess(recordedPath, readyMarkMs, "clip-5-water-supply");
    }
    if (which === "qm-assets" || which === "qm-all") {
      const { recordedPath, readyMarkMs } = await recordClipQmAssets(browser);
      log(`Clip QM-assets raw video: ${recordedPath} (readyMark ${readyMarkMs}ms)`);
      outputs.clipQmAssets = postProcess(recordedPath, readyMarkMs, "clip-qm-assets");
    }
    if (which === "qm-qr-labels" || which === "qm-all") {
      const { recordedPath, readyMarkMs } = await recordClipQmQrLabels(browser);
      log(`Clip QM-qr-labels raw video: ${recordedPath} (readyMark ${readyMarkMs}ms)`);
      outputs.clipQmQrLabels = postProcess(recordedPath, readyMarkMs, "clip-qm-qr-labels");
    }
  } finally {
    await browser.close();
  }

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(outputs, null, 2));
  log(`Manifest written to ${manifestPath}`);
  log(`Deliverables in ${DELIVERY_DIR}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
