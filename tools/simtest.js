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
  'src/game/weather.js',
  'src/game/market.js',
  'src/game/state.js',
  'src/game/economy.js',
  'src/game/combat.js',
  'src/game/orders.js',
  'src/game/ai.js',
  'src/game/victory.js',
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

/*
 * Supply is cut by troops standing on the ground, not only by losing it.
 *
 * On day one nobody has built a depot, so the capital is a nation's only
 * source.  Put a hostile stack on every province around it and the rest of the
 * country must go dark — if it does not, supply is leaking through the enemy.
 */
(function () {
  var player = state.nationById[state.playerId];
  var cap = state.provinces[player.capitalProvince];
  var foe = state.nations.filter(function (n) {
    return n.alive && IA.state.atWar(state, state.playerId, n.id);
  })[0];
  if (!foe) { check('the player has a war to test supply with', false); return; }

  var before = player.provinces.filter(function (id) { return state.provinces[id].inSupply; }).length;
  check('supply reaches beyond the capital to begin with', before > 1, 'reached ' + before);

  var planted = [];
  for (var i = 0; i < cap.neighbors.length; i++) {
    var np = state.provinces[cap.neighbors[i]];
    if (np.isSea) continue;
    planted.push(IA.state.spawnArmy(state, foe.id, np.id, [{ typeId: 'line_infantry', count: 1 }]));
  }
  check('the capital has land neighbours to blockade', planted.length > 0);
  IA.economy.refreshSupply(state);
  var after = player.provinces.filter(function (id) { return state.provinces[id].inSupply; }).length;
  check('an enemy astride the road cuts the supply behind it', after < before,
    'reached ' + after + ' of ' + player.provinces.length + ', was ' + before);
  check('the capital still feeds itself', cap.inSupply === true);

  // Put the world back before the real run starts.
  planted.forEach(function (a) {
    var at = state.armies.indexOf(a);
    if (at >= 0) state.armies.splice(at, 1);
  });
  IA.combat.reconcile(state);
  IA.economy.refreshSupply(state);
  check('supply comes back once the road is clear',
    player.provinces.filter(function (id) { return state.provinces[id].inSupply; }).length === before);
})();

/*
 * The seasons have to arrive, and arrive in the right hemisphere.  Checked by
 * winding the clock rather than by running the war, so it costs nothing.
 */
(function () {
  var was = state.time;
  check('the war opens in July 1914', IA.weather.formatDate(state) === '28 July 1914',
    IA.weather.formatDate(state));

  var north = state.provinces[state.nationById.RUS.capitalProvince];   // Petrograd
  var south = null;
  for (var i = 0; i < state.provinces.length; i++) {
    var p = state.provinces[i];
    if (!p.isSea && p.size > 0 && p.lat < -30) { south = p; break; }
  }
  check('the map reaches the southern hemisphere', !!south);

  function seasonsOverAYear(prov) {
    var seen = {};
    for (var d = 0; d < 365; d += 15) {
      state.time = d * 24;
      seen[IA.weather.season(state, prov)] = true;
    }
    return Object.keys(seen).sort().join(',');
  }
  check('all four seasons come round', seasonsOverAYear(north) === 'autumn,spring,summer,winter');

  state.time = 180 * 24;                    // late January 1915
  check('January is winter in the north', IA.weather.season(state, north) === 'winter',
    IA.weather.season(state, north));
  if (south) {
    check('and summer in the south', IA.weather.season(state, south) === 'summer',
      IA.weather.season(state, south));
  }

  // Winter has to actually reach the ground, not merely be a label.
  IA.weather.refresh(state);
  var frozen = 0;
  for (var q = 0; q < state.provinces.length; q++) {
    var w = state.provinces[q].weather;
    if (w === 'snow' || w === 'blizzard') frozen++;
  }
  check('winter puts snow on the map', frozen > 40, 'only ' + frozen + ' provinces');
  check('bad weather slows an army', IA.weather.WEATHER.blizzard.speed < 0.5);

  // Weather is derived from the seed and the day, so it must be reproducible.
  var sample = state.provinces[north.id].weather;
  state.time = 12 * 24;
  IA.weather.refresh(state);
  state.time = 180 * 24;
  IA.weather.refresh(state);
  check('weather is a pure function of the day', state.provinces[north.id].weather === sample);

  state.time = was;
  IA.weather.refresh(state);
})();

