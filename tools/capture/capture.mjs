#!/usr/bin/env node
// Automated screenshot rig for the LadderOps marketing site.
// Logs into LadderOps staging as a demo tenant_admin, waits for real data to
// render, and captures desktop + mobile PNGs of the live product UI into
// screenshots-v2/ at the repo root.
//
// Usage: node capture.mjs

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../screenshots-v2");

const BASE_URL = process.env.CAPTURE_BASE_URL || "https://staging.ladderops.tech";
const USERNAME = process.env.CAPTURE_USERNAME || "chief";
const TENANT = process.env.CAPTURE_TENANT || "ridgeview";

// No default. This repository is public, and a password with a fallback
// value here is a working credential for an internet-facing environment
// published to anyone who clones it. Supply it in the environment:
//
//   CAPTURE_PASSWORD=... node capture.mjs
//
// Fails immediately rather than part-way through a login, so the error
// names the cause instead of surfacing as a stuck selector.
const PASSWORD = process.env.CAPTURE_PASSWORD;
if (!PASSWORD) {
  console.error(
    "[capture] CAPTURE_PASSWORD is not set.\n" +
      "  This script signs in to a deployed environment, so the password is\n" +
      "  supplied at run time and never committed. Export it and re-run.",
  );
  process.exit(1);
}

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MIN_FILE_BYTES = 30 * 1024;

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = []; // { name, ok, bytes, note }
const skips = []; // { page, reason }

function log(msg) {
  console.log(`[capture] ${msg}`);
}

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
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.waitForTimeout(400);
  const htmlClass = await page.locator("html").getAttribute("class");
  if (!htmlClass || !htmlClass.includes("light")) {
    throw new Error(`Theme toggle did not switch to light (html class="${htmlClass}")`);
  }
}

/** Hard-fail a capture if we somehow ended up back on the login page. */
async function assertNotLoginPage(page, label) {
  const hasPasswordField = await page.locator("#password").isVisible().catch(() => false);
  if (hasPasswordField) {
    throw new Error(`${label}: still on login page (password field visible)`);
  }
}

async function shoot(page, name, opts = {}) {
  await assertNotLoginPage(page, name);
  const filePath = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false, ...opts });
  const stat = fs.statSync(filePath);
  const ok = stat.size >= MIN_FILE_BYTES;
  results.push({ name, ok, bytes: stat.size });
  log(`${ok ? "OK" : "TOO SMALL"} ${name}.png (${(stat.size / 1024).toFixed(1)} KB)`);
  if (!ok) {
    throw new Error(`${name}.png is only ${stat.size} bytes (< ${MIN_FILE_BYTES})`);
  }
  return filePath;
}

async function waitForRows(page, selector, minCount = 1, timeout = 20000) {
  await page.waitForFunction(
    ({ sel, min }) => document.querySelectorAll(sel).length >= min,
    { sel: selector, min: minCount },
    { timeout }
  );
}

async function safeStep(label, fn) {
  try {
    await fn();
  } catch (err) {
    log(`SKIP ${label}: ${err.message.split("\n")[0]}`);
    skips.push({ page: label, reason: err.message.split("\n")[0] });
  }
}

// ---------------------------------------------------------------------------
// Message seeding (realistic department broadcasts for the messages capture)
// ---------------------------------------------------------------------------

const SEED_BROADCASTS = [
  {
    subject: "Pump Training Moved to Thursday",
    body: "Heads up: this week's pump training has been moved to Thursday at 1900 hours at Station 1. Bring your turnout gear, we will be running full relay evolutions off the pond. Contact Chief if you have a scheduling conflict.",
  },
  {
    subject: "Hydrant Flushing This Saturday - North Side",
    body: "Public Works will be flushing hydrants on the north side of town this Saturday starting at 0800. Expect discolored water in that area through midday. Crews running the flush should log any hydrants found inoperable in the water supply module.",
  },
  {
    subject: "Welcome Our New Probationary Members",
    body: "Please give a warm welcome to our two newest probationary members, who joined the department this month. They will be riding along and training with each shift over the next few weeks, so introduce yourselves and help them get squared away.",
  },
];

/**
 * Sends the seed broadcasts via the real Compose UI, skipping any whose
 * subject is already present in Sent (idempotent across repeated rig runs -
 * otherwise every re-run would pile up duplicate broadcasts on staging).
 */
