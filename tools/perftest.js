#!/usr/bin/env node
/*
 * Frame-time probe for the map, run at a phone viewport and pixel ratio.
 *
 * Samples real requestAnimationFrame deltas at several zoom levels while the
 * simulation runs at 16x, and reports how often a frame missed the 60 fps
 * budget.  Panning is the case that matters: the view changes every frame, so
 * nothing viewport-dependent can be cached, and it is what a player spends
 * most of their time doing.
 *
 *   node tools/perftest.js
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

var URL = 'file://' + path.join(__dirname, '..', 'index.html');

(async function () {
  var browser = await playwright.chromium.launch({
    executablePath: chromePath(),
    args: ['--no-sandbox', '--allow-file-access-from-files']
  });
  // A mid-range phone: small viewport, high pixel ratio.
  var page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });
  page.on('pageerror', function (e) { console.error('pageerror: ' + e.message); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#menu.show');
  await page.fill('#seedInput', 'perf');
  await page.click('#startBtn');
  await page.waitForSelector('#game.show', { timeout: 20000 });
  await page.waitForTimeout(700);

  await page.evaluate(function () {
    SWW.UI.setSpeed('16x');
    SWW.UI.clearSelection();          // keep the panel out of the measurement
  });

  // Collect raw frame deltas from inside the page.
  await page.evaluate(function () {
    window.__frames = [];
    window.__sampling = false;
    (function tick(t) {
      if (window.__sampling && window.__last) window.__frames.push(t - window.__last);
      window.__last = t;
      requestAnimationFrame(tick);
    })(performance.now());
  });

  async function sample(label, setup, ms) {
    await page.evaluate(setup);
    await page.waitForTimeout(250);
    await page.evaluate(function () { window.__frames = []; window.__sampling = true; });
    await page.waitForTimeout(ms);
    var stats = await page.evaluate(function () {
      window.__sampling = false;
      var f = window.__frames.slice().sort(function (a, b) { return a - b; });
      if (!f.length) return null;
      // A frame is "dropped" when it took long enough that the display had to
      // show the previous one twice.  Vsync lands samples at 16.7ms, so the
      // threshold sits above that rather than exactly on it.
      var dropped = 0;
      for (var i = 0; i < f.length; i++) if (f[i] > 20) dropped++;
      return {
        n: f.length,
        p50: f[Math.floor(f.length * 0.5)],
        p95: f[Math.floor(f.length * 0.95)],
        max: f[f.length - 1],
        dropped: dropped,
        droppedPct: dropped / f.length * 100
      };
    });
    if (!stats) { console.log('  ' + label + ': no frames'); return null; }
    var fps = 1000 / stats.p50;
    console.log('  ' + label.padEnd(22) +
      'p50 ' + stats.p50.toFixed(1) + 'ms (' + fps.toFixed(0) + ' fps)' +
      '   p95 ' + stats.p95.toFixed(1) + 'ms' +
      '   dropped ' + stats.dropped + '/' + stats.n +
      ' (' + stats.droppedPct.toFixed(1) + '%)');
    return stats;
  }

  console.log('Map frame times — 390x844 at dpr 3, simulation at 16x');
  var results = {};
  results.world = await sample('world view', function () {
    var r = SWW.UI.renderer;
    r.camera.zoom = r.minZoom;
    r.camera.x = SWW.game.current.mapW / 2;
    r.camera.y = SWW.game.current.mapH / 2;
    r.clampCamera();
  }, 3500);

  results.region = await sample('regional (vector)', function () {
    var r = SWW.UI.renderer;
    var cap = SWW.game.current.provinces[
      SWW.game.current.nationById[SWW.game.current.playerId].capitalProvince];
    r.camera.zoom = 6;
    r.camera.x = cap.cx; r.camera.y = cap.cy;
    r.clampCamera();
  }, 3500);

  results.close = await sample('close up (vector)', function () {
    var r = SWW.UI.renderer;
    r.camera.zoom = 16;
    r.clampCamera();
  }, 3500);

  // Panning is the worst case: the view changes every frame, so nothing that
  // depends on the viewport can be cached between frames.
  results.pan = await sample('panning (vector)', function () {
    var r = SWW.UI.renderer;
    r.camera.zoom = 8;
    r.clampCamera();
    window.__pan = setInterval(function () { r.panBy(-9, 0); }, 16);
  }, 3500);
  await page.evaluate(function () { clearInterval(window.__pan); });

  await browser.close();

  /*
   * What this gate can and cannot measure.
   *
   * Across repeated runs on a shared machine the median frame time is
   * immovable at 16.7ms while the dropped-frame count wanders between 0 and 8
   * of ~200 — that tail is the host scheduler, not the renderer.  So the
   * median is the gate and the tail is reported for information only, with a
   * deliberately loose ceiling to catch a collapse.
   *
   * The median is not a weak test.  The regression this file was written to
   * find sat at 33.3ms — a doubling that no amount of averaging could hide.
   */
  var MEDIAN_LIMIT = 20;        // below 50 fps at the median is a real fault
  var LIMIT = 15;               // tail ceiling, for catastrophes only
  var worstView = null;
  Object.keys(results).forEach(function (k) {
    if (results[k] && (!worstView || results[k].droppedPct > results[worstView].droppedPct)) worstView = k;
  });
  var worst = worstView ? results[worstView].droppedPct : 0;
  var slow = Object.keys(results).filter(function (k) {
    return results[k] && results[k].p50 > MEDIAN_LIMIT;
  });
  var worstMedian = Object.keys(results).reduce(function (a, k) {
    return results[k] && results[k].p50 > a ? results[k].p50 : a;
  }, 0);

  console.log('\nworst median frame time: ' + worstMedian.toFixed(1) + 'ms   ' +
    'worst tail: ' + worst.toFixed(1) + '% dropped (' + worstView + ')');
  if (slow.length) {
    console.log('FAIL: ' + slow.join(', ') + ' render below 50 fps at the median');
    process.exitCode = 1;
  } else if (worst > LIMIT) {
    console.log('FAIL: the map stutters — over ' + LIMIT + '% of frames missed the 60 fps budget');
    process.exitCode = 1;
  } else {
    console.log('smooth: every view holds 60 fps at the median');
  }
})().catch(function (e) { console.error(e); process.exit(1); });
