/*
 * Opponent AI.
 *
 * Each AI nation gets a turn every few game hours (staggered so the work is
 * spread out).  A turn runs five short passes: research, construction,
 * production, trade, then military and diplomacy.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var UnitData = IA.UnitData;
  var BuildingData = IA.BuildingData;
  var ResearchData = IA.ResearchData;

  var TURN_INTERVAL = 6;      // game hours between turns for one nation

  /* Roughly the order a general staff would have wanted them. */
  var TECH_PRIORITY = [
    'conscription', 'machine_guns', 'quick_firing_guns', 'rail_logistics',
    'war_economy', 'defence_in_depth', 'shell_standardisation', 'aviation',
    'motorisation', 'field_hospitals', 'counter_battery', 'siege_guns',
    'propaganda_bureau', 'assembly_lines', 'naval_gunnery', 'interceptors',
    'infiltration', 'motor_transport', 'landships', 'synthetic_chemistry',
    'creeping_barrage', 'armour_plate', 'air_superiority', 'total_mobilisation',
    'submarine_warfare', 'convoy_doctrine', 'strategic_bombing', 'dreadnoughts'
  ];

  function tick(state, rng, hours) {
    for (var i = 0; i < state.nations.length; i++) {
      var nation = state.nations[i];
      if (!nation.alive || !nation.ai) continue;
      nation.nextTurn = nation.nextTurn === undefined
        ? state.time + (i % TURN_INTERVAL)
        : nation.nextTurn;
      if (state.time < nation.nextTurn) continue;
      nation.nextTurn = state.time + TURN_INTERVAL;
      takeTurn(state, rng, nation);
    }
  }

  function takeTurn(state, rng, nation) {
    doResearch(state, nation);
    doConstruction(state, rng, nation);
    doProduction(state, rng, nation);
    doTrade(state, nation);
    doMilitary(state, rng, nation);
    doDiplomacy(state, rng, nation);
  }

  // --- research ------------------------------------------------------------

  function doResearch(state, nation) {
    if (nation.researching) return;
    for (var i = 0; i < TECH_PRIORITY.length; i++) {
      var tech = ResearchData.BY_ID[TECH_PRIORITY[i]];
      if (!tech || !IA.orders.techAvailable(nation, tech)) continue;
      if (!IA.economy.canAfford(nation, tech.cost)) continue;
      // Keep a money cushion so the war effort does not stall.
      if (nation.resources.money - (tech.cost.money || 0) < 6000) continue;
      IA.orders.startResearch(state, nation, tech.id);
      return;
    }
  }

  // --- construction --------------------------------------------------------

  function borderPressure(state, prov) {
    var pressure = 0;
    for (var i = 0; i < prov.neighbors.length; i++) {
      var np = state.provinces[prov.neighbors[i]];
      if (np.isSea || !np.nationId || np.nationId === prov.nationId) continue;
      pressure += IA.state.atWar(state, prov.nationId, np.nationId) ? 3 : 1;
    }
    return pressure;
  }

  function doConstruction(state, rng, nation) {
    if (nation.resources.money < 6000) return;
    var best = null;
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      if (!prov || prov.construction) continue;
      var choice = pickBuilding(state, nation, prov);
      if (!choice) continue;
      var cost = BuildingData.costFor(choice.id, (prov.buildings[choice.id] || 0) + 1);
      if (!IA.economy.canAfford(nation, cost)) continue;
      if (!best || choice.score > best.score) best = { prov: prov, id: choice.id, score: choice.score };
    }
    if (best) IA.orders.startConstruction(state, best.prov, best.id);
  }

  function pickBuilding(state, nation, prov) {
    var lvl = function (id) { return prov.buildings[id] || 0; };
    var options = [];
    var pressure = borderPressure(state, prov);

    if (lvl('barracks') < 1) options.push({ id: 'barracks', score: 100 });
    if (prov.isCapital && lvl('workshop') < 1) options.push({ id: 'workshop', score: 95 });
    if (lvl('railway') < 2) options.push({ id: 'railway', score: 78 + prov.pop * 0.12 - lvl('railway') * 10 });
    if (lvl('factory') < 3) options.push({ id: 'factory', score: 70 + prov.pop * 0.2 - lvl('factory') * 12 });
    if (lvl('barracks') < 2 && prov.pop > 40) options.push({ id: 'barracks', score: 60 });
    // A province with enemies next door digs in before it does anything else.
    if (pressure >= 3 && lvl('fort') < 3) options.push({ id: 'fort', score: 68 + pressure * 5 });
    if (lvl('workshop') < 2 && nation.provinces.length > 6 && prov.pop > 45) {
      options.push({ id: 'workshop', score: 55 });
    }
    if ((nation.warCount || 0) > 0 && lvl('warehouse') < 2 && (prov.supplyDist || 0) > 2) {
      options.push({ id: 'warehouse', score: 62 });
    }
    if (prov.morale < 60 && lvl('admin') < 2) options.push({ id: 'admin', score: 58 });
    if (lvl('airfield') < 1 && prov.isCapital && IA.economy.hasTech(nation, 'aviation')) {
      options.push({ id: 'airfield', score: 50 });
    }
    if (prov.coastal && lvl('harbour') < 1 && IA.economy.hasTech(nation, 'naval_gunnery')) {
      options.push({ id: 'harbour', score: 45 });
    }

    var best = null;
    for (var i = 0; i < options.length; i++) {
      var b = BuildingData.BY_ID[options[i].id];
      if (b.coastalOnly && !prov.coastal) continue;
      if ((prov.buildings[options[i].id] || 0) >= b.maxLevel) continue;
      if (!best || options[i].score > best.score) best = options[i];
    }
    return best;
  }

  // --- production ----------------------------------------------------------

  /*
   * What the nation wants, capped by what it can actually feed and pay for.
   * Without the second half, small countries at war raise armies that starve
   * themselves within a week.
   */
  function desiredArmySize(state, nation) {
    var want = Math.round(3 + nation.provinces.length * 1.4 + (nation.warCount || 0) * 4);
    var income = nation.income;
    if (income) {
      // Roughly the running cost of one infantry battalion, with headroom.
      var byFood = income.grain / 3.6;
      var byCash = income.money / 7.5;
      want = Math.min(want, Math.floor(Math.min(byFood, byCash)));
    }
    return Math.max(1, want);
  }

  function doProduction(state, rng, nation) {
    // Never dig the hole deeper while already running a deficit.
    var net = nation.net;
    if (net && (net.grain < 0 || net.money < 0)) return;

    var armies = IA.state.armiesOf(state, nation.id);
    var battalions = 0;
    for (var i = 0; i < armies.length; i++) battalions += IA.state.unitCount(armies[i]);
    var queued = 0;
    for (var q = 0; q < nation.provinces.length; q++) queued += state.provinces[nation.provinces[q]].queue.length;
    if (battalions + queued >= desiredArmySize(state, nation)) return;

    var wishlist = buildWishlist(state, nation);
    for (var w = 0; w < wishlist.length; w++) {
      var typeId = wishlist[w];
      var type = UnitData.BY_ID[typeId];
      if (!IA.economy.canAfford(nation, type.cost)) continue;
      var prov = pickProductionProvince(state, nation, type);
      if (!prov) continue;
      var res = IA.orders.queueUnit(state, prov, typeId);
      if (res.ok) return;
    }
  }

  /*
   * What to build, best first.  Guns before glamour: artillery and machine
   * guns win 1914 battles, and the expensive toys are only worth it once the
   * treasury can carry them.
   */
  function buildWishlist(state, nation) {
    var has = function (t) { return IA.economy.hasTech(nation, t); };
    var list = [];
    var r = nation.resources;
    if (has('landships') && r.money > 30000) list.push('tank');
    if (has('siege_guns') && r.money > 22000) list.push('heavy_artillery');
    if (has('quick_firing_guns') && r.money > 10000) list.push('field_artillery');
    if (has('machine_guns') && r.money > 6000) list.push('machine_gun');
    if (has('infiltration') && r.money > 14000) list.push('assault_infantry');
    if (has('defence_in_depth') && r.money > 12000) list.push('guard_infantry');
    if (has('motorisation') && r.money > 16000) list.push('armoured_car');
    list.push('line_infantry');
    return list;
  }

  function pickProductionProvince(state, nation, type) {
    var best = null;
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      if (!prov || prov.queue.length >= 3) continue;
      if (!IA.economy.canBuildUnitHere(state, prov, type).ok) continue;
      var score = 100 - prov.queue.length * 20 - (prov.supplyDist || 0) * 3 + prov.pop * 0.1;
      if (!best || score > best.score) best = { prov: prov, score: score };
    }
    return best ? best.prov : null;
  }

  // --- trade ---------------------------------------------------------------

  function doTrade(state, nation) {
    var market = IA.market;
    var r = nation.resources;
    var income = nation.net || {};
    for (var i = 0; i < market.TRADED.length; i++) {
      var res = market.TRADED[i];
      var flow = income[res] || 0;
      var lowWater = res === 'grain' ? 3000 : 900;
      if (r[res] < lowWater && flow < 0 && r.money > 8000) {
        market.buy(state, nation, res, Math.min(1200, Math.floor(r.money * 0.25 / market.buyPrice(state, res))));
      } else if (r[res] > 22000 && flow > 0) {
        market.sell(state, nation, res, Math.floor((r[res] - 18000) * 0.5));
      }
    }
  }

  // --- military ------------------------------------------------------------

  function estimateDefence(state, provinceId, attackerId) {
    var defenders = IA.state.allArmiesAt(state, provinceId).filter(function (a) {
      return IA.state.isHostile(state, attackerId, a.ownerId) ||
        (state.provinces[provinceId].nationId && a.ownerId === state.provinces[provinceId].nationId);
    });
    var power = 0;
    for (var i = 0; i < defenders.length; i++) power += IA.state.armyPower(defenders[i]);
    var prov = state.provinces[provinceId];
    if (!prov.isSea) {
      power *= 1 + IA.economy.buildingEffect(prov, 'bunker', 'defence');
      power *= IA.worldgen.TERRAIN[prov.terrain] ? IA.worldgen.TERRAIN[prov.terrain].def : 1;
    }
    return power;
  }

  /** Provinces this nation would like to take, nearest first. */
  function findObjectives(state, nation) {
    var seen = {}, out = [];
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      for (var j = 0; j < prov.neighbors.length; j++) {
        var np = state.provinces[prov.neighbors[j]];
        if (np.isSea || seen[np.id]) continue;
        if (np.nationId === nation.id) continue;
        if (np.nationId && !IA.state.atWar(state, nation.id, np.nationId)) continue;
        seen[np.id] = true;
        out.push(np);
      }
    }
    return out;
  }

  function doMilitary(state, rng, nation) {
    var armies = IA.state.armiesOf(state, nation.id);
    var objectives = findObjectives(state, nation);

    // Consolidate: merge idle stacks that share a province.
    var byProv = {};
    for (var i = 0; i < armies.length; i++) {
      var a = armies[i];
      if (a.path.length || a.inCombat) continue;
      (byProv[a.provinceId] || (byProv[a.provinceId] = [])).push(a);
    }
    for (var pid in byProv) {
      var group = byProv[pid];
      for (var g = 1; g < group.length; g++) {
        if (IA.state.unitCount(group[0]) >= 8) break;
        if (IA.orders.canMerge(state, group[0], group[g])) {
          IA.orders.mergeArmies(state, group[0], group[g]);
        }
      }
    }

    armies = IA.state.armiesOf(state, nation.id);
    var claimed = {};
    var seaPlan = null;              // built the first time a squadron asks
    for (var k = 0; k < armies.length; k++) {
      var army = armies[k];
      if (army.path.length || army.inCombat) continue;
      var power = IA.state.armyPower(army);
      var domain = IA.orders.armyDomain(army);

      // Artillery and other ranged stacks shell rather than charge.
      var reach = IA.combat.maxRange(state, army);
      if (reach > 0 && domain !== 'sea') {
        var shellTarget = pickBombardTarget(state, nation, army, reach);
        if (shellTarget) { IA.orders.issueBombard(state, army, shellTarget); continue; }
      }

      if (domain === 'sea') {
        if (!seaPlan) seaPlan = navalObjectives(state, nation);
        patrol(state, rng, army, seaPlan, claimed);
        continue;
      }

      /*
       * Score every objective with cheap straight-line distance first, then
       * pathfind only for the best few.  Running a full route search for every
       * candidate is what made the AI the most expensive part of the tick.
       */
      var here = state.provinces[army.provinceId];
      var ranked = [];
      for (var o = 0; o < objectives.length; o++) {
        var target = objectives[o];
        if (claimed[target.id] && claimed[target.id] > 1) continue;
        if (!IA.orders.canEnter(state, army, target)) continue;
        var defence = estimateDefence(state, target.id, nation.id);
        if (power < defence * 1.15 + 4) continue;
        var dx = target.cx - here.cx, dy = target.cy - here.cy;
        var crow = Math.sqrt(dx * dx + dy * dy);
        ranked.push({ target: target, score: target.vp + (target.nationId ? 6 : 0) - crow * 0.25 });
      }
      ranked.sort(function (x, y) { return y.score - x.score; });

      var chosen = null;
      for (var c = 0; c < ranked.length && c < 3; c++) {
        var path = IA.orders.findPath(state, army, army.provinceId, ranked[c].target.id);
        if (path) { chosen = ranked[c].target; break; }
      }
      if (chosen) {
        claimed[chosen.id] = (claimed[chosen.id] || 0) + 1;
        IA.orders.issueMove(state, army, chosen.id);
        continue;
      }

      // Nothing worth attacking: garrison the most exposed province.
      var threat = mostThreatenedProvince(state, nation);
      if (threat && threat.id !== army.provinceId && IA.state.armiesIn(state, threat.id).length < 2) {
        IA.orders.issueMove(state, army, threat.id);
      }
    }
  }

  function pickBombardTarget(state, nation, army, reach) {
    var prov = state.provinces[army.provinceId];
    var best = null;
    for (var i = 0; i < prov.neighbors.length; i++) {
      var np = state.provinces[prov.neighbors[i]];
      var enemies = IA.state.allArmiesAt(state, np.id).filter(function (o) {
        return IA.state.isHostile(state, nation.id, o.ownerId);
      });
      if (!enemies.length) continue;
      var power = 0;
      for (var e = 0; e < enemies.length; e++) power += IA.state.armyPower(enemies[e]);
      if (!best || power > best.power) best = { id: np.id, power: power };
    }
    return best ? best.id : null;
  }

  function mostThreatenedProvince(state, nation) {
    var best = null;
    for (var i = 0; i < nation.provinces.length; i++) {
      var prov = state.provinces[nation.provinces[i]];
      var threat = 0;
      for (var j = 0; j < prov.neighbors.length; j++) {
        var np = state.provinces[prov.neighbors[j]];
        var enemies = IA.state.allArmiesAt(state, np.id).filter(function (o) {
          return IA.state.isHostile(state, nation.id, o.ownerId);
        });
        for (var e = 0; e < enemies.length; e++) threat += IA.state.armyPower(enemies[e]);
      }
      threat += prov.isCapital ? 20 : 0;
      if (threat <= 0) continue;
      if (!best || threat > best.threat) best = { id: prov.id, threat: threat };
    }
    return best ? state.provinces[best.id] : null;
  }

  /*
   * Where a fleet is worth having.
   *
   * At war the most valuable water is whatever an enemy port has to use: a
   * squadron sitting there shuts the port's trade and cuts every convoy lane
   * behind it, which costs the enemy more than any single province.  Next best
   * is water off a port of your own that somebody else has shut — that is a
   * blockade to be lifted.  With no war on, ships stay near home, where they
   * will be wanted first.
   *
   * Computed once per nation per turn and shared by all its squadrons, because
   * it is a scan of the whole coast.
   */
  function navalObjectives(state, nation) {
    var index = {}, out = [];
    function add(seaId, worth) {
      if (index[seaId] !== undefined) { out[index[seaId]].worth += worth; return; }
      index[seaId] = out.length;
      out.push({ id: seaId, worth: worth });
    }
    for (var i = 0; i < state.landCount; i++) {
      var p = state.provinces[i];
      if (!p.seaport || !p.nationId || !p.pop) continue;
      var mine = p.nationId === nation.id;
      if (!mine && !IA.state.isHostile(state, nation.id, p.nationId)) continue;
      for (var k = 0; k < p.neighbors.length; k++) {
        var np = state.provinces[p.neighbors[k]];
        if (!np.isSea || np.isLake) continue;
        if (mine) {
          // Water off our own coast that our shipping can no longer use is
          // somebody else's squadron, and driving it off is the first job.
          add(np.id, IA.naval.passable(state, nation.id, np.id) ? p.pop * 0.05 : p.pop * 0.9);
        } else {
          // A port already shut is worth holding; a fresh one is worth more.
          add(np.id, p.blockaded ? p.pop * 0.25 : p.pop);
        }
      }
    }
    out.sort(function (a, b) { return b.worth - a.worth; });
    return out.length > 40 ? out.slice(0, 40) : out;
  }

  function patrol(state, rng, army, objectives, claimed) {
    var prov = state.provinces[army.provinceId];
    var nation = state.nationById[army.ownerId];
    if (!objectives || !objectives.length) return;
    var mine = IA.naval.warshipPower(army);
    var best = null;
    for (var i = 0; i < objectives.length; i++) {
      var o = objectives[i];
      if (claimed[o.id]) continue;
      // Do not steam into guns that outweigh you; that is how a navy is lost
      // in an afternoon.
      var facing = 0;
      var there = IA.naval.fleetsIn(state, o.id);
      for (var f = 0; f < there.length; f++) {
        if (IA.state.isHostile(state, nation.id, there[f].nationId)) facing += there[f].power;
      }
      if (facing > mine * 1.3) continue;
      var target = state.provinces[o.id];
      var dx = target.cx - prov.cx, dy = target.cy - prov.cy;
      var score = o.worth / (1 + Math.sqrt(dx * dx + dy * dy) * 0.02);
      if (!best || score > best.score) best = { id: o.id, score: score };
    }
    if (!best) return;
    claimed[best.id] = (claimed[best.id] || 0) + 1;
    if (best.id === army.provinceId) return;             // already on station
    if (!IA.orders.issueMove(state, army, best.id).ok && rng.chance(0.4)) {
      // Nowhere to sail from here; drift rather than sit dead in the water.
      var near = prov.neighbors.filter(function (id) { return state.provinces[id].isSea; });
      if (near.length) IA.orders.issueMove(state, army, rng.pick(near));
    }
  }

  // --- diplomacy -----------------------------------------------------------

  function doDiplomacy(state, rng, nation) {
    var i, other;
    // Sue for peace when the war is going badly.
    if (nation.warCount > 0) {
      var enemies = Object.keys(nation.treaties);
      for (i = 0; i < enemies.length; i++) {
        other = state.nationById[enemies[i]];
        if (!other || !other.alive || other.id === nation.id) continue;
        if (nation.treaties[other.id] !== 'war') continue;
        var mine = IA.state.nationPower(state, nation.id) + nation.vp * 2;
        var theirs = IA.state.nationPower(state, other.id) + other.vp * 2;
        if (theirs > mine * 1.5 || nation.warCount >= 3 || nation.shortage) {
          if (rng.chance(0.3)) IA.diplomacy.proposeTreaty(state, nation.id, other.id, 'peace');
        }
      }
      return;
    }

    // Otherwise look for an opportunity, or a friend.  Nobody shoots first in
    // the opening days; the map needs time to settle.
    var mayDeclare = state.time > 72;      // a few days of calm before the first shot
    var contacts = nation.contacts || [];
    // The campaign settings scale everyone's appetite for a new war at once.
    var appetite = nation.aggression * 0.16 * ((state.settings && state.settings.aggression) || 1);
    if (mayDeclare && contacts.length && rng.chance(appetite)) {
      var prey = null;
      // Only bordering nations are worth a war; there is no way to reach the
      // rest without a navy and a reason.
      for (i = 0; i < contacts.length; i++) {
        other = state.nationById[contacts[i]];
        if (!other || !other.alive || other.id === nation.id) continue;
        var t = IA.state.treaty(state, nation.id, other.id);
        if (t === 'alliance' || t === 'nap' || t === 'war') continue;
        var rel = IA.diplomacy.relation(state, nation.id, other.id);
        if (rel > 25) continue;
        var myP = IA.state.nationPower(state, nation.id);
        var theirP = IA.state.nationPower(state, other.id);
        if (theirP > myP * 0.75) continue;
        var score = (myP - theirP) + other.vp - rel;
        if (!prey || score > prey.score) prey = { id: other.id, score: score };
      }
      if (prey) IA.diplomacy.declareWar(state, nation.id, prey.id, 'territorial claims');
      return;
    }

    if (rng.chance(0.12) && contacts.length) {
      var friend = null;
      for (i = 0; i < contacts.length; i++) {
        other = state.nationById[contacts[i]];
        if (!other || !other.alive || other.id === nation.id) continue;
        if (IA.state.treaty(state, nation.id, other.id) !== 'peace') continue;
        var r = IA.diplomacy.relation(state, nation.id, other.id);
        if (r < 10) continue;
        if (!friend || r > friend.rel) friend = { id: other.id, rel: r };
      }
      if (friend) {
        IA.diplomacy.proposeTreaty(state, nation.id, friend.id, friend.rel > 45 ? 'alliance' : 'nap');
      }
    }
  }

  IA.ai = { tick: tick, takeTurn: takeTurn, findObjectives: findObjectives, TURN_INTERVAL: TURN_INTERVAL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