async function seedMessages(page) {
  // "Inbox"/"Sent" and "Direct Message"/"Broadcast" are Radix Tabs
  // (role="tab"), not plain buttons.
  await page.getByRole("tab", { name: "Sent", exact: true }).click();
  await page.waitForTimeout(800);

  for (const msg of SEED_BROADCASTS) {
    const alreadySent = await page.getByText(msg.subject, { exact: true }).count();
    if (alreadySent > 0) {
      log(`Broadcast already seeded: "${msg.subject}" - skipping`);
      continue;
    }
    log(`Seeding broadcast: "${msg.subject}"`);
    await page.getByRole("button", { name: "Compose" }).click();
    await page.waitForTimeout(600);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Broadcast", exact: true }).click();
    await page.waitForTimeout(400);
    await dialog.locator('input[placeholder="Enter message subject..."]').fill(msg.subject);
    await dialog.locator('textarea[placeholder="Enter your message..."]').fill(msg.body);
    await dialog.getByRole("button", { name: "Send Message" }).click();
    await page
      .getByText("Broadcast sent to all personnel")
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    await page.waitForTimeout(1200);
  }
}

// ---------------------------------------------------------------------------
// Quartermaster seeding: storage locations + assets
// ---------------------------------------------------------------------------

const SEED_STORAGE_LOCATIONS = [
  "Station 1 - Bay 2",
  "Station 1 - SCBA Room",
  "Engine 1 - Cab Compartment",
  "Rescue 2 - Compartment 3",
  "Station 1 - Turnout Gear Room",
];

/**
 * Seeds a handful of realistic storage locations. These back the optional
 * Location field on the "New asset" dialog below - seeding them first means
 * seedQuartermasterAssets() can place each asset somewhere real instead of
 * leaving every row's Location as "None". Idempotent - mirrors
 * seedMessages()'s check-before-create pattern so repeated rig runs don't
 * pile up duplicates.
 */
async function seedQuartermasterLocations(page) {
  for (const name of SEED_STORAGE_LOCATIONS) {
    const alreadyExists = await page.getByText(name, { exact: true }).count();
    if (alreadyExists > 0) {
      log(`Storage location already seeded: "${name}" - skipping`);
      continue;
    }
    log(`Seeding storage location: "${name}"`);
    await page.getByRole("button", { name: "New location" }).first().click();
    await page.waitForTimeout(800);
    const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
    await dialog.locator('input[placeholder="e.g. Bay 2 / Shelf A"]').fill(name);
    await dialog.getByRole("button", { name: "Create" }).click();
    await page.waitForTimeout(1500);
  }
}

// The ridgeview catalog only has 4 asset types seeded (an NFPA PPE/hose/
// ladder/SCBA starter set: Fire Hose, Ground Ladder, SCBA Pack, Turnout
// Gear) - there's no "electronics" or "power tools" category, so every
// seeded asset tag below is chosen to genuinely match one of those 4 types
// rather than forcing a mismatched one into the register.
const SEED_ASSETS = [
  { tag: "SCBA-12", type: "SCBA Pack", status: "In Service", location: "Station 1 - SCBA Room", condition: "Good" },
  { tag: "LADR-24", type: "Ground Ladder", status: "In Service", location: "Station 1 - Bay 2", condition: "Good" },
  { tag: "HOSE-14", type: "Fire Hose", status: "In Service", location: "Engine 1 - Cab Compartment", condition: "New" },
  { tag: "HOSE-22", type: "Fire Hose", status: "In Service", location: "Rescue 2 - Compartment 3", condition: "Good" },
  {
    tag: "TURN-07",
    type: "Turnout Gear",
    status: "In Service",
    location: "Station 1 - Turnout Gear Room",
    condition: "Fair",
  },
];

/**
 * Selects an option from a Radix Select combobox trigger button by its
 * accessible name. Radix renders the option list in a portal appended to
 * <body>, not inside the dialog, so the option locator must be page-scoped
 * rather than dialog-scoped.
 */
async function selectComboboxOption(page, trigger, optionName) {
  await trigger.click();
  await page.waitForTimeout(500);
  await page.getByRole("option", { name: optionName, exact: true }).click();
  await page.waitForTimeout(300);
}

/**
 * Quartermaster's Asset Register now has a real "New asset" create dialog
 * (asset tag, type, status required; location/condition/serial/notes
 * optional) - confirmed against staging. Seeds a handful of realistic
 * assets through that dialog, idempotently by asset tag - mirrors
 * seedMessages()'s check-before-create pattern so repeated rig runs don't
 * pile up duplicates.
 */
