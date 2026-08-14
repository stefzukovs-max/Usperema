#!/usr/bin/env node
/*
 * Renders the map on its own, with no interface over it, for the README.
 *
 *   node tools/hero.js               # whole world -> shots/world-map.png
 *   node tools/hero.js europe        # the powers  -> shots/europe-1914.png
 *   node tools/hero.js europe 180    # ...on day 180, to see the winter
 */
'use strict';

var path = require('path');
var fs = require('fs');
var cp = require('child_process');

function loadPlaywright() {
  var candidates = [process.env.PW_ROOT, 'playwright'];
  try {
    candidates.push(path.join(cp.execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
  } catch (e) { /* npm not on PATH */ }
  for (var i = 0; i < candidates.length; i++) {
    if (!candidates[i]) continue;
    try { return require(candidates[i]); } catch (e) { /* next */ }
  }
  return null;
}

var playwright = loadPlaywright();
if (!playwright) {
  console.log('SKIPPED: playwright is not installed.');
  process.exit(0);
}

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

var view = process.argv[2] === 'europe' ? 'europe' : 'world';
var atDay = Number(process.argv[3] || 0);
var URL = 'file://' + path.join(__dirname, '..', 'index.html');
var OUT = path.join(__dirname, 'shots',
  view === 'europe' ? 'europe-1914.png' : 'world-map.png');

(async function () {
  var browser = await playwright.chromium.launch({
    executablePath: chromePath(),
    args: ['--no-sandbox', '--allow-file-access-from-files']
  });
  var page = await browser.newPage({ viewport: { width: 1600, height: 820 }, deviceScaleFactor: 2 });
  page.on('pageerror', function (e) { console.error('pageerror: ' + e.message); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#menu.show');
  await page.fill('#seedInput', 'hero');
  await page.click('#startBtn');
  await page.waitForSelector('#game.show', { timeout: 20000 });
  await page.waitForTimeout(600);

  // Clear the interface off the map and let it fill the window.
  await page.evaluate(function (opts) {
    var which = opts.which;
    IA.UI.setSpeed('pause');
    // These are pictures of the map, not of a campaign: fog would just show
    // which nation the seed happened to pick.
    IA.game.current.settings.fogOfWar = false;
    IA.UI.recomputeVisibility(true);
    if (opts.atDay > 0) {
      IA.game.current.time = opts.atDay * 24;
      IA.weather.refresh(IA.game.current);
    }
    IA.UI.clearSelection();
    ['topbar', 'panel', 'bottomNav', 'speedControls', 'toasts', 'tutorial'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    var wrap = document.getElementById('mapWrap');
    wrap.style.position = 'fixed';
    wrap.style.inset = '0';
    IA.UI.renderer.resize();

    var r = IA.UI.renderer;
    if (which === 'europe') {
      var cap = IA.game.current.provinces[
        IA.game.current.nationById.GER.capitalProvince];
      r.camera.zoom = 7;
      r.camera.x = cap.cx;
      r.camera.y = cap.cy;
    } else {
      r.camera.zoom = r.minZoom;
      r.camera.x = IA.game.current.mapW / 2;
      r.camera.y = IA.game.current.mapH / 2;
    }
    r.clampCamera();
    r.lastMotion = 0;                    // full terrain detail, no fade
  }, { which: view, atDay: atDay });

  await page.waitForTimeout(600);
  await page.locator('#map').screenshot({ path: OUT });
  await browser.close();
  console.log('wrote ' + path.relative(process.cwd(), OUT) + ' (' + view + ')');
})().catch(function (e) { console.error(e); process.exit(1); });
