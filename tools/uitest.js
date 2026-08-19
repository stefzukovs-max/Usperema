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

  /*
   * Campaign settings have to reach the simulation, not merely render.  The
   * defaults are changed through the actual controls and the resulting world is
   * checked against them below.
   */
  await page.click('#settingsBtn');
  if (!(await page.locator('#settingsPanel.show').count())) fail('settings panel did not open');
  await page.click('.setting:has-text("Victory threshold") .setting-opt:has-text("Half")');
  await page.click('.setting:has-text("Length of the war") .setting-opt:has-text("Short")');
  await page.click('.setting:has-text("Fog of war") .setting-opt:has-text("Off")');
  var chosenCount = await page.locator('.setting-opt.on').count();
  if (chosenCount !== 5) fail('expected one choice per setting, got ' + chosenCount);

  // Deterministic seed and a fixed nation so runs are comparable.
  await page.fill('#seedInput', 'ui-test');
  await page.click('.nation-card:has-text("Türkiye")');
  await page.click('#startBtn');
  await page.waitForSelector('#game.show', { timeout: 20000 });
  await page.waitForTimeout(900);

  var info = await page.evaluate(function () {
    var s = IA.game.current;
    return {
      player: s.playerId,
      provinces: s.nationById[s.playerId].provinces.length,
      armies: s.armies.length,
      seed: s.seed
    };
  });
  if (info.player !== 'TUR') fail('nation selection ignored, got ' + info.player);
  if (info.provinces < 1) fail('player owns no provinces');

  var applied = await page.evaluate(function () {
    var s = IA.game.current;
    IA.UI.recomputeVisibility(true);
    var unseen = 0;
    for (var i = 0; i < s.provinces.length; i++) if (!IA.UI.visible[i]) unseen++;
    return {
      share: s.settings.victoryShare,
      ratio: s.victoryVP / s.totalVP,
      armistice: IA.victory.armisticeDay(s),
      fog: s.settings.fogOfWar,
      unseen: unseen
    };
  });
  if (applied.share !== 0.5) fail('victory threshold setting was not carried into the game');
  if (Math.abs(applied.ratio - 0.5) > 0.01) {
    fail('victory points do not match the chosen threshold (' + applied.ratio.toFixed(3) + ')');
  }
  if (applied.armistice > 400) fail('short war setting ignored, armistice on day ' + applied.armistice);
  if (applied.fog !== false) fail('fog-of-war setting was not carried into the game');
  if (applied.unseen !== 0) fail('fog is off but ' + applied.unseen + ' provinces are hidden');
  console.log('campaign settings reached the simulation (victory at ' +
    Math.round(applied.ratio * 100) + '%, armistice day ' + applied.armistice + ', fog off)');

  /*
   * Sound.
   *
   * Headless Chromium has a real WebAudio implementation with no speakers, so
   * the whole chain can be exercised: the context starts, every sound in the
   * palette builds its nodes without throwing, the throttle suppresses a
   * repeat, and the volume control reaches the master gain. What cannot be
   * checked here is whether it sounds like anything.
   */
  var audio = await page.evaluate(async function () {
    IA.audio.resume();
    await new Promise(function (r) { setTimeout(r, 120); });
    if (!IA.audio.isReady()) return { ready: false };
    IA.audio.setVolume(0.6);
    var names = IA.audio.names();
    var threw = [];
    names.forEach(function (n) {
      try { IA.audio.play(n); } catch (e) { threw.push(n + ': ' + e.message); }
    });
    // The same sound twice in a row must be swallowed by the throttle.
    var before = IA.game.current.sfx ? IA.game.current.sfx.length : 0;
    IA.audio.play('battle');
    var doubled = false;
    try { IA.audio.play('battle'); doubled = true; } catch (e) { /* still fine */ }

    IA.audio.setVolume(0);
    var silent = IA.audio.getVolume();
    IA.audio.setVolume(0.6);

    // And the simulation's own cue queue must be drained by the interface.
    IA.state.cue(IA.game.current, 'order');
    var queued = IA.game.current.sfx.length;
    IA.UI.drainSounds();
    return {
      ready: true, count: names.length, threw: threw, doubled: doubled,
      silent: silent, queued: queued, drained: IA.game.current.sfx.length, before: before
    };
  });
  if (!audio.ready) {
    console.log('audio: no WebAudio in this browser, skipped');
  } else {
    if (audio.threw.length) fail('sounds failed to build: ' + audio.threw.join('; '));
    if (audio.count < 8) fail('expected a full palette of sounds, got ' + audio.count);
    if (audio.silent !== 0) fail('volume could not be turned off');
    if (audio.queued < 1) fail('a cue from the simulation was not queued');
    if (audio.drained !== 0) fail('the sound queue was not drained by the interface');
    console.log('audio: ' + audio.count + ' synthesised sounds play, ' +
      'the cue queue drains, and volume reaches the master gain');
  }

  /*
   * The tutorial.
   *
   * The claim being tested is that it watches the real game rather than a
   * script: each step is satisfied by doing the thing through the ordinary
   * game code, and the lesson must move on by itself. Nothing here tells the
   * tutorial it has advanced.
   */
  var tut = await page.evaluate(async function () {
    var ui = IA.UI, s = IA.game.current;
    var me = s.nationById[s.playerId];
    function step() { return IA.tutorial.steps()[IA.tutorial.stepIndex()].id; }
    function settle() { return new Promise(function (r) { setTimeout(r, 60); }); }

    IA.tutorial.start(ui);
    var seen = [step()];
    if (!document.querySelector('#tutorial.show')) return { error: 'the card did not appear' };

    // 1. Select the capital, the ordinary way.
    ui.selectProvince(me.capitalProvince);
    await settle();
    seen.push(step());

    // 2. Queue a building through the real order path.
    var home = s.provinces[me.capitalProvince];
    me.resources.money += 200000;
    me.resources.timber += 20000;
    me.resources.iron += 20000;
    IA.orders.startConstruction(s, home, 'barracks');
    await settle();
    seen.push(step());

    // 3. Start a technology.
    IA.orders.startResearch(s, me, 'conscription');
    await settle();
    seen.push(step());

    // 4. Give a stack somewhere to go.
    var mine = s.armies.filter(function (a) { return a.ownerId === s.playerId; })[0];
    var prov = s.provinces[mine.provinceId];
    for (var i = 0; i < prov.neighbors.length; i++) {
      var cand = s.provinces[prov.neighbors[i]];
      if (!cand.isSea && cand.nationId === s.playerId) {
        IA.orders.issueMove(s, mine, cand.id);
        break;
      }
    }
    await settle();
    seen.push(step());

    // 5. Start a depot, which is what the supply step asks for.
    var second = null;
    for (var q = 0; q < me.provinces.length; q++) {
      if (me.provinces[q] !== me.capitalProvince) { second = s.provinces[me.provinces[q]]; break; }
    }
    IA.orders.startConstruction(s, second || home, 'warehouse');
    await settle();
    seen.push(step());

    // 6. Open the war aims.
    ui.buildWarAims();
    await settle();
    var ended = !IA.tutorial.isActive();
    seen.push(ended ? 'finished' : step());
    var out = { seen: seen, ended: ended, done: IA.tutorial.finished() };

    // Put the world back: the checks further down start their own construction
    // and research, and would otherwise be rejected as already in progress.
    me.researching = null;
    home.construction = null;
    home.queue = [];
    if (second) { second.construction = null; second.queue = []; }
    return out;
  });
  if (tut.error) fail('tutorial: ' + tut.error);
  else {
    var expected = ['select', 'build', 'research', 'move', 'supply', 'aims', 'finished'];
    var moved = tut.seen.join(' -> ');
    for (var ti = 0; ti < expected.length; ti++) {
      if (tut.seen[ti] !== expected[ti]) {
        fail('tutorial did not follow the real game state: ' + moved);
        break;
      }
    }
    if (!tut.ended) fail('tutorial did not finish after the last step');
    if (!tut.done) fail('a finished tutorial was not remembered');
    if (tut.seen[0] === 'select' && tut.ended) {
      console.log('tutorial advances on real game state (' + moved + ')');
    }
  }

  /*
   * The unit icon set.
   *
   * Emoji were what shipped, and they render differently on every platform.
   * These are drawn, so the check is that every unit resolves to a drawing,
   * that no two categories collapse onto the same one, and that each actually
   * puts ink on the canvas — a silhouette that draws nothing is worse than an
   * emoji, because it fails silently.
   */
  var icons = await page.evaluate(function () {
    var shapes = {}, blank = [], missing = [];
    IA.UnitData.UNITS.forEach(function (type) {
      var name = IA.icons.nameFor(type.id);
      if (!IA.icons.DRAW[name]) { missing.push(type.id); return; }
      shapes[name] = (shapes[name] || 0) + 1;
      // Rasterise and count how many pixels the drawing actually marked.
      var c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      IA.icons.paint(c.getContext('2d'), name, 0, 0, 32, '#ffffff');
      var d = c.getContext('2d').getImageData(0, 0, 32, 32).data;
      var lit = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] > 40) lit++;
      if (lit < 24) blank.push(type.id + ' (' + name + ', ' + lit + 'px)');
    });
    return {
      units: IA.UnitData.UNITS.length,
      shapes: Object.keys(shapes).length,
      blank: blank, missing: missing,
      total: IA.icons.names().length
    };
  });
  if (icons.missing.length) fail('units with no icon: ' + icons.missing.join(', '));
  if (icons.blank.length) fail('icons that draw nothing: ' + icons.blank.join(', '));
  if (icons.shapes < 8) fail('only ' + icons.shapes + ' distinct unit silhouettes in use');
  console.log('icons: ' + icons.units + ' units over ' + icons.shapes +
    ' distinct drawn silhouettes, none blank');

  // Put fog back on for the rest of the run, so everything below is tested on
  // the path a default campaign actually takes.
  await page.evaluate(function () {
    IA.game.current.settings.fogOfWar = true;
    IA.UI.recomputeVisibility(true);
  });
  console.log('started as ' + info.player + ' with ' + info.provinces + ' provinces, ' +
    info.armies + ' stacks on the map');
  await page.screenshot({ path: path.join(SHOTS, '02-map.png') });

  // Panel should be open on the capital.
  if (!(await page.locator('#panel.open').count())) fail('capital panel did not open');

  // Zoom out to see the whole world.
  await page.evaluate(function () {
    var r = IA.UI.renderer;
    r.camera.zoom = r.minZoom;
    r.camera.x = IA.game.current.mapW / 2;
    r.camera.y = IA.game.current.mapH / 2;
    r.clampCamera();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '03-world.png') });

  // Issue a real move order through the UI, into own territory.
  var moved = await page.evaluate(function () {
    var s = IA.game.current;
    var mine = s.armies.filter(function (a) { return a.ownerId === s.playerId; });
    if (!mine.length) return { ok: false, why: 'no armies' };
    var army = null, target = null;
    for (var i = 0; i < mine.length && !target; i++) {
      var prov = s.provinces[mine[i].provinceId];
      for (var j = 0; j < prov.neighbors.length; j++) {
        var cand = s.provinces[prov.neighbors[j]];
        if (cand.isSea || cand.nationId !== s.playerId) continue;
        army = mine[i]; target = cand; break;
      }
    }
    if (!target) return { ok: false, why: 'no friendly neighbour to march to' };
    IA.UI.selectArmy(army.id);
    IA.UI.setTargeting('move');
    IA.UI.resolveTargeting(target);
    return { ok: army.path.length > 0, target: target.name, path: army.path.length };
  });
  if (!moved.ok) fail('move order failed: ' + (moved.why || 'no path set'));
  else console.log('move order accepted -> ' + moved.target + ' (' + moved.path + ' legs)');

  // Marching into a country you are at peace with must be refused.
  var blocked = await page.evaluate(function () {
    var s = IA.game.current;
    var mine = s.armies.filter(function (a) { return a.ownerId === s.playerId; })[0];
    var prov = s.provinces[mine.provinceId];
    for (var j = 0; j < prov.neighbors.length; j++) {
      var cand = s.provinces[prov.neighbors[j]];
      if (cand.isSea || !cand.nationId || cand.nationId === s.playerId) continue;
      if (IA.state.treaty(s, s.playerId, cand.nationId) !== 'peace') continue;
      return { tested: true, ok: !IA.orders.issueMove(s, mine, cand.id).ok, name: cand.name };
    }
    return { tested: false };
  });
  if (blocked.tested && !blocked.ok) fail('army was allowed to march into a nation at peace');
  else if (blocked.tested) console.log('border with ' + blocked.name + ' correctly closed while at peace');
  await page.screenshot({ path: path.join(SHOTS, '04-army.png') });

  // Detail stands down while the map moves and comes back once it settles.
  var detail = await page.evaluate(async function () {
    var r = IA.UI.renderer;
    r.camera.zoom = 8;
    r.panBy(-40, 0);
    var moving = r.detailAlpha();
    await new Promise(function (res) { setTimeout(res, 500); });
    return { moving: moving, settled: r.detailAlpha() };
  });
  if (detail.moving !== 0) fail('terrain detail was not dropped while panning (' + detail.moving + ')');
  if (detail.settled < 0.99) fail('terrain detail did not come back after settling (' + detail.settled + ')');
  else console.log('detail defers while moving and returns when the map settles');

  // A flick should coast rather than stop dead.
  var glide = await page.evaluate(async function () {
    var canvas = document.getElementById('map');
    var rect = canvas.getBoundingClientRect();
    var y = rect.top + rect.height / 2;
    var startX = rect.left + rect.width * 0.75;
    function send(type, x, t) {
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, clientX: x, clientY: y, bubbles: true, pointerType: 'touch'
      }));
    }
    send('pointerdown', startX);
    for (var i = 1; i <= 6; i++) {
      send('pointermove', startX - i * 18);
      await new Promise(function (r) { setTimeout(r, 16); });
    }
    send('pointerup', startX - 6 * 18);
    var before = IA.UI.renderer.camera.x;
    var gliding = !!IA.UI.glide;
    await new Promise(function (r) { setTimeout(r, 350); });
    return { gliding: gliding, travelled: Math.abs(IA.UI.renderer.camera.x - before) };
  });
  if (!glide.gliding) fail('a flick did not start a glide');
  else if (glide.travelled < 0.5) fail('the glide did not move the camera (' + glide.travelled + ')');
  else console.log('flick coasts on after release (' + glide.travelled.toFixed(1) + ' map units)');

  /*
   * The map layer is scrolled between frames and only the strip that has come
   * into view is repainted, so a mistake in that arithmetic leaves a seam, a
   * band of stale ground or a map offset from the armies on top of it — none of
   * which any other check would notice.  Drag a long way a few pixels at a
   * time, then paint the same view again from scratch and compare.
   *
   * The bar is "no visible difference", not "identical".  Rasterising a stroke
   * against a clip gives very slightly different antialiasing from rasterising
   * it whole, so border lines settle a few levels away from where a single
   * repaint would put them.  Measured over a long drag that reaches about 50
   * levels on a handful of pixels and under 5 on the rest, against a wrong
   * offset or a stale strip, which would put thousands of pixels far out.
   */
  var scroll = await page.evaluate(function () {
    var r = IA.UI.renderer;
    // Hold the clock still: a province changing hands mid-drag would repaint
    // the layer and leave the two pictures legitimately different.
    IA.UI.setSpeed('pause');
    r.camera.zoom = 7;
    r.clampCamera();
    r.updateLayer();
    for (var i = 0; i < 120; i++) {
      r.panBy(-7, 3);
      r.updateLayer();
    }
    var W = r.layer.width, H = r.layer.height;
    var fresh = document.createElement('canvas');
    fresh.width = W; fresh.height = H;
    r.paintLayer(fresh, r.anchor, null);
    var a = r.layer.getContext('2d').getImageData(0, 0, W, H).data;
    var b = fresh.getContext('2d').getImageData(0, 0, W, H).data;
    var off = 0, worst = 0;
    for (var p = 0; p < a.length; p += 4) {
      var d = Math.max(Math.abs(a[p] - b[p]),
        Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
      if (d > worst) worst = d;
      if (d > 96) off++;                 // a difference nobody could miss
    }
    IA.UI.setSpeed('1x');
    return { off: off, pixels: a.length / 4, worst: worst };
  });
  var offPct = scroll.off / scroll.pixels * 100;
  if (offPct > 0.05) {
    fail('scrolled map layer does not match a fresh repaint — ' + scroll.off + ' of ' +
      scroll.pixels + ' pixels are plainly wrong (' + offPct.toFixed(3) + '%)');
  } else {
    console.log('scrolled map layer matches a fresh repaint after 120 drags' +
      ' (worst channel off by ' + scroll.worst + '/255)');
  }

  // Build something and research something through the real code paths.
  var actions = await page.evaluate(function () {
    var s = IA.game.current;
    var nation = s.nationById[s.playerId];
    var cap = s.provinces[nation.capitalProvince];
    var build = IA.orders.startConstruction(s, cap, 'barracks');
    var tech = IA.orders.startResearch(s, nation, 'conscription');
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

  // The styled confirmation must appear, and must actually do the thing.
  await page.click('.nav-btn[data-nav="diplomacy"]');
  await page.waitForSelector('#modalBackdrop.show');
  /*
   * Some of the listed powers may already be at war, and those rows offer peace
   * rather than a declaration.  Find the first row that actually has a
   * declare-war button and read the name from that same row.
   */
  var warTarget = await page.evaluate(function () {
    var rows = document.querySelectorAll('.nation-row');
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].querySelector('.danger-btn')) continue;
      rows[i].setAttribute('data-war-target', '1');
      return rows[i].querySelector('.nation-name span').textContent;
    }
    return null;
  });
  if (!warTarget) fail('diplomacy listed nobody left to declare war on');
  else {
    await page.locator('.nation-row[data-war-target] .danger-btn').first().click();
    await page.waitForSelector('.confirm-box', { timeout: 3000 });
    await page.waitForTimeout(400);            // let the entrance animation finish
    await page.screenshot({ path: path.join(SHOTS, '07-confirm.png') });
    var dialogText = await page.locator('.confirm-body').textContent();
    if (dialogText.indexOf(warTarget) < 0) fail('confirm dialog did not name the target');
    await page.click('.confirm-ok');
    await page.waitForTimeout(200);
    var atWar = await page.evaluate(function (name) {
      var s = IA.game.current;
      var target = s.nations.filter(function (n) { return n.name === name; })[0];
      return target ? IA.state.treaty(s, s.playerId, target.id) : 'missing';
    }, warTarget);
    if (atWar !== 'war') fail('confirming the dialog did not declare war (got ' + atWar + ')');
    else console.log('declared war on ' + warTarget + ' through the confirm dialog');
    if (await page.locator('.confirm-box').count()) fail('confirm dialog stayed open');
  }
  await page.click('#modalClose');
  await page.waitForTimeout(120);

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
  /*
   * The naval war reports on water nobody is looking at, so the tab has to say
   * something true about it.  Shut the player's coast for real and check the
   * screen notices.
   */
  await page.locator('.tab', { hasText: 'Sea' }).first().click();
  await page.waitForTimeout(120);
  var seaBefore = await page.locator('.tab-host').textContent();
  var seaShut = await page.evaluate(function () {
    var s = IA.game.current, me = s.nationById[s.playerId];
    var foe = s.nations.filter(function (n) {
      return n.alive && IA.state.isHostile(s, me.id, n.id);
    })[0];
    var water = {};
    me.provinces.forEach(function (id) {
      var p = s.provinces[id];
      if (!p.seaport) return;
      p.neighbors.forEach(function (k) {
        var np = s.provinces[k];
        if (np.isSea && !np.isLake) water[k] = true;
      });
    });
    var keys = Object.keys(water);
    if (!foe || !keys.length) return { ports: 0 };
    keys.forEach(function (k) {
      IA.state.spawnArmy(s, foe.id, +k, [{ typeId: 'dreadnought', count: 4 }]);
    });
    IA.economy.refreshSupply(s);
    IA.UI.refreshModal();
    return { ports: keys.length, shut: Math.round(IA.naval.blockadeOf(s, me) * 100), foe: foe.name };
  });
  if (!seaShut.ports) {
    console.log('sea war: the player is landlocked this run, blockade not exercised');
  } else {
    await page.locator('.tab', { hasText: 'Sea' }).first().click();
    await page.waitForTimeout(120);
    var seaAfter = await page.locator('.tab-host').textContent();
    await page.screenshot({ path: path.join(SHOTS, '15-sea.png') });
    if (seaAfter.indexOf('Ports shut') < 0) fail('the sea screen does not report the ports');
    if (seaShut.shut < 90) fail('a fleet on every approach only shut ' + seaShut.shut + '% of the coast');
    if (seaAfter === seaBefore) fail('the sea screen did not notice the blockade');
    if (seaAfter.indexOf('coast is closed') < 0) fail('a closed coast is not called one');
    console.log('sea war: ' + seaShut.ports + ' approaches held by ' + seaShut.foe +
      ' shut ' + seaShut.shut + '% of the coast, and the screen says so');
  }
  await page.evaluate(function () {
    // Put the sea back before the clock runs on.
    var s = IA.game.current;
    for (var i = s.armies.length - 1; i >= 0; i--) {
      var a = s.armies[i];
      if (s.provinces[a.provinceId].isSea && IA.naval.warshipPower(a) > 0 &&
        a.units.length === 1 && a.units[0].typeId === 'dreadnought') {
        IA.state.removeArmy(s, a);
      }
    }
    IA.economy.refreshSupply(s);
  });
  await page.click('#modalClose');

  // Run the clock hard and make sure nothing throws.
  await page.evaluate(function () { IA.UI.setSpeed('16x'); });
  await page.waitForTimeout(6000);
  var after = await page.evaluate(function () {
    var s = IA.game.current;
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
    var s = IA.game.current;
    var saved = IA.save.save(s);
    if (!saved.ok) return { ok: false, why: saved.why };
    var loaded = IA.save.load();
    if (!loaded.ok) return { ok: false, why: loaded.why };
    IA.game.replaceState(loaded.state);
    return { ok: true, day: Math.floor(IA.game.current.time / 24) + 1 };
  });
  if (!roundTrip.ok) fail('save/load failed: ' + roundTrip.why);
  else console.log('save/load round trip ok (day ' + roundTrip.day + ')');
  await page.waitForTimeout(600);

  /*
   * Desktop layout pass.  No explicit resize() here on purpose — on a wide
   * screen the detail panel takes a column out of the map rather than a slice
   * off the bottom, and the canvas has to notice that by itself or the world
   * comes out stretched.
   */
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, '06-desktop.png') });

  var wide = await page.evaluate(function () {
    function box(id) { return document.getElementById(id).getBoundingClientRect(); }
    var out = { open: { map: box('map'), panel: box('panel') }, nav: box('bottomNav') };
    out.canvas = { css: box('map').width, backing: document.getElementById('map').width };
    out.dpr = Math.min(window.devicePixelRatio || 1, 2);
    IA.UI.clearSelection();
    return new Promise(function (done) {
      setTimeout(function () { out.shut = { map: box('map') }; done(out); }, 400);
    });
  });
  if (wide.open.panel.left < wide.open.map.right - 1) {
    fail('the detail panel overlaps the map instead of docking beside it');
  } else if (wide.open.panel.height < 600) {
    fail('the docked panel is only ' + Math.round(wide.open.panel.height) + 'px tall');
  } else if (wide.nav.height < wide.nav.width) {
    fail('the navigation is still a bottom bar on a wide screen');
  } else if (wide.shut.map.width <= wide.open.map.width + 100) {
    fail('closing the panel does not give the map its column back');
  } else if (Math.abs(wide.canvas.backing - wide.canvas.css * wide.dpr) > 2) {
    fail('the map canvas did not follow its box (' + Math.round(wide.canvas.css * wide.dpr) +
      ' wanted, ' + wide.canvas.backing + ' drawn)');
  } else {
    console.log('desktop: map ' + Math.round(wide.open.map.width) + 'px beside a ' +
      Math.round(wide.open.panel.width) + 'px column, ' + Math.round(wide.shut.map.width) +
      'px with the panel shut, nav rail ' + Math.round(wide.nav.width) + 'px wide');
  }
  await page.evaluate(function () { IA.UI.selectProvince(IA.game.current.nationById[IA.game.current.playerId].capitalProvince); });
  await page.waitForTimeout(300);

  // No horizontal overflow anywhere.
  var overflow = await page.evaluate(function () {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  if (overflow > 1) fail('page overflows horizontally by ' + overflow + 'px');

  /*
   * Map modes.
   *
   * The claim is that each asks the map a different question, so the test is
   * that each actually repaints the ground differently — a mode that returns
   * the political fill under another name is a button that does nothing.
   */
  var modes = await page.evaluate(function () {
    var r = IA.UI.renderer;
    var state = IA.game.current;
    /*
     * Run the war on a little first.  On day one every province is at full
     * morale and nothing is cut off, so supply and morale are legitimately one
     * colour each and the check would be asking at the only moment it cannot
     * be answered.  This is the last thing the test does for that reason: it
     * moves the world on, which would pull the ground from under everything
     * above it.
     */
    for (var h = 0; h < 24 * 12; h++) IA.loop.advance(state, 1);
    /*
     * The sample has to contain the player's own ground.  Taking every third
     * province by index does not: indices are geographic, and supply and
     * diplomacy both answer "yours or theirs" first, so a sample that happens
     * to miss the player reports one colour and the mode looks broken.
     */
    var me = state.nationById[state.playerId];
    var sample = [];
    for (var m = 0; m < me.provinces.length; m++) sample.push(state.provinces[me.provinces[m]]);
    for (var i = 0; i < state.landCount && sample.length < 220; i += 3) {
      if (state.provinces[i].nationId) sample.push(state.provinces[i]);
    }
    if (!me.provinces.length) return { error: 'the player held nothing by the end' };
    var seen = {}, out = [];
    IA.Renderer.MODE_ORDER.forEach(function (id) {
      r.setMode(id);
      var sig = sample.map(function (p) { return r.fillFor(p); }).join(',');
      out.push({ id: id, distinct: !seen[sig], colours: (function () {
        var u = {};
        sample.forEach(function (p) { u[r.fillFor(p)] = 1; });
        return Object.keys(u).length;
      })() });
      seen[sig] = id;
    });
    r.setMode('political');
    IA.UI.buildMapModes();
    return { modes: out, legend: !!document.querySelector('#mapModes .mode-btn') };
  });
  if (modes.error) fail('map modes: ' + modes.error);
  else if (!modes.legend) fail('the map-mode switcher did not render');
  (modes.modes || []).forEach(function (m) {
    if (!m.distinct) fail('map mode "' + m.id + '" paints the same as another mode');
    if (m.colours < 2) fail('map mode "' + m.id + '" paints everything one colour');
  });
  if (modes.modes) {
    console.log('map modes: ' + modes.modes.map(function (m) {
      return m.id + '(' + m.colours + ')';
    }).join(' '));
  }


  await browser.close();

  if (errors.length) {
    errors.slice(0, 12).forEach(function (e) { fail(e); });
  }
  if (!process.exitCode) console.log('\nBrowser checks passed. Screenshots in tools/shots/');
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
