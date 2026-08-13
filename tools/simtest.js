#!/usr/bin/env node
/*
 * Headless smoke test for the simulation.
 *
 * Loads the same browser source files the page loads, generates a world, runs
 * it for a number of game days with no player input, and asserts the
 * invariants that matter.  Run with:  node tools/simtest.js [days] [seed]
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var FILES = [
  'src/engine/rng.js',
  'src/engine/util.js',
  'src/data/worldmap.js',
  'src/data/units.js',
  'src/data/buildings.js',
  'src/data/research.js',
  'src/engine/mapdata.js',
  'src/engine/worldgen.js',
  'src/game/diplomacy.js',
  'src/game/market.js',
  'src/game/state.js',
  'src/game/economy.js',
  'src/game/combat.js',
  'src/game/orders.js',
  'src/game/ai.js',
  'src/game/loop.js',
  'src/game/save.js'
];

var memory = {};
var sandbox = {
  console: console,
  Math: Math,
  Date: Date,
  JSON: JSON,
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
    setItem: function (k, v) { memory[k] = String(v); },
    removeItem: function (k) { delete memory[k]; }
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

FILES.forEach(function (f) {
  var code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
});

var IA = sandbox.IA;

var failures = [];
function check(label, cond, detail) {
  if (cond) return;
  failures.push(label + (detail ? ' — ' + detail : ''));
}

var days = Number(process.argv[2] || 40);
var seed = process.argv[3] || 'smoke-1';
// A fixed mid-sized nation keeps runs comparable. The "player" never acts, so
// a tiny country would simply be overrun and cut the run short.
var playerNation = process.argv[4] || 'AUH';

console.log('Generating world (seed "' + seed + '")...');
var t0 = Date.now();
var state = IA.state.createGame({ seed: seed, playerNation: playerNation });
var genMs = Date.now() - t0;

var land = 0, sea = 0, owned = 0, neutral = 0, orphan = 0;
for (var i = 0; i < state.provinces.length; i++) {
  var p = state.provinces[i];
  if (p.size === 0) { orphan++; continue; }
  if (p.isSea) { sea++; continue; }
  land++;
  if (p.nationId) owned++; else neutral++;
  check('province ' + p.id + ' has neighbours', p.neighbors.length > 0, p.name);
  check('province ' + p.id + ' has a name', !!p.name);
}

console.log('  world: ' + land + ' land provinces, ' + sea + ' sea zones, ' +
  owned + ' owned, ' + neutral + ' neutral (' + genMs + ' ms)');
console.log('  nations: ' + state.nations.length + ', player = ' + state.playerId);
console.log('  armies at start: ' + state.armies.length + ', total VP ' + state.totalVP +
  ', victory at ' + state.victoryVP);

// The map is real geography, so these must hold on every seed.
var KNOWN = { FRA: 'Paris', GER: 'Berlin', AUH: 'Vienna', OTT: 'Constantinople', RUS: 'Petrograd' };
Object.keys(KNOWN).forEach(function (iso) {
  var nat = state.nationById[iso];
  if (!nat) { check('nation ' + iso + ' exists', false); return; }
  var cap = state.provinces[nat.capitalProvince];
  check('nation ' + iso + ' holds its capital', cap && cap.nationId === iso,
    cap ? cap.name + ' owned by ' + cap.nationId : 'missing');
});
check('the map is 1914, not the present day',
  !!state.nationById.AUH && !!state.nationById.OTT && !state.nationById.TUR,
  'AUH=' + !!state.nationById.AUH + ' OTT=' + !!state.nationById.OTT + ' TUR=' + !!state.nationById.TUR);
check('the blocs are at war on day one',
  IA.state.treaty(state, 'GER', 'FRA') === 'war' && IA.state.treaty(state, 'GER', 'AUH') === 'alliance',
  'GER/FRA=' + IA.state.treaty(state, 'GER', 'FRA') + ' GER/AUH=' + IA.state.treaty(state, 'GER', 'AUH'));
check('neutrals start out of it', IA.state.treaty(state, 'SWE', 'GER') === 'peace');

check('every nation has a capital province', state.nations.every(function (n) {
  return state.provinces[n.capitalProvince] && state.provinces[n.capitalProvince].nationId === n.id;
}));
check('every nation owns territory', state.nations.every(function (n) { return n.provinces.length > 0; }));
check('land provinces exceed 150', land > 150, 'got ' + land);
check('sea zones exceed 30', sea > 30, 'got ' + sea);
check('neutral land exists', neutral > 0);

// The player takes no actions; this exercises the AI, economy and combat.
var hours = days * 24;
var t1 = Date.now();
var lastReport = 0;
for (var h = 0; h < hours; h++) {
  IA.loop.advance(state, 1);

  // Invariants checked every hour.
  for (var a = 0; a < state.armies.length; a++) {
    var army = state.armies[a];
    if (!army.units.length) { check('no empty stacks', false, army.id); break; }
    var prov = state.provinces[army.provinceId];
    if (!prov || prov.size === 0) { check('armies stand on real provinces', false, army.id); break; }
    var domain = IA.orders.armyDomain(army);
    if (domain === 'sea' && !prov.isSea) { check('naval stacks stay at sea', false, army.id + ' in ' + prov.name); break; }
    for (var u = 0; u < army.units.length; u++) {
      var g = army.units[u];
      var type = IA.UnitData.BY_ID[g.typeId];
      if (!(g.hp > 0)) { check('unit groups keep positive hp', false, army.id + '/' + g.typeId); break; }
      if (g.hp > type.hp * g.count + 0.01) {
        check('unit hp never exceeds maximum', false, army.id + '/' + g.typeId + ' ' + g.hp.toFixed(1) + '>' + (type.hp * g.count));
        break;
      }
    }
  }
  for (var n = 0; n < state.nations.length; n++) {
    var nat = state.nations[n];
    for (var k in nat.resources) {
      if (!(nat.resources[k] >= -0.001) || !isFinite(nat.resources[k])) {
        check('resources stay finite and non-negative', false, nat.id + '.' + k + ' = ' + nat.resources[k]);
        break;
      }
    }
    var counted = 0;
    for (var q = 0; q < nat.provinces.length; q++) {
      if (state.provinces[nat.provinces[q]].nationId === nat.id) counted++;
    }
    check('province lists match ownership', counted === nat.provinces.length,
      nat.id + ' lists ' + nat.provinces.length + ' but owns ' + counted);
  }
  if (failures.length) break;

  if (Math.floor(h / 24) > lastReport) {
    lastReport = Math.floor(h / 24);
    if (lastReport % 10 === 0) {
      var leader = state.nations.filter(function (x) { return x.alive; })
        .sort(function (x, y) { return y.vp - x.vp; })[0];
      var wars = 0;
      for (var w = 0; w < state.nations.length; w++) wars += (state.nations[w].warCount || 0);
      var battalions = 0, starving = 0;
      for (var b = 0; b < state.armies.length; b++) battalions += IA.state.unitCount(state.armies[b]);
      for (var sn = 0; sn < state.nations.length; sn++) if (state.nations[sn].shortage) starving++;
      console.log('  day ' + (lastReport + 1) + ': ' + state.armies.length + ' stacks / ' +
        battalions + ' battalions, ' + (wars / 2) + ' wars, ' + starving + ' nations short of supply, leader ' +
        leader.name + ' (' + leader.vp + ' VP), ' +
        state.nations.filter(function (x) { return x.alive; }).length + ' alive');
    }
  }
  if (state.gameOver) { console.log('  game over on day ' + Math.ceil(state.time / 24) + ': ' + JSON.stringify(state.gameOver)); break; }
}
var simMs = Date.now() - t1;
console.log('Simulated ' + Math.round(state.time) + ' game hours in ' + simMs + ' ms (' +
  (simMs / Math.max(1, state.time)).toFixed(2) + ' ms per game hour)');

// --- save / load round trip ------------------------------------------------
var saved = IA.save.save(state);
check('save succeeds', saved.ok, saved.why);
var loaded = IA.save.load();
check('load succeeds', loaded.ok, loaded.why);
if (loaded.ok) {
  var s2 = loaded.state;
  check('time round-trips', Math.abs(s2.time - state.time) < 1e-6, s2.time + ' vs ' + state.time);
  check('army count round-trips', s2.armies.length === state.armies.length,
    s2.armies.length + ' vs ' + state.armies.length);
  check('ownership round-trips', s2.nations.every(function (n) {
    var orig = state.nationById[n.id];
    return orig && orig.provinces.length === n.provinces.length;
  }));
  check('map geometry is identical', s2.provinces.length === state.provinces.length &&
    s2.provinces[10].name === state.provinces[10].name);
  // Both copies should evolve identically from here.
  IA.loop.advance(state, 24);
  IA.loop.advance(s2, 24);
  check('loaded game stays in sync', Math.abs(s2.nationById[s2.playerId].resources.money -
    state.nationById[state.playerId].resources.money) < 1,
    s2.nationById[s2.playerId].resources.money + ' vs ' + state.nationById[state.playerId].resources.money);
}

// --- player-facing actions -------------------------------------------------
var player = state.nationById[state.playerId];
if (player.alive && player.provinces.length) {
  var home = state.provinces[player.provinces[0]];
  player.resources.money += 500000;
  player.resources.iron += 50000;
  player.resources.timber += 50000;
  player.resources.coal += 50000;
  player.resources.manpower += 50000;
  player.resources.grain += 50000;
  var built = IA.orders.startConstruction(state, home, 'barracks');
  check('player can start construction', built.ok || !!home.construction, built.why);
  var qres = IA.orders.queueUnit(state, home, 'line_infantry');
  check('player can queue line infantry', qres.ok || (home.buildings.barracks || 0) < 1, qres.why);
  var tech = IA.orders.startResearch(state, player, 'conscription');
  check('player can research', tech.ok || !!player.researching, tech.why);
  var mres = IA.market.buy(state, player, 'oil', 100);
  check('player can trade', mres.ok, mres.why);
}

if (failures.length) {
  console.error('\nFAILED (' + failures.length + '):');
  failures.slice(0, 20).forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('\nAll checks passed.');
