/*
 * Province buildings.  Each has levels with their own cost and build time;
 * `effect(level)` returns the modifiers economy.js reads.
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
      id: 'recruiting', name: 'Recruiting Office', icon: '⛑', maxLevel: 3,
      baseCost: { materials: 300, cash: 2500 }, costFactor: 2.1, baseTime: 12, timeFactor: 1.9,
      desc: 'Raises manpower income and unlocks ground formations.',
      effect: function (l) { return { manpower: 0.55 * l, morale: 0 }; }
    },
    {
      id: 'industry', name: 'Industrial Complex', icon: '\u{1F3ED}', maxLevel: 5,
      baseCost: { materials: 500, cash: 4000 }, costFactor: 1.85, baseTime: 18, timeFactor: 1.7,
      desc: 'Boosts the province deposit output and tax revenue.',
      effect: function (l) { return { deposit: 0.30 * l, cash: 0.22 * l, morale: -0.4 * l }; }
    },
    {
      id: 'arms_factory', name: 'Arms Factory', icon: '⚙', maxLevel: 3,
      baseCost: { materials: 900, chemicals: 200, cash: 7000 }, costFactor: 2.2, baseTime: 26, timeFactor: 1.9,
      desc: 'Produces ammunition from materials and chemicals; unlocks heavy weapons.',
      effect: function (l) { return { ammo: 6.5 * l }; }
    },
    {
      id: 'airbase', name: 'Airbase', icon: '✈', maxLevel: 3,
      baseCost: { materials: 800, fuel: 300, cash: 6500 }, costFactor: 2.0, baseTime: 24, timeFactor: 1.8,
      desc: 'Builds, refuels and repairs aircraft. Aircraft away from one bleed fuel.',
      effect: function (l) { return { airRepair: 0.05 * l }; }
    },
    {
      id: 'naval_base', name: 'Naval Base', icon: '⚓', maxLevel: 3, coastalOnly: true,
      baseCost: { materials: 1000, fuel: 250, cash: 8000 }, costFactor: 2.0, baseTime: 28, timeFactor: 1.8,
      desc: 'Builds and repairs warships. Coastal provinces only.',
      effect: function (l) { return { navalRepair: 0.05 * l }; }
    },
    {
      id: 'bunker', name: 'Bunker Network', icon: '\u{1F6E1}', maxLevel: 3,
      baseCost: { materials: 700, cash: 3500 }, costFactor: 2.0, baseTime: 16, timeFactor: 1.8,
      desc: 'Hardens the garrison against every kind of attack.',
      effect: function (l) { return { defence: 0.18 * l, morale: 0.3 * l }; }
    },
    {
      id: 'propaganda', name: 'Propaganda Office', icon: '\u{1F4E2}', maxLevel: 3,
      baseCost: { materials: 250, cash: 3000 }, costFactor: 1.9, baseTime: 14, timeFactor: 1.7,
      desc: 'Raises morale here and slows unrest in neighbouring provinces.',
      effect: function (l) { return { morale: 3.0 * l, moraleSpread: 0.8 * l }; }
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

  global.SWW = global.SWW || {};
  global.SWW.BuildingData = { BUILDINGS: BUILDINGS, BY_ID: BY_ID, costFor: costFor, timeFor: timeFor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