async function seedQuartermasterAssets(page) {
  for (const asset of SEED_ASSETS) {
    const alreadyExists = await page.getByText(asset.tag, { exact: true }).count();
    if (alreadyExists > 0) {
      log(`Asset already seeded: "${asset.tag}" - skipping`);
      continue;
    }
    log(`Seeding asset: "${asset.tag}" (${asset.type})`);
    await page.getByRole("button", { name: "New asset" }).first().click();
    await page.waitForTimeout(1000);
    const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
    const combos = dialog.locator('button[role="combobox"]');
    await dialog.locator("#asset-tag").fill(asset.tag);
    // Combobox order in the dialog: Asset type, Status, Location, Condition.
    await selectComboboxOption(page, combos.nth(0), asset.type);
    await selectComboboxOption(page, combos.nth(1), asset.status);
    await selectComboboxOption(page, combos.nth(2), asset.location);
    await selectComboboxOption(page, combos.nth(3), asset.condition);
    await dialog.getByRole("button", { name: "Create" }).click();
    await page.waitForTimeout(1800);
  }
}

// ---------------------------------------------------------------------------
// Water-supply map: zoom the marker cluster in and recenter it
// ---------------------------------------------------------------------------

/**
 * Returns the pixel centroid + bounding box of the densest cluster of
 * MapLibre marker DOM nodes (filters out far-flung single outlier pins so
 * they don't skew the centroid).
 */
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

/** Drags the map by (dx, dy) screen pixels via a multi-step mouse drag. */
async function panBy(page, viewport, dx, dy) {
  const startX = viewport.width / 2;
  const startY = viewport.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
}

/**
 * Zooms the map in on the current cluster centroid via mouse wheel (wheel
 * events don't trigger the markers' own click-to-navigate handlers the way
 * a click/dblclick landing on a marker DOM node would), then pans to
 * recenter the now-spread-out cluster in the viewport. Markers pack so
 * tightly at the default zoom that a single zoom pass only spreads them a
 * little; multiple zoom+recenter passes progressively spread them into
 * individually distinguishable pins while keeping the whole group in frame.
 */
async function zoomAndRecenterOnce(page, viewport, wheelDelta) {
  const before = await clusterBounds(page);
  if (!before) return;
  await page.mouse.move(before.cx, before.cy);
  await page.mouse.wheel(0, wheelDelta);
  await page.waitForTimeout(2500);

  const after = await clusterBounds(page);
  if (!after) return;
  const dx = viewport.width / 2 - (after.minX + after.maxX) / 2;
  const dy = viewport.height / 2 - (after.minY + after.maxY) / 2;
  await panBy(page, viewport, dx, dy);
  await page.waitForTimeout(1500);
}

/** Returns { text, box } for every MapLibre marker currently in the DOM. */
async function allMarkers(page) {
  const markerCount = await page.locator(".maplibregl-marker").count();
  const markers = [];
  for (let i = 0; i < markerCount; i++) {
    const el = page.locator(".maplibregl-marker").nth(i);
    const box = await el.boundingBox();
    const text = (await el.innerText().catch(() => "")).trim();
    if (box) markers.push({ text, box });
  }
  return markers;
}

/** The marker with the highest numeric cluster-count label (e.g. "17"), or null if none remain. */
function largestNumberedMarker(markers) {
  let best = null;
  for (const m of markers) {
    const n = parseInt(m.text, 10);
    if (!Number.isFinite(n)) continue;
    if (!best || n > best.n) best = { n, box: m.box };
  }
  return best;
}

/**
 * Zooms in via mouse wheel centered on a specific page-pixel point, then
 * recenters on whichever marker ends up closest to that same point.
 *
 * Deliberately NOT clusterBounds() (which the water-supply capture above uses
 * fine, because it only ever has one dominant cluster on screen): when two
 * unrelated clusters share the viewport - as the inspections map does, a
 * small "3" bubble near Fennimore plus a big "17" bubble near Mineral Point -
 * clusterBounds()'s single averaged centroid lands the pan between the two
 * clusters instead of on either one. Recentering on "whichever marker is now
 * closest to the pre-zoom target point" instead tracks one specific cluster
 * through repeated zoom passes as it progressively splits into smaller
 * sub-clusters and finally into individually distinguishable pins.
 */
