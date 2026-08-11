#!/usr/bin/env node
/*
 * Browser smoke test.
 *
 * Loads the page in headless Chromium, starts a game, exercises the map and
 * every modal screen, fails on any console error or uncaught exception, and
 * writes screenshots to tools/shots/.
 *
 *   node tools/uitest.js [--headed]
 */
'use strict';

var path = require('path');
var fs = require('fs');
var cp = require('child_process');

/*
 * Playwright is an optional dev dependency; it is often only installed
 * globally.  Look for it in the usual places before giving up, and skip
 * (loudly) rather than fail the whole suite when it genuinely is not there.
 */
function loadPlaywright() {
  var candidates = [process.env.PW_ROOT, 'playwright'];
  try {
    candidates.push(path.join(cp.execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
  } catch (e) { /* npm not on PATH; keep going */ }
  for (var i = 0; i < candidates.length; i++) {
    if (!candidates[i]) continue;
    try { return require(candidates[i]); } catch (e) { /* try the next one */ }
  }
  return null;
}

var playwright = loadPlaywright();
if (!playwright) {
  console.log('SKIPPED: playwright is not installed. Install it with ' +
    '`npm i -D playwright`, or run `node tools/simtest.js` for the headless ' +
    'simulation checks only.');
  process.exit(0);
}
var chromium = playwright.chromium;

/** Playwright finds its own browser unless the bundle lives somewhere odd. */
function chromePath() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  var root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  var dirs = fs.readdirSync(root).filter(function (d) { return /^chromium-/.test(d); });
  for (var i = 0; i < dirs.length; i++) {
    var exe = path.join(root, dirs[i], 'chrome-linux', 'chrome');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

var ROOT = path.join(__dirname, '..');
var SHOTS = path.join(__dirname, 'shots');
var URL = 'file://' + path.join(ROOT, 'index.html');

if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

function fail(msg) { console.error('FAIL: ' + msg); process.exitCode = 1; }

(async function () {
  var browser = await chromium.launch({
    executablePath: chromePath(),
    args: ['--no-sandbox', '--allow-file-access-from-files']
  });
  var page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });

  var errors = [];
  page.on('console', function (m) {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#menu.show');
  await page.screenshot({ path: path.join(SHOTS, '01-menu.png') });

  // Deterministic seed and a fixed nation so runs are comparable.
  await page.fill('#seedInput', 'ui-test');
  await page.click('.nation-card:has-text("Mongolia")');
  await page.click('#startBtn');
  await page.waitForSelector('#game.show', { timeout: 20000 });
  await page.waitForTimeout(900);

  var info = await page.evaluate(function () {
    var s = SWW.game.current;
    return {
      player: s.playerId,
      provinces: s.nationById[s.playerId].provinces.length,
      armies: s.armies.length,
      seed: s.seed
    };
  });
  if (info.player !== 'mng') fail('nation selection ignored, got ' + info.player);
  if (info.provinces < 1) fail('player owns no provinces');
  console.log('started as ' + info.player + ' with ' + info.provinces + ' provinces, ' +
    info.armies + ' stacks on the map');
  await page.screenshot({ path: path.join(SHOTS, '02-map.png') });

  // Panel should be open on the capital.
  if (!(await page.locator('#panel.open').count())) fail('capital panel did not open');

  // Zoom out to see the whole world.
  await page.evaluate(function () {
    SWW.UI.renderer.camera.zoom = 2.2;
    SWW.UI.renderer.camera.x = 128;
    SWW.UI.renderer.camera.y = 58;
    SWW.UI.renderer.clampCamera();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '03-world.png') });

  // Select the player's own stack and issue a move order through the UI.
  var moved = await page.evaluate(function () {
    var s = SWW.game.current;
    var mine = s.armies.filter(function (a) { return a.ownerId === s.playerId; });
    if (!mine.length) return { ok: false, why: 'no armies' };
    SWW.UI.selectArmy(mine[0].id);
    var prov = s.provinces[mine[0].provinceId];
    var target = prov.neighbors.map(function (id) { return s.provinces[id]; })
      .filter(function (p) { return !p.isSea; })[0];
    if (!target) return { ok: false, why: 'no land neighbour' };
    SWW.UI.setTargeting('move');
    SWW.UI.resolveTargeting(target);
    return { ok: mine[0].path.length > 0, target: target.name, path: mine[0].path.length };
  });
  if (!moved.ok) fail('move order failed: ' + (moved.why || 'no path set'));
  else console.log('move order accepted -> ' + moved.target + ' (' + moved.path + ' legs)');
  await page.screenshot({ path: path.join(SHOTS, '04-army.png') });

  // Build something and research something through the real code paths.
  var actions = await page.evaluate(function () {
    var s = SWW.game.current;
    var nation = s.nationById[s.playerId];
    var cap = s.provinces[nation.capitalProvince];
    var build = SWW.orders.startConstruction(s, cap, 'recruiting');
    var tech = SWW.orders.startResearch(s, nation, 'conscription');
    return { build: build, tech: tech };
  });
  if (!actions.build.ok) fail('construction rejected: ' + actions.build.why);
  if (!actions.tech.ok) fail('research rejected: ' + actions.tech.why);

  // Every modal must open and render content.
  var screens = ['diplomacy', 'market', 'cities', 'research', 'more'];
  for (var i = 0; i < screens.length; i++) {
    await page.click('.nav-btn[data-nav="' + screens[i] + '"]');
    await page.waitForSelector('#modalBackdrop.show');
    var len = await page.locator('#modalBody').evaluate(function (n) { return n.children.length; });
    if (!len) fail(screens[i] + ' modal rendered empty');
    await page.screenshot({ path: path.join(SHOTS, '1' + i + '-' + screens[i] + '.png') });
    await page.click('#modalClose');
    await page.waitForTimeout(120);
  }

  // Exercise the More tabs.
  await page.click('.nav-btn[data-nav="more"]');
  await page.waitForSelector('#modalBackdrop.show');
  var tabs = await page.locator('.tab').count();
  for (var t = 1; t < tabs; t++) {
    await page.locator('.tab').nth(t).click();
    await page.waitForTimeout(80);
    if (!(await page.locator('.tab-host').evaluate(function (n) { return n.children.length; }))) {
      fail('tab ' + t + ' rendered empty');
    }
  }
  await page.click('#modalClose');

  // Run the clock hard and make sure nothing throws.
  await page.evaluate(function () { SWW.UI.setSpeed('16x'); });
  await page.waitForTimeout(6000);
  var after = await page.evaluate(function () {
    var s = SWW.game.current;
    return {
      day: Math.floor(s.time / 24) + 1,
      time: s.time,
      armies: s.armies.length,
      log: s.log.length,
      over: s.gameOver
    };
  });
  console.log('ran to day ' + after.day + ' (t=' + after.time.toFixed(1) + 'h), ' +
    after.armies + ' stacks, ' + after.log + ' log entries');
  if (after.time < 8) fail('clock did not advance (t=' + after.time + ')');
  await page.screenshot({ path: path.join(SHOTS, '05-later.png') });

  // Save / load through the UI code path.
  var roundTrip = await page.evaluate(function () {
    var s = SWW.game.current;
    var saved = SWW.save.save(s);
    if (!saved.ok) return { ok: false, why: saved.why };
    var loaded = SWW.save.load();
    if (!loaded.ok) return { ok: false, why: loaded.why };
    SWW.game.replaceState(loaded.state);
    return { ok: true, day: Math.floor(SWW.game.current.time / 24) + 1 };
  });
  if (!roundTrip.ok) fail('save/load failed: ' + roundTrip.why);
  else console.log('save/load round trip ok (day ' + roundTrip.day + ')');
  await page.waitForTimeout(600);

  // Desktop layout pass.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(400);
  await page.evaluate(function () { SWW.UI.renderer.resize(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '06-desktop.png') });

  // No horizontal overflow anywhere.
  var overflow = await page.evaluate(function () {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  if (overflow > 1) fail('page overflows horizontally by ' + overflow + 'px');

  await browser.close();

  if (errors.length) {
    errors.slice(0, 12).forEach(function (e) { fail(e); });
  }
  if (!process.exitCode) console.log('\nBrowser checks passed. Screenshots in tools/shots/');
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
