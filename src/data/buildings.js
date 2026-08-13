/*
 * Province construction.
 *
 * Each building has levels with their own cost and build time; `effect(level)`
 * returns the modifiers the economy, combat and supply systems read.
 *
 * The Great War was won behind the lines as much as in front of them, so the
 * industrial buildings are as consequential as the forts: a railway is worth
 * more than a bunker in most provinces, and an arms works decides whether your
 * guns can fire at all.
 */
(function (global) {
  'use strict';

  function scaleCost(base, level, factor) {
    var out = {};
    var mult = Math.pow(factor, level - 1);
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) {
      out[k] = Math.round(base[k] * mult);
    }
    return out;
  }

  var BUILDINGS = [
    {
      id: 'barracks', name: 'Barracks', icon: '⛊', maxLevel: 3,
      baseCost: { timber: 220, iron: 160, money: 2200 }, costFactor: 2.1, baseTime: 12, timeFactor: 1.9,
      desc: 'Raises and trains infantry and horse. Higher levels unlock the specialist formations.',
      effect: function (l) { return { manpower: 0.55 * l }; }
    },
    {
      id: 'workshop', name: 'Workshop', icon: '⚒', maxLevel: 3,
      baseCost: { timber: 180, iron: 340, coal: 120, money: 3400 }, costFactor: 2.1, baseTime: 18, timeFactor: 1.9,
      desc: 'Turns coal and iron into shells, and unlocks guns, machine guns and armoured cars.',
      effect: function (l) { return { shells: 5.5 * l }; }
    },
    {
      id: 'factory', name: 'Munitions Factory', icon: '\u{1F3ED}', maxLevel: 5,
      baseCost: { timber: 260, iron: 620, coal: 260, money: 6000 }, costFactor: 1.9, baseTime: 26, timeFactor: 1.75,
      desc: 'Heavy industry. Lifts every deposit in the province, and unlocks siege guns and armour.',
      effect: function (l) { return { deposit: 0.28 * l, shells: 3.0 * l, morale: -0.5 * l }; }
    },
    {
      id: 'railway', name: 'Railway Yard', icon: '⛭', maxLevel: 4,
      baseCost: { timber: 300, iron: 480, coal: 200, money: 4200 }, costFactor: 1.85, baseTime: 22, timeFactor: 1.7,
      desc: 'Moves men, guns and grain. Raises output and extends the reach of your supply.',
      effect: function (l) { return { deposit: 0.14 * l, supply: 0.9 * l, money: 0.10 * l }; }
    },
    {
      id: 'fort', name: 'Fortifications', icon: '\u{1F6E1}', maxLevel: 5,
      baseCost: { timber: 200, iron: 420, coal: 100, money: 3000 }, costFactor: 1.95, baseTime: 16, timeFactor: 1.8,
      desc: 'Trenches, wire and concrete. Every level makes the garrison harder to dislodge.',
      effect: function (l) { return { defence: 0.16 * l, morale: 0.4 * l }; }
    },
    {
      id: 'harbour', name: 'Naval Harbour', icon: '⚓', maxLevel: 3, coastalOnly: true,
      baseCost: { timber: 420, iron: 700, coal: 240, money: 7000 }, costFactor: 2.0, baseTime: 28, timeFactor: 1.8,
      desc: 'Builds and repairs warships and transports. Coastal provinces only.',
      effect: function (l) { return { navalRepair: 0.05 * l, supply: 0.5 * l }; }
    },
    {
      id: 'airfield', name: 'Aerodrome', icon: '✈', maxLevel: 3,
      baseCost: { timber: 340, iron: 260, oil: 180, money: 4600 }, costFactor: 2.0, baseTime: 20, timeFactor: 1.8,
      desc: 'Flies, fuels and repairs aircraft. Machines caught away from one run out of fuel.',
      effect: function (l) { return { airRepair: 0.05 * l }; }
    },
    {
      id: 'warehouse', name: 'Supply Depot', icon: '\u{1F4E6}', maxLevel: 3,
      baseCost: { timber: 360, iron: 180, money: 2600 }, costFactor: 1.85, baseTime: 14, timeFactor: 1.7,
      desc: 'Forward stores that keep an army in the field far from its capital.',
      effect: function (l) { return { supply: 1.4 * l, repair: 0.18 * l }; }
    },
    {
      id: 'admin', name: 'Governor’s Office', icon: '\u{1F3DB}', maxLevel: 3,
      baseCost: { timber: 160, iron: 140, money: 3200 }, costFactor: 1.9, baseTime: 14, timeFactor: 1.7,
      desc: 'Civil administration and the recruiting posters that go with it. Raises morale and revenue.',
      effect: function (l) { return { morale: 3.0 * l, moraleSpread: 0.8 * l, money: 0.18 * l }; }
    }
  ];

  var BY_ID = {};
  for (var i = 0; i < BUILDINGS.length; i++) BY_ID[BUILDINGS[i].id] = BUILDINGS[i];

  function costFor(buildingId, level) {
    var b = BY_ID[buildingId];
    return scaleCost(b.baseCost, level, b.costFactor);
  }

  function timeFor(buildingId, level) {
    var b = BY_ID[buildingId];
    return Math.round(b.baseTime * Math.pow(b.timeFactor, level - 1));
  }

  global.IA = global.IA || {};
  global.IA.BuildingData = { BUILDINGS: BUILDINGS, BY_ID: BY_ID, costFor: costFor, timeFor: timeFor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