/*
 * Standing and the term of a pact.
 *
 * Two neutrals are used so nothing here disturbs the war about to be run, and
 * the pair is put back afterwards.
 */
(function () {
  var a = 'SWE', b = 'NOR';
  if (!state.nationById[a] || !state.nationById[b]) { check('neutrals exist to test with', false); return; }
  var was = state.time;
  var repBefore = IA.diplomacy.reputation(state, a);
  check('a power starts with a reputation', repBefore === IA.diplomacy.REPUTATION_BASE, String(repBefore));

  // Signing sets a term rather than binding for ever.
  IA.diplomacy.setTreaty(state, a, b, 'peace');
  IA.diplomacy.proposeTreaty(state, a, b, 'nap');
  IA.diplomacy.setTreaty(state, a, b, 'nap');
  IA.diplomacy.setRelation(state, a, b, 40);
  var until = state.time + IA.diplomacy.TERM.nap;
  state.nationById[a].treatyUntil[b] = until;
  state.nationById[b].treatyUntil[a] = until;
  check('a pact has an end date', IA.diplomacy.treatyExpiry(state, a, b) > state.time);

  // Letting it run out is not a betrayal and costs no standing.
  state.time = until + 1;
  IA.diplomacy.expireTreaties(state);
  check('a pact lapses when its term is up', IA.state.treaty(state, a, b) === 'peace',
    IA.state.treaty(state, a, b));
  check('letting a pact lapse costs no standing',
    IA.diplomacy.reputation(state, a) === repBefore, String(IA.diplomacy.reputation(state, a)));

  // Tearing one up is.
  IA.diplomacy.setTreaty(state, a, b, 'alliance');
  IA.diplomacy.setRelation(state, a, b, 60);
  IA.diplomacy.declareWar(state, a, b, 'test');
  var repAfter = IA.diplomacy.reputation(state, a);
  check('turning on an ally costs standing', repAfter < repBefore - 20,
    repBefore + ' -> ' + repAfter);
  check('and the world can see it', IA.diplomacy.reputationLabel(repAfter) !== 'Trusted',
    IA.diplomacy.reputationLabel(repAfter));

  // And standing comes back, slowly, if you behave.
  var rng = new IA.RNG(1);
  for (var d = 0; d < 60; d++) IA.diplomacy.tickRelations(state, rng, 24);
  check('standing recovers with good conduct', IA.diplomacy.reputation(state, a) > repAfter,
    repAfter + ' -> ' + IA.diplomacy.reputation(state, a));

  // Put the pair back the way they were.
  IA.diplomacy.setTreaty(state, a, b, 'peace');
  IA.diplomacy.setRelation(state, a, b, 0);
  state.nationById[a].reputation = repBefore;
  state.nationById[b].reputation = repBefore;
  state.time = was;
  IA.diplomacy.refreshWarCounts(state);
})();

/*
 * Every way of winning has to be reachable.
 *
 * A victory condition that can never fire is decoration, so each one is driven
 * to its trigger on a throwaway copy of the world and the winner checked.  The
 * copy is a save/load round trip, which keeps the real run untouched.
 */
