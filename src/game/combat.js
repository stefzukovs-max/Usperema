/*
 * Combat resolution.
 *
 * Every combat hour: ranged units bombard their declared target, stacks that
 * share a province exchange fire, badly mauled stacks withdraw, and armies
 * standing on hostile ground grind down its occupation timer.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};
  var UnitData = IA.UnitData;
  var TERRAIN = IA.worldgen.TERRAIN;
  var clamp = IA.util.clamp;

  var DEF_K = 12;              // defence value that halves incoming damage
  var DAMAGE_SCALE = 0.45;     // global pacing knob for how fast stacks melt
  var RETREAT_RATIO = 0.15;

  function unitsAlive(army) {
    var out = [];
    for (var i = 0; i < army.units.length; i++) if (army.units[i].hp > 0.001) out.push(army.units[i]);
    return out;
  }

  /** Share of a stack's hit points held by each target class. */
  function composition(armies) {
    var comp = { inf: 0, arm: 0, air: 0, sea: 0 }, total = 0;
    for (var i = 0; i < armies.length; i++) {
      var us = unitsAlive(armies[i]);
      for (var j = 0; j < us.length; j++) {
        var t = UnitData.BY_ID[us[j].typeId];
        comp[t.cat] += us[j].hp;
        total += us[j].hp;
      }
    }
    if (total > 0) for (var k in comp) comp[k] /= total;
    return { frac: comp, total: total };
  }

  /** The class most of a force belongs to; decides which defence stat applies. */
  function dominantCat(armies) {
    var c = composition(armies).frac;
    var best = 'inf', bv = -1;
    for (var k in c) if (c[k] > bv) { bv = c[k]; best = k; }
    return best;
  }

  function techAtkBonus(nation, type) {
    var e = IA.economy;
    var b = 0;
    var ranged = type.range > 0;
    if (type.cat === 'inf' && !ranged) b += e.techBonus(nation, 'infAtk');
    if (ranged) b += e.techBonus(nation, 'artAtk');
    return b;
  }

  function techDefBonus(nation, type) {
    var e = IA.economy;
    var b = 0;
    if (type.cat === 'inf') b += e.techBonus(nation, 'infDef');
    if (type.cat === 'arm') b += e.techBonus(nation, 'armDef');
    if (type.cat === 'air') b += e.techBonus(nation, 'airDef');
    return b;
  }

  /** Ammunition available scales damage; an empty magazine is a real problem. */
  function ammoFactor(state, nation, armies, hours) {
    var need = 0;
    for (var i = 0; i < armies.length; i++) {
      var us = unitsAlive(armies[i]);
      for (var j = 0; j < us.length; j++) {
        var t = UnitData.BY_ID[us[j].typeId];
        need += (t.shells || 0) * (us[j].hp / t.hp) * hours;
      }
    }
    if (need <= 0) return 1;
    var have = nation.resources.shells || 0;
    if (have >= need) { nation.resources.shells = have - need; return 1; }
    nation.resources.shells = 0;
    return clamp(0.35 + 0.65 * (have / need), 0.35, 1);
  }

  /**
   * One exchange of fire from `side` onto `foe`.
   * Returns total damage dealt.
   */
  function fire(state, rng, side, foe, prov, hours, opts) {
    opts = opts || {};
    var nation = state.nationById[side.ownerId];
    if (!nation) return 0;
    var foeComp = composition(foe.armies);
    if (foeComp.total <= 0) return 0;
    var defCat = dominantCat(side.armies);

    var raw = 0;
    for (var a = 0; a < side.armies.length; a++) {
      var army = side.armies[a];
      var us = unitsAlive(army);
      var moraleMul = 0.6 + 0.4 * clamp(IA.state.armyStrength(army).ratio, 0, 1);
      // Men who have not been fed or resupplied do not press an attack home.
      if (army.supplied === false) moraleMul *= IA.economy.UNSUPPLIED_ATTACK;
      for (var u = 0; u < us.length; u++) {
        var g = us[u];
        var t = UnitData.BY_ID[g.typeId];
        if (opts.rangedOnly && !t.range) continue;
        if (opts.meleeOnly && t.range > 0 && t.cat !== 'sea') continue;
        var per = 0;
        for (var cat in foeComp.frac) per += foeComp.frac[cat] * (t.atk[cat] || 0);
        raw += per * (g.hp / t.hp) * moraleMul * (1 + techAtkBonus(nation, t));
      }
    }
    if (raw <= 0) return 0;

    var terrain = prov.isSea ? null : TERRAIN[prov.terrain];
    var attackMul = 1;
    if (opts.assaultingCity && !prov.isSea) {
      attackMul *= 1 + IA.economy.techBonus(nation, 'cityAtk');
    }
    raw *= DAMAGE_SCALE * hours * attackMul * rng.range(0.85, 1.15);
    raw *= ammoFactor(state, nation, side.armies, hours);
    if (opts.damageMul) raw *= opts.damageMul;

    // Spread damage across the defending stacks in proportion to their size,
    // softened by each group's defence against the attacker's dominant class.
    var foeNation = state.nationById[foe.ownerId];
    var terrainDef = terrain ? terrain.def : 1.0;
    var bunker = prov.isSea ? 0 : IA.economy.buildingEffect(prov, 'fort', 'defence');
    var dealt = 0;
    for (var f = 0; f < foe.armies.length; f++) {
      var farmy = foe.armies[f];
      var fus = unitsAlive(farmy);
      var entrench = farmy.entrench || 0;
      for (var v = 0; v < fus.length; v++) {
        var fg = fus[v];
        var ft = UnitData.BY_ID[fg.typeId];
        var share = fg.hp / foeComp.total;
        var defVal = (ft.def[defCat] || 1);
        defVal *= (ft.domain === 'land' && !prov.isSea) ? terrainDef : 1;
        defVal *= 1 + entrench * 0.45 + bunker;
        if (foeNation) defVal *= 1 + techDefBonus(foeNation, ft);
        var dmg = raw * share * (DEF_K / (DEF_K + defVal));
        fg.hp -= dmg;
        dealt += dmg;
      }
    }
    return dealt;
  }

  /** Drop dead groups and re-derive battalion counts from remaining hit points. */
  function reconcile(state) {
    var removed = false;
    for (var i = state.armies.length - 1; i >= 0; i--) {
      var army = state.armies[i];
      var kept = [];
      for (var j = 0; j < army.units.length; j++) {
        var g = army.units[j];
        var t = UnitData.BY_ID[g.typeId];
        if (g.hp <= 0.001) continue;
        g.hp = Math.min(g.hp, t.hp * g.count);
        g.count = Math.max(1, Math.ceil(g.hp / t.hp - 1e-9));
        kept.push(g);
      }
      army.units = kept;
      if (kept.length === 0) { state.armies.splice(i, 1); removed = true; }
    }
    if (removed) IA.state.touchArmies(state);
  }

  function groupByOwner(armies) {
    var map = {};
    for (var i = 0; i < armies.length; i++) {
      var a = armies[i];
      if (!map[a.ownerId]) map[a.ownerId] = { ownerId: a.ownerId, armies: [] };
      map[a.ownerId].armies.push(a);
    }
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function sideStrength(side) {
    var s = 0;
    for (var i = 0; i < side.armies.length; i++) s += IA.state.armyStrength(side.armies[i]).hp;
    return s;
  }

  /** Ranged units with a standing bombard order shell a nearby province. */
  function tickBombardment(state, rng, hours) {
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      if (!army.order || army.order.type !== 'bombard') continue;
      if (army.path.length) continue;
      var target = state.provinces[army.order.target];
      if (!target) { army.order = null; continue; }
      var reach = maxRange(state, army);
      if (reach <= 0 || provinceDistance(state, army.provinceId, target.id, reach) > reach) {
        army.order = null;
        continue;
      }
      var present = IA.state.allArmiesAt(state, target.id).filter(function (o) {
        return IA.state.isHostile(state, army.ownerId, o.ownerId);
      });
      if (!present.length) {
        // Nothing to shoot at; shelling an enemy-held province hurts its morale.
        if (target.nationId && IA.state.isHostile(state, army.ownerId, target.nationId)) {
          target.unrest = Math.min(45, (target.unrest || 0) + 0.6 * hours);
        }
        continue;
      }
      var attacker = { ownerId: army.ownerId, armies: [army] };
      var defender = groupByOwner(present)[0];
      army.inCombat = true;
      fire(state, rng, attacker, defender, target, hours, { rangedOnly: true, damageMul: 0.85 });
    }
  }

  function maxRange(state, army) {
    var nation = state.nationById[army.ownerId];
    var best = 0;
    for (var i = 0; i < army.units.length; i++) {
      var t = UnitData.BY_ID[army.units[i].typeId];
      var r = t.range || 0;
      if (t.range > 0 && nation) r += IA.economy.techBonus(nation, 'artRange');
      if (r > best) best = r;
    }
    return best;
  }

  /** Breadth-first province distance, capped so it stays cheap. */
  function provinceDistance(state, fromId, toId, cap) {
    if (fromId === toId) return 0;
    var seen = {}; seen[fromId] = 0;
    var queue = [fromId], head = 0;
    while (head < queue.length) {
      var id = queue[head++];
      var d = seen[id];
      if (d >= cap) continue;
      var nb = state.provinces[id].neighbors;
      for (var i = 0; i < nb.length; i++) {
        if (seen[nb[i]] !== undefined) continue;
        seen[nb[i]] = d + 1;
        if (nb[i] === toId) return d + 1;
        queue.push(nb[i]);
      }
    }
    return Infinity;
  }

  /** Stacks sharing a province and at war with each other fight. */
  function tickBattles(state, rng, hours) {
    var byProv = {};
    for (var i = 0; i < state.armies.length; i++) {
      var a = state.armies[i];
      (byProv[a.provinceId] || (byProv[a.provinceId] = [])).push(a);
    }
    for (var pid in byProv) {
      var prov = state.provinces[pid];
      var sides = groupByOwner(byProv[pid]);
      if (sides.length < 2) continue;
      // Only sides actually at war with one another engage.
      var engaged = [];
      for (var s = 0; s < sides.length; s++) {
        for (var t = 0; t < sides.length; t++) {
          if (s === t) continue;
          if (IA.state.isHostile(state, sides[s].ownerId, sides[t].ownerId)) { engaged.push(sides[s]); break; }
        }
      }
      if (engaged.length < 2) continue;

      var snapshot = [];
      for (var e = 0; e < engaged.length; e++) {
        snapshot.push({ side: engaged[e], strength: sideStrength(engaged[e]) });
        for (var m = 0; m < engaged[e].armies.length; m++) engaged[e].armies[m].inCombat = true;
      }
      // Each side concentrates on its strongest hostile opponent.
      for (var x = 0; x < engaged.length; x++) {
        var me = engaged[x], target = null, best = -1;
        for (var y = 0; y < engaged.length; y++) {
          if (x === y) continue;
          if (!IA.state.isHostile(state, me.ownerId, engaged[y].ownerId)) continue;
          var st = snapshot[y].strength;
          if (st > best) { best = st; target = engaged[y]; }
        }
        if (!target) continue;
        var assaulting = !prov.isSea && prov.nationId === target.ownerId && prov.cityLevel >= 4;
        fire(state, rng, me, target, prov, hours, { assaultingCity: assaulting });
      }
      if (!state.battleProvinces) state.battleProvinces = {};
      state.battleProvinces[pid] = state.time;
    }
  }

  /** Withdraw shattered stacks to safety instead of letting them evaporate. */
  function tickRetreats(state) {
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      if (!army.inCombat || army.path.length) continue;
      var st = IA.state.armyStrength(army);
      if (st.ratio > RETREAT_RATIO) continue;
      var prov = state.provinces[army.provinceId];
      var best = null;
      for (var n = 0; n < prov.neighbors.length; n++) {
        var np = state.provinces[prov.neighbors[n]];
        if (!IA.orders.canEnter(state, army, np)) continue;
        var hostile = IA.state.allArmiesAt(state, np.id).some(function (o) {
          return IA.state.isHostile(state, army.ownerId, o.ownerId);
        });
        if (hostile) continue;
        var score = (np.nationId === army.ownerId ? 3 : np.nationId ? 0 : 1);
        if (!best || score > best.score) best = { prov: np, score: score };
      }
      if (best) {
        IA.orders.issueMove(state, army, best.prov.id, { retreat: true });
        var nation = state.nationById[army.ownerId];
        if (nation && nation.isPlayer) {
          IA.state.pushLog(state, 'combat', army.name + ' has been forced to withdraw to ' + best.prov.name + '.',
            { provinceId: best.prov.id, armyId: army.id });
        }
      }
    }
  }

  /**
   * Armies standing on hostile or neutral ground wear down its resistance.
   * When the timer runs out the province changes hands.
   */
  function tickOccupation(state, hours) {
    var byProv = {};
    var i;
    for (i = 0; i < state.armies.length; i++) {
      var a = state.armies[i];
      if (a.path.length) continue;
      (byProv[a.provinceId] || (byProv[a.provinceId] = [])).push(a);
    }
    for (i = 0; i < state.landCount; i++) {
      var prov = state.provinces[i];
      if (prov.size === 0) continue;
      var here = byProv[i] || [];
      if (!here.length) { prov.capture = null; continue; }

      // A single owner can hold the ground; anyone else is a claimant.
      var owners = {};
      for (var h = 0; h < here.length; h++) owners[here[h].ownerId] = true;
      var ownerIds = Object.keys(owners);

      var defenderPresent = prov.nationId && owners[prov.nationId];
      var claimants = ownerIds.filter(function (id) {
        if (id === prov.nationId) return false;
        if (!prov.nationId) return true;                        // neutral ground
        return IA.state.atWar(state, id, prov.nationId);
      }).filter(function (id) {
        // Land claims need boots on the ground.
        for (var k = 0; k < here.length; k++) {
          if (here[k].ownerId !== id) continue;
          for (var u = 0; u < here[k].units.length; u++) {
            var ty = UnitData.BY_ID[here[k].units[u].typeId];
            if (ty.domain === 'land') return true;
          }
        }
        return false;
      });

      if (defenderPresent || claimants.length !== 1) { prov.capture = null; continue; }
      var claimer = claimants[0];
      if (!prov.capture || prov.capture.by !== claimer) {
        prov.capture = { by: claimer, progress: 0, needed: captureHours(prov) };
      }
      prov.capture.progress += hours;
      if (prov.capture.progress >= prov.capture.needed) {
        transferProvince(state, prov, claimer);
        prov.capture = null;
      }
    }
  }

  function captureHours(prov) {
    if (!prov.nationId) return 5 + prov.cityLevel * 1.5;           // neutral falls fast
    return 10 + prov.cityLevel * 3 + (prov.morale / 100) * 10;
  }

  function transferProvince(state, prov, newOwnerId) {
    var oldOwnerId = prov.nationId;
    if (oldOwnerId) {
      var old = state.nationById[oldOwnerId];
      if (old) {
        var idx = old.provinces.indexOf(prov.id);
        if (idx >= 0) old.provinces.splice(idx, 1);
      }
    }
    prov.nationId = newOwnerId;
    prov.isCapital = false;
    prov.morale = Math.max(12, prov.morale * 0.45);
    prov.unrest = Math.min(45, (prov.unrest || 0) + 22);
    prov.construction = null;
    prov.queue = [];
    var nn = state.nationById[newOwnerId];
    if (nn) nn.provinces.push(prov.id);
    // Tell the renderer to repaint just this corner of the cached map.
    (state.dirtyProvinces || (state.dirtyProvinces = [])).push(prov.id);
    // Both sides' supply changed the moment the ground did.
    IA.economy.refreshSupply(state, oldOwnerId ? [oldOwnerId, newOwnerId] : [newOwnerId]);

    var oldName = oldOwnerId && state.nationById[oldOwnerId] ? state.nationById[oldOwnerId].name : 'neutral forces';
    var newName = nn ? nn.name : 'unknown';
    var relevant = (state.playerId === newOwnerId || state.playerId === oldOwnerId);
    IA.state.pushLog(state, relevant ? 'capture' : 'world',
      newName + ' has taken ' + prov.name + (oldOwnerId ? ' from ' + oldName : ' (unclaimed)') + '.',
      { provinceId: prov.id });

    if (oldOwnerId) checkElimination(state, oldOwnerId);
  }

  function checkElimination(state, nationId) {
    var nation = state.nationById[nationId];
    if (!nation || !nation.alive) return;
    if (nation.provinces.length > 0) return;
    nation.alive = false;
    nation.defeatedAt = state.time;
    // Surviving forces disband.
    for (var i = state.armies.length - 1; i >= 0; i--) {
      if (state.armies[i].ownerId === nationId) state.armies.splice(i, 1);
    }
    IA.state.touchArmies(state);
    for (var j = 0; j < state.nations.length; j++) {
      delete state.nations[j].treaties[nationId];
    }
    IA.state.pushLog(state, 'world', nation.name + ' has been eliminated.', { nationId: nationId });
  }

  /** Aircraft loitering far from an airbase run out of oil and fall apart. */
  function tickAirAttrition(state, hours) {
    for (var i = 0; i < state.armies.length; i++) {
      var army = state.armies[i];
      var hasAir = false;
      for (var u = 0; u < army.units.length; u++) {
        var t = UnitData.BY_ID[army.units[u].typeId];
        if (t.domain === 'air' || t.cat === 'air') { hasAir = true; break; }
      }
      if (!hasAir) continue;
      var prov = state.provinces[army.provinceId];
      var based = !prov.isSea && prov.nationId === army.ownerId &&
        IA.economy.buildingLevel(prov, 'airfield') > 0;
      var carrier = false;
      if (prov.isSea) {
        var sea = IA.state.allArmiesAt(state, prov.id);
        for (var s = 0; s < sea.length; s++) {
          if (sea[s].ownerId !== army.ownerId) continue;
          for (var v = 0; v < sea[s].units.length; v++) {
            if (sea[s].units[v].typeId === 'carrier') { carrier = true; break; }
          }
        }
      }
      if (based || carrier) { army.airHours = 0; continue; }
      army.airHours = (army.airHours || 0) + hours;
      if (army.airHours > 20) {
        for (var w = 0; w < army.units.length; w++) {
          var g = army.units[w];
          var ty = UnitData.BY_ID[g.typeId];
          if (ty.domain !== 'air' && ty.cat !== 'air') continue;
          g.hp -= ty.hp * 0.05 * hours;
        }
      }
    }
  }

  function tick(state, rng, hours) {
    for (var i = 0; i < state.armies.length; i++) state.armies[i].inCombat = false;
    tickBombardment(state, rng, hours);
    tickBattles(state, rng, hours);
    reconcile(state);
    tickRetreats(state);
    tickOccupation(state, hours);
    tickAirAttrition(state, hours);
    reconcile(state);
  }

  IA.combat = {
    tick: tick, transferProvince: transferProvince, checkElimination: checkElimination,
    provinceDistance: provinceDistance, maxRange: maxRange,
    captureHours: captureHours, reconcile: reconcile, composition: composition,
    dominantCat: dominantCat
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
