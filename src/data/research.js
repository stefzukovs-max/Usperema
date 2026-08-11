/*
 * Research tree.  Techs unlock units, buildings and flat combat bonuses.
 * `days` is game days at 1x; `req` lists prerequisite tech ids.
 */
(function (global) {
  'use strict';

  var TECHS = [
    // --- Doctrine (economy / general) -------------------------------------
    { id: 'logistics', name: 'Field Logistics', branch: 'doctrine', days: 0.6, cost: { cash: 3000, materials: 200 }, req: [], bonus: { speed: 0.10 }, desc: 'All ground formations move 10% faster.' },
    { id: 'conscription', name: 'Conscription', branch: 'doctrine', days: 0.8, cost: { cash: 5000, food: 400 }, req: [], bonus: { manpower: 0.20 }, desc: '+20% manpower income.' },
    { id: 'war_economy', name: 'War Economy', branch: 'doctrine', days: 1.4, cost: { cash: 12000, materials: 800 }, req: ['conscription'], bonus: { production: 0.15 }, desc: '+15% output from every deposit.' },
    { id: 'total_mobilisation', name: 'Total Mobilisation', branch: 'doctrine', days: 2.4, cost: { cash: 28000, materials: 1800, chemicals: 400 }, req: ['war_economy'], bonus: { manpower: 0.25, buildSpeed: 0.20 }, desc: '+25% manpower, units build 20% faster.' },
    { id: 'field_hospitals', name: 'Field Hospitals', branch: 'doctrine', days: 1.2, cost: { cash: 9000, food: 700 }, req: ['logistics'], bonus: { repair: 0.5 }, desc: 'Units in friendly territory repair 50% faster.' },

    // --- Infantry ---------------------------------------------------------
    { id: 'small_arms', name: 'Modern Small Arms', branch: 'infantry', days: 0.7, cost: { cash: 4000, materials: 250 }, req: [], bonus: { infAtk: 0.15 }, desc: 'Infantry attack +15%.' },
    { id: 'mech_inf', name: 'Mechanisation', branch: 'infantry', days: 1.3, cost: { cash: 11000, materials: 700, fuel: 300 }, req: ['small_arms'], unlocks: ['mech_inf'], desc: 'Unlocks Mechanised Infantry.' },
    { id: 'body_armour', name: 'Composite Body Armour', branch: 'infantry', days: 1.8, cost: { cash: 16000, materials: 900, chemicals: 300 }, req: ['small_arms'], bonus: { infDef: 0.20 }, desc: 'Infantry defence +20%.' },
    { id: 'urban_warfare', name: 'Urban Warfare', branch: 'infantry', days: 2.2, cost: { cash: 22000, materials: 1200 }, req: ['body_armour'], bonus: { cityAtk: 0.25 }, desc: '+25% attack when assaulting cities.' },

    // --- Armour -----------------------------------------------------------
    { id: 'armour', name: 'Armoured Warfare', branch: 'armour', days: 1.1, cost: { cash: 9000, materials: 600, fuel: 250 }, req: [], unlocks: ['light_tank'], desc: 'Unlocks Light Tanks.' },
    { id: 'artillery', name: 'Tube Artillery', branch: 'armour', days: 1.0, cost: { cash: 8000, materials: 550, chemicals: 200 }, req: [], unlocks: ['artillery'], desc: 'Unlocks Artillery.' },
    { id: 'mbt', name: 'Main Battle Tank', branch: 'armour', days: 2.6, cost: { cash: 30000, materials: 2000, fuel: 900, chemicals: 400 }, req: ['armour'], unlocks: ['mbt'], desc: 'Unlocks Main Battle Tanks.' },
    { id: 'reactive_armour', name: 'Reactive Armour', branch: 'armour', days: 2.4, cost: { cash: 26000, materials: 1600, chemicals: 600 }, req: ['armour'], bonus: { armDef: 0.25 }, desc: 'Armour defence +25%.' },
    { id: 'guided_shells', name: 'Guided Shells', branch: 'armour', days: 2.0, cost: { cash: 20000, materials: 1100, chemicals: 500 }, req: ['artillery'], bonus: { artRange: 1, artAtk: 0.20 }, desc: 'Artillery range +1 province, attack +20%.' },

    // --- Air --------------------------------------------------------------
    { id: 'air_defence', name: 'Air Defence Network', branch: 'air', days: 1.0, cost: { cash: 8500, materials: 500, chemicals: 250 }, req: [], unlocks: ['sam'], desc: 'Unlocks SAM Batteries.' },
    { id: 'rotary_wing', name: 'Rotary Wing Assault', branch: 'air', days: 1.6, cost: { cash: 15000, materials: 800, fuel: 500 }, req: [], unlocks: ['helicopter'], desc: 'Unlocks Attack Helicopters.' },
    { id: 'jet_engine', name: 'Jet Propulsion', branch: 'air', days: 2.2, cost: { cash: 24000, materials: 1300, fuel: 800, chemicals: 400 }, req: ['rotary_wing'], unlocks: ['fighter'], desc: 'Unlocks Fighter Jets.' },
    { id: 'strategic_bombing', name: 'Strategic Bombing', branch: 'air', days: 3.0, cost: { cash: 40000, materials: 2400, fuel: 1400, chemicals: 700 }, req: ['jet_engine'], unlocks: ['bomber'], desc: 'Unlocks Strategic Bombers.' },
    { id: 'stealth', name: 'Low Observability', branch: 'air', days: 3.4, cost: { cash: 52000, materials: 2600, chemicals: 1400 }, req: ['jet_engine'], bonus: { airDef: 0.30 }, desc: 'Aircraft defence +30%.' },

    // --- Naval ------------------------------------------------------------
    { id: 'naval_doctrine', name: 'Blue Water Doctrine', branch: 'naval', days: 1.4, cost: { cash: 13000, materials: 900, fuel: 400 }, req: [], unlocks: ['destroyer'], desc: 'Unlocks Destroyers.' },
    { id: 'submarine_warfare', name: 'Submarine Warfare', branch: 'naval', days: 2.2, cost: { cash: 24000, materials: 1400, chemicals: 400 }, req: ['naval_doctrine'], unlocks: ['submarine'], desc: 'Unlocks Submarines.' },
    { id: 'carrier_ops', name: 'Carrier Operations', branch: 'naval', days: 3.6, cost: { cash: 58000, materials: 3600, fuel: 1800 }, req: ['submarine_warfare'], unlocks: ['carrier'], desc: 'Unlocks Aircraft Carriers.' },
    { id: 'amphibious', name: 'Amphibious Doctrine', branch: 'naval', days: 1.8, cost: { cash: 17000, materials: 1000, fuel: 600 }, req: ['naval_doctrine'], bonus: { seaSpeed: 0.35 }, desc: 'Transported armies cross water 35% faster.' },

    // --- Strategic --------------------------------------------------------
    { id: 'rocketry', name: 'Rocketry', branch: 'strategic', days: 3.2, cost: { cash: 46000, materials: 2400, fuel: 1200, chemicals: 1600 }, req: ['guided_shells'], unlocks: ['ballistic_missile'], desc: 'Unlocks Ballistic Missiles.' },
    { id: 'satellites', name: 'Satellite Reconnaissance', branch: 'strategic', days: 3.0, cost: { cash: 44000, materials: 2000, chemicals: 1200 }, req: ['jet_engine'], bonus: { vision: 1 }, desc: 'Reveals enemy stacks one province further out.' }
  ];

  var BY_ID = {};
  for (var i = 0; i < TECHS.length; i++) BY_ID[TECHS[i].id] = TECHS[i];

  var BRANCHES = [
    { id: 'doctrine', name: 'Doctrine', icon: '\u{1F4DC}' },
    { id: 'infantry', name: 'Infantry', icon: '⛑' },
    { id: 'armour', name: 'Armour', icon: '■' },
    { id: 'air', name: 'Air Force', icon: '✈' },
    { id: 'naval', name: 'Navy', icon: '⚓' },
    { id: 'strategic', name: 'Strategic', icon: '☢' }
  ];

  global.SWW = global.SWW || {};
  global.SWW.ResearchData = { TECHS: TECHS, BY_ID: BY_ID, BRANCHES: BRANCHES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