async function zoomAndRecenterOnPoint(page, viewport, cx, cy, wheelDelta) {
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, wheelDelta);
  await page.waitForTimeout(2500);

  const markers = await allMarkers(page);
  let closest = null;
  let closestDist = Infinity;
  for (const m of markers) {
    const mx = m.box.x + m.box.width / 2;
    const my = m.box.y + m.box.height / 2;
    const d = Math.hypot(mx - cx, my - cy);
    if (d < closestDist) {
      closestDist = d;
      closest = { x: mx, y: my };
    }
  }
  if (closest) {
    const dx = viewport.width / 2 - closest.x;
    const dy = viewport.height / 2 - closest.y;
    await panBy(page, viewport, dx, dy);
    await page.waitForTimeout(1500);
  }
}

// ---------------------------------------------------------------------------
// Desktop captures
// ---------------------------------------------------------------------------

async function captureDesktop(browser) {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  log("Desktop: logging in...");
  await login(page);
  await switchToLightTheme(page);

  await safeStep("dashboard", async () => {
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 1);
    await page.waitForTimeout(500);
    await shoot(page, "dashboard");
  });

  await safeStep("incidents-list", async () => {
    await page.goto(BASE_URL + "/incidents", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 5);
    await page.waitForTimeout(500);
    await shoot(page, "incidents-list");
  });

  await safeStep("incident-edit", async () => {
    // RFD-2026-094: FIRE, 60% complete, has real address/date/type data filled
    // in - representative of a working NERIS report rather than a blank shell.
    await page.goto(BASE_URL + "/incidents", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 1);
    await page.locator('input[placeholder*="Search"]').fill("RFD-2026-094");
    await page.waitForTimeout(1200);
    await waitForRows(page, "table tbody tr", 1);
    await page.locator("table tbody tr", { hasText: "RFD-2026-094" }).first().locator("td").nth(1).click();
    await page.waitForTimeout(2000);
    // Direct navigation to /edit hangs indefinitely (client-only route state);
    // clicking through from the detail page is the reliable path.
    await page.getByRole("button", { name: "Edit Incident" }).click();
    await page.getByText("Loading incident").waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
    await page.getByText("Incident Overview", { exact: false }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    // Expand section 1 so the screenshot shows real filled-in fields, not just
    // the collapsed accordion.
    await page.getByText("1. Incident Overview").click();
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await shoot(page, "incident-edit");
  });

  await safeStep("status-board", async () => {
    await page.goto(BASE_URL + "/status", { waitUntil: "domcontentloaded" });
    await page.getByText("Full roster & units").waitFor({ timeout: 15000 });
    // The "Full roster & units" chrome renders before the personnel/unit
    // counts hydrate (briefly shows PERSONNEL 0 / UNITS 0 + a skeleton).
    // Wait for a real breakdown badge to confirm counts have loaded.
    await page.getByText("Off Duty", { exact: false }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await shoot(page, "status-board");
  });

  await safeStep("personnel", async () => {
    await page.goto(BASE_URL + "/personnel", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 5);
    await page.waitForTimeout(500);
    await shoot(page, "personnel");
  });

  await safeStep("apparatus", async () => {
    await page.goto(BASE_URL + "/apparatus", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 5);
    await page.waitForTimeout(500);
    await shoot(page, "apparatus");
  });

  await safeStep("water-supply", async () => {
    await page.goto(BASE_URL + "/water-sources", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Map" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Map" }).click();
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForTimeout(5000); // map tiles + marker clustering settle
    // Default view packs ~100 markers into a tight cluster (a few dozen px
    // across) at a multi-state extent. The map's "+" control zooms on map
    // center (pans the cluster off-screen) and clicking a marker navigates
    // straight to that source's detail page instead of zooming - both worse
    // than the plain default view. Mouse-wheel zoom centered on the cluster
    // centroid avoids the marker click-navigation trap, then a pan recenters
    // the now-spread cluster in frame. Multiple passes spread the pins out
    // further; capture 3 increasingly-zoomed variants so a human can pick.
    await zoomAndRecenterOnce(page, DESKTOP_VIEWPORT, -1800);
    await page.mouse.move(20, 20);
    await page.waitForTimeout(300);
    await shoot(page, "water-supply-a");

    await zoomAndRecenterOnce(page, DESKTOP_VIEWPORT, -1800);
    await page.mouse.move(20, 20);
    await page.waitForTimeout(300);
    await shoot(page, "water-supply-b");

    await zoomAndRecenterOnce(page, DESKTOP_VIEWPORT, -1800);
    await page.mouse.move(20, 20);
    await page.waitForTimeout(300);
    await shoot(page, "water-supply-c");

    // water-supply-c (3 zoom+recenter passes) spreads the pins into
    // individually distinguishable markers while keeping the whole group in
    // frame - picked as the default water-supply.png. Re-review
    // water-supply-{a,b,c}.png by hand if the underlying seed data changes.
    fs.copyFileSync(path.join(OUT_DIR, "water-supply-c.png"), path.join(OUT_DIR, "water-supply.png"));
    const stat = fs.statSync(path.join(OUT_DIR, "water-supply.png"));
    results.push({ name: "water-supply", ok: stat.size >= MIN_FILE_BYTES, bytes: stat.size });
    log(`OK water-supply.png copied from water-supply-c.png (${(stat.size / 1024).toFixed(1)} KB)`);
  });

  await safeStep("pre-plans", async () => {
    await page.goto(BASE_URL + "/pre-plans", { waitUntil: "domcontentloaded" });
    await page.getByText("Pre-Plans", { exact: true }).waitFor({ timeout: 15000 });
    await waitForRows(page, "table tbody tr", 1);
    await page.waitForTimeout(500);
    await shoot(page, "pre-plans");
  });

  await safeStep("occupancies", async () => {
    await page.goto(BASE_URL + "/occupancies", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 5);
    await page.waitForTimeout(500);
    await shoot(page, "occupancies");
  });

  await safeStep("inspections", async () => {
    // Map view is richer than the current week's (empty) calendar and shows
    // the geographic clustering feature.
    await page.goto(BASE_URL + "/modules/inspections", { waitUntil: "domcontentloaded" });
    await page.getByText("Schedule", { exact: true }).waitFor({ timeout: 15000 });
    await page.getByText("Schedule", { exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForTimeout(2500);

    // Default view has TWO separate cluster bubbles: a small "3" near
    // Fennimore (west) and a big "17" near Mineral Point (east) - a single
    // collapsed "17" bubble isn't useful for marketing ("schedule against
    // individual occupancies"). Bias the first zoom pass at the "17" bubble
    // specifically (a naive clusterBounds() centroid over both bubbles would
    // land between them, on neither), then keep tracking whichever
    // sub-cluster remains largest each subsequent pass via
    // zoomAndRecenterOnPoint. Two passes was enough in testing to fully
    // separate all ~17 markers into individually distinguishable, named
    // occupancy pins; cap at 4 as a safety margin.
    let markers = await allMarkers(page);
    let target = largestNumberedMarker(markers);
    for (let pass = 0; pass < 4 && target; pass++) {
      const cx = target.box.x + target.box.width / 2;
      const cy = target.box.y + target.box.height / 2;
      await zoomAndRecenterOnPoint(page, DESKTOP_VIEWPORT, cx, cy, -1800);
      await page.mouse.move(20, 20);
      await page.waitForTimeout(300);
      markers = await allMarkers(page);
      target = largestNumberedMarker(markers);
    }
    await shoot(page, "inspections");
  });

  await safeStep("quartermaster", async () => {
    // Quartermaster lives under the "Apparatus & Equipment" hub (/hub/assets)
    // as its own card, at /quartermaster. The Asset Register
    // (/quartermaster/assets) now has a real "New asset" create dialog, so
    // seed real asset records for the most populated, authentic view of the
    // module - Storage Locations are seeded first only as a prerequisite
    // for the dialog's optional Location field.
    await page.goto(BASE_URL + "/quartermaster/storage-locations", { waitUntil: "domcontentloaded" });
    await page.getByText("Storage Locations", { exact: true }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await seedQuartermasterLocations(page);

    await page.goto(BASE_URL + "/quartermaster/assets", { waitUntil: "domcontentloaded" });
    await page.getByText("Asset Register", { exact: true }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await seedQuartermasterAssets(page);

    // Reload for a clean shot without a lingering "Asset created" toast.
    await page.goto(BASE_URL + "/quartermaster/assets", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 5);
    await page.waitForTimeout(500);
    await shoot(page, "quartermaster");
  });

  await safeStep("controlled-substances", async () => {
    // Controlled Substances lives under the "Personnel" hub (/hub/personnel)
    // as its own card, at /controlled-substances. Every sub-page (Narcotics
    // locker, Reconciliation, Reports) is genuinely read-only in this build -
    // no create/register UI anywhere for containers or catalog entries, so
    // there's nothing to seed. The module landing page is the most
    // informative authentic view available: real feature cards with
    // descriptive copy (Reconciliation, Narcotics locker, Reports including
    // DEA 222/41 references, plus a "Coming Soon" Field actions card).
    await page.goto(BASE_URL + "/controlled-substances", { waitUntil: "domcontentloaded" });
    await page.getByText("EMS narcotics chain of custody", { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await shoot(page, "controlled-substances");
  });

  await safeStep("billing", async () => {
    await page.goto(BASE_URL + "/billing", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 1);
    // Filter to "Sent" invoices: default listing includes throwaway draft
    // rows with test/personal names that don't belong on a marketing page.
    await page.getByRole("combobox").click();
    await page.waitForTimeout(300);
    await page.getByRole("option", { name: "Sent", exact: true }).click();
    await page.waitForTimeout(1000);
    await waitForRows(page, "table tbody tr", 1);
    await shoot(page, "billing");
  });

  await safeStep("reports", async () => {
    await page.goto(BASE_URL + "/reports", { waitUntil: "domcontentloaded" });
    await page.locator('button:has-text("Last 30 Days")').waitFor({ timeout: 15000 });
    // Widen the date range so the charts have enough data to look like a
    // real reporting dashboard instead of a near-empty 30-day window.
    await page.locator('button:has-text("Last 30 Days")').click();
    await page.waitForTimeout(300);
    await page.getByRole("option", { name: "Last 90 Days", exact: true }).click();
    await page.waitForTimeout(1500);
    // Recharts continuously re-renders <path> nodes during its draw-in
    // animation, which makes waitForSelector("svg path") flaky (state
    // toggles between attached/visible mid-poll). A plain svg presence
    // check plus a fixed settle is more reliable.
    await page.waitForSelector("svg", { state: "attached", timeout: 15000 });
    await page.waitForTimeout(2500);
    await shoot(page, "reports");
  });

  await safeStep("messages", async () => {
    await page.goto(BASE_URL + "/messages", { waitUntil: "domcontentloaded" });
    await page.getByText("Internal messaging and broadcasts").waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    // The capture account's inbox is genuinely empty (chief doesn't receive
    // its own broadcasts), so seed a few realistic department broadcasts via
    // the real Compose UI and capture the Sent view, which is what actually
    // has content. seedMessages() is idempotent - re-running the rig won't
    // pile up duplicates.
    await seedMessages(page);
    await page.getByRole("tab", { name: "Sent", exact: true }).click();
    await page.waitForTimeout(1000);
    await shoot(page, "messages");
  });

  await context.close();
}

// ---------------------------------------------------------------------------
// Mobile captures
// ---------------------------------------------------------------------------

async function captureMobile(browser) {
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();

  log("Mobile: logging in...");
  await login(page);
  await switchToLightTheme(page);

  await safeStep("dashboard-mobile", async () => {
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await waitForRows(page, "table tbody tr", 1);
    await page.waitForTimeout(500);
    await shoot(page, "dashboard-mobile");
  });

  await safeStep("incidents-list-mobile", async () => {
    await page.goto(BASE_URL + "/incidents", { waitUntil: "domcontentloaded" });
    await page.locator('input[placeholder*="Search incident"]').waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await shoot(page, "incidents-list-mobile");
  });

  await safeStep("status-board-mobile", async () => {
    await page.goto(BASE_URL + "/status", { waitUntil: "domcontentloaded" });
    await page.getByText("Full roster & units").waitFor({ timeout: 15000 });
    await page.getByText("Off Duty", { exact: false }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await shoot(page, "status-board-mobile");
  });

  await safeStep("incident-mobile", async () => {
    // Same RFD-2026-094 incident used on desktop - real filled-in data
    // rather than the mostly-N/A default row.
    await page.goto(BASE_URL + "/incidents", { waitUntil: "domcontentloaded" });
    await page.locator('input[placeholder*="Search incident"]').waitFor({ timeout: 15000 });
    await page.locator('input[placeholder*="Search incident"]').fill("RFD-2026-094");
    await page.waitForTimeout(1200);
    await page.getByText("RFD-2026-094", { exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "Edit Incident" }).click();
    await page.getByText("Loading incident").waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
    await page.getByText("Incident Overview", { exact: false }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await shoot(page, "incident-mobile");
  });

  await context.close();
}

// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    await captureDesktop(browser);
    await captureMobile(browser);
  } finally {
    await browser.close();
  }

  console.log("\n=== Capture summary ===");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}.png  ${(r.bytes / 1024).toFixed(1)} KB`);
  }
  if (skips.length) {
    console.log("\n=== Skipped pages ===");
    for (const s of skips) {
      console.log(`SKIP  ${s.page}: ${s.reason}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length} capture(s) failed the size check.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${results.length} screenshot(s) captured successfully into ${OUT_DIR}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