(function () {
  var snapshot = JSON.parse(JSON.stringify(IA.save.serialise(state)));
  function fresh() { return IA.save.deserialise(JSON.parse(JSON.stringify(snapshot))); }

  var report = IA.victory.report(state, state.nationById[state.playerId]);
  check('there are six ways to win', report.length === 6, 'got ' + report.length);
  check('none of them is already met on day one',
    report.every(function (r) { return !r.met; }),
    report.filter(function (r) { return r.met; }).map(function (r) { return r.id; }).join(','));
  check('every condition explains itself',
    report.every(function (r) { return r.name && r.detail && r.note !== undefined; }));

  function wins(label, id, setup) {
    var s = fresh();
    setup(s, s.nationById[s.playerId]);
    var got = IA.victory.check(s);
    check(label, !!got && got.condition === id && got.winner === s.playerId,
      got ? got.condition + ' by ' + got.winner : 'nobody won');
  }

  wins('domination can be won', 'domination', function (s, me) {
    me.vp = s.victoryVP + 1;
  });

  wins('the capitals can be taken', 'capitals', function (s, me) {
    var taken = 0;
    for (var i = 0; i < s.nations.length && taken < IA.victory.CAPITALS_NEEDED; i++) {
      var other = s.nations[i];
      if (other.id === me.id || !other.alive) continue;
      s.provinces[other.capitalProvince].nationId = me.id;
      taken++;
    }
  });

  /*
   * Deliberately short of the domination threshold on its own — the bloc is
   * what carries it over the line, which is the whole point of the condition
   * and the reason the first draft of this test passed for the wrong reason.
   */
  wins('a coalition can win', 'coalition', function (s, me) {
    me.vp = Math.floor(s.totalVP * 0.30);
    var allies = 0;
    for (var i = 0; i < s.nations.length; i++) {
      var o = s.nations[i];
      if (o.id === me.id || !o.alive) continue;
      if (IA.state.treaty(s, me.id, o.id) !== 'alliance') continue;
      o.vp = Math.floor(s.totalVP * 0.21);
      if (++allies >= 1) break;
    }
    check('the player has an ally to form a bloc with', allies > 0);
  });

  wins('industry can win it', 'industry', function (s, me) {
    me.industryStreak = IA.victory.INDUSTRY_DAYS;
  });

  wins('conquest can win it', 'conquest', function (s, me) {
    for (var i = 0; i < s.nations.length; i++) {
      if (s.nations[i].id !== me.id) s.nations[i].alive = false;
    }
  });

  wins('the armistice ends it', 'armistice', function (s, me) {
    s.time = (IA.victory.armisticeDay(s) + 1) * 24;
    var top = 0;
    for (var i = 0; i < s.nations.length; i++) if (s.nations[i].vp > top) top = s.nations[i].vp;
    me.vp = top + 1;
  });

  // And the world as it stands must not accidentally satisfy any of them.
  check('nobody has won on day one', IA.victory.check(state) === null);
})();

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
var sawCutOff = 0;
for (var h = 0; h < hours; h++) {
  IA.loop.advance(state, 1);

  // Invariants checked every hour.
  for (var a = 0; a < state.armies.length; a++) {
    var army = state.armies[a];
    if (!army.units.length) { check('no empty stacks', false, army.id); break; }
    var prov = state.provinces[army.provinceId];
    if (!prov || prov.size === 0) { check('armies stand on real provinces', false, army.id); break; }
    if (army.supplied === false) sawCutOff++;
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

    // A nation still holding its capital feeds itself from it, so the capital
    // is in supply by construction and the trace is broken if it is not.
    if (nat.alive) {
      var capProv = state.provinces[nat.capitalProvince];
      if (capProv && capProv.nationId === nat.id) {
        check('a held capital is in supply', capProv.inSupply === true,
          nat.id + ' capital ' + capProv.name + ' supply=' + capProv.supply);
      }
      for (var sp = 0; sp < nat.provinces.length; sp++) {
        var pr = state.provinces[nat.provinces[sp]];
        if (!(pr.supply >= 0 && pr.supply < 40)) {
          check('supply stays within reach', false, nat.id + '/' + pr.name + ' = ' + pr.supply);
          break;
        }
      }
    }
  }
  if (failures.length) break;

  if (Math.floor(h / 24) > lastReport) {
    lastReport = Math.floor(h / 24);
    if (lastReport % 10 === 0) {
      var leader = state.nations.filter(function (x) { return x.alive; })
        .sort(function (x, y) { return y.vp - x.vp; })[0];
      var wars = 0;
      for (var w = 0; w < state.nations.length; w++) wars += (state.nations[w].warCount || 0);
      var battalions = 0, starving = 0, cutOff = 0;
      for (var b = 0; b < state.armies.length; b++) {
        battalions += IA.state.unitCount(state.armies[b]);
        if (state.armies[b].supplied === false) cutOff++;
      }
      for (var sn = 0; sn < state.nations.length; sn++) if (state.nations[sn].shortage) starving++;
      console.log('  day ' + (lastReport + 1) + ': ' + state.armies.length + ' stacks / ' +
        battalions + ' battalions (' + cutOff + ' cut off), ' + (wars / 2) +
        ' wars, ' + starving + ' nations short of supply, leader ' +
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

// Supply that never binds is supply nobody has to think about.
check('supply lines get cut over a war of this length', sawCutOff > 0);

if (failures.length) {
  console.error('\nFAILED (' + failures.length + '):');
  failures.slice(0, 20).forEach(function (f) { console.error('  - ' + f); });
  process.exit(1);
}
console.log('\nAll checks passed.');
