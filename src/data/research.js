/*
 * The technology of the Great War.
 *
 * `days` is game days of research at 1x; `req` lists prerequisite tech ids;
 * `unlocks` names unit ids the tech makes buildable; `bonus` grants flat
 * modifiers the economy and combat systems read.
 *
 * The tree follows the war's own arc: everyone starts able to raise infantry
 * and dig in, and the branches that break a stalemate — infiltration, siege
 * guns, landships, aviation — are deliberately expensive and late.
 */
(function (global) {
  'use strict';

  var TECHS = [
    // --- Infantry doctrine -------------------------------------------------
    { id: 'machine_guns', name: 'Massed Fire Doctrine', branch: 'infantry', days: 0.6, cost: { money: 3200, iron: 220 }, req: [], unlocks: ['machine_gun'], desc: 'Unlocks Heavy Weapons Companies.' },
    { id: 'defence_in_depth', name: 'Defence in Depth', branch: 'infantry', days: 1.3, cost: { money: 9000, iron: 500, timber: 300 }, req: ['machine_guns'], unlocks: ['guard_infantry'], bonus: { infDef: 0.12 }, desc: 'Unlocks Marine Infantry and stiffens all infantry defence by 12%.' },
    { id: 'infiltration', name: 'Infiltration Tactics', branch: 'infantry', days: 2.2, cost: { money: 20000, iron: 900, shells: 400 }, req: ['defence_in_depth'], unlocks: ['assault_infantry'], desc: 'Unlocks Air Assault Infantry — troops put down behind a strongpoint, not sent at it.' },
    { id: 'creeping_barrage', name: 'Combined Arms', branch: 'infantry', days: 2.6, cost: { money: 26000, shells: 900 }, req: ['infiltration'], bonus: { infAtk: 0.22 }, desc: 'Infantry advance with the guns and the air working to their timetable: attack +22%.' },

    // --- Artillery ---------------------------------------------------------
    { id: 'quick_firing_guns', name: 'Self-Propelled Guns', branch: 'artillery', days: 0.8, cost: { money: 5000, iron: 400, coal: 150 }, req: [], unlocks: ['field_artillery'], desc: 'Unlocks Field Artillery.' },
    { id: 'siege_guns', name: 'Rocket Artillery', branch: 'artillery', days: 2.0, cost: { money: 18000, iron: 1400, coal: 600 }, req: ['quick_firing_guns'], unlocks: ['heavy_artillery'], desc: 'Unlocks Rocket Artillery, the only reliable answer to a fortified province.' },
    { id: 'counter_battery', name: 'Counter-Battery Fire', branch: 'artillery', days: 1.8, cost: { money: 15000, shells: 500 }, req: ['quick_firing_guns'], bonus: { artRange: 1 }, desc: 'Counter-battery radar and drone spotting: all guns reach one province further.' },
    { id: 'shell_standardisation', name: 'Precision Munitions', branch: 'artillery', days: 1.5, cost: { money: 12000, iron: 800 }, req: ['quick_firing_guns'], bonus: { artAtk: 0.18 }, desc: 'Guided rounds instead of area fire: artillery attack +18%.' },

    // --- Armour ------------------------------------------------------------
    { id: 'motorisation', name: 'Motorisation', branch: 'armour', days: 1.0, cost: { money: 7000, iron: 500, oil: 250 }, req: [], unlocks: ['armoured_car'], bonus: { speed: 0.08 }, desc: 'Unlocks Infantry Fighting Vehicles; everything on land moves 8% faster.' },
    { id: 'landships', name: 'Main Battle Tanks', branch: 'armour', days: 2.8, cost: { money: 30000, iron: 2200, oil: 900, coal: 500 }, req: ['motorisation'], unlocks: ['tank'], desc: 'Unlocks the Main Battle Tank — armour that goes through a prepared position.' },
    { id: 'armour_plate', name: 'Composite Armour', branch: 'armour', days: 2.4, cost: { money: 24000, iron: 1800 }, req: ['landships'], bonus: { armDef: 0.25 }, desc: 'Armour defence +25%.' },

    // --- Air ---------------------------------------------------------------
    { id: 'aviation', name: 'Unmanned Aviation', branch: 'air', days: 1.0, cost: { money: 7500, timber: 400, oil: 300 }, req: [], unlocks: ['recon_plane'], bonus: { vision: 1 }, desc: 'Unlocks Reconnaissance Drones and reveals enemy forces a province further out.' },
    { id: 'interceptors', name: 'Air Combat Doctrine', branch: 'air', days: 1.8, cost: { money: 16000, timber: 500, iron: 600, oil: 500 }, req: ['aviation'], unlocks: ['fighter'], desc: 'Unlocks Air Superiority Fighters, and the sky over your own army.' },
    { id: 'strategic_bombing', name: 'Strategic Bombing', branch: 'air', days: 2.9, cost: { money: 34000, timber: 900, iron: 1600, oil: 1200 }, req: ['interceptors'], unlocks: ['bomber'], desc: 'Unlocks Strike Bombers, and a front line that has no rear.' },
    { id: 'air_superiority', name: 'Air Superiority Doctrine', branch: 'air', days: 2.6, cost: { money: 28000, oil: 900 }, req: ['interceptors'], bonus: { airDef: 0.25 }, desc: 'Aircraft defence +25%.' },

    // --- Naval -------------------------------------------------------------
    { id: 'naval_gunnery', name: 'Naval Gunnery', branch: 'naval', days: 1.2, cost: { money: 10000, iron: 800, coal: 400 }, req: [], unlocks: ['destroyer', 'cruiser'], desc: 'Unlocks Destroyers and Guided Missile Cruisers.' },
    { id: 'submarine_warfare', name: 'Submarine Warfare', branch: 'naval', days: 2.0, cost: { money: 20000, iron: 1200, oil: 600 }, req: ['naval_gunnery'], unlocks: ['submarine'], desc: 'Unlocks Attack Submarines, and a war on shipping fought from under it.' },
    { id: 'dreadnoughts', name: 'Carrier Aviation', branch: 'naval', days: 3.4, cost: { money: 48000, iron: 3600, coal: 1800 }, req: ['naval_gunnery'], unlocks: ['dreadnought'], desc: 'Unlocks the Aircraft Carrier, and an arms race with it.' },
    { id: 'convoy_doctrine', name: 'Convoy Doctrine', branch: 'naval', days: 1.9, cost: { money: 16000, coal: 700 }, req: ['naval_gunnery'], bonus: { seaSpeed: 0.35 }, desc: 'Transported armies cross water 35% faster and travel escorted.' },

    // --- Industry ----------------------------------------------------------
    { id: 'war_economy', name: 'War Economy', branch: 'industry', days: 1.2, cost: { money: 9000, coal: 400 }, req: [], bonus: { production: 0.15 }, desc: 'Every deposit yields 15% more.' },
    { id: 'assembly_lines', name: 'Assembly Lines', branch: 'industry', days: 2.0, cost: { money: 19000, iron: 1100, coal: 600 }, req: ['war_economy'], bonus: { buildSpeed: 0.22 }, desc: 'Units are built 22% faster.' },
    { id: 'synthetic_chemistry', name: 'Synthetic Chemistry', branch: 'industry', days: 2.6, cost: { money: 26000, coal: 1400 }, req: ['war_economy'], bonus: { production: 0.14, shellYield: 0.25 }, desc: 'Nitrates from air: +14% deposits and +25% shell output.' },

    // --- Logistics ---------------------------------------------------------
    { id: 'rail_logistics', name: 'Rail and Road Logistics', branch: 'logistics', days: 0.9, cost: { money: 6000, iron: 400, timber: 300 }, req: [], bonus: { speed: 0.12, supply: 1.0 }, desc: 'Ground forces move 12% faster and supply reaches further.' },
    { id: 'motor_transport', name: 'Theatre Transport Command', branch: 'logistics', days: 1.9, cost: { money: 17000, oil: 700, iron: 700 }, req: ['rail_logistics'], bonus: { supply: 1.5, repair: 0.35 }, desc: 'Heavy lift extends supply again and speeds repair in the field.' },
    { id: 'field_hospitals', name: 'Field Hospitals', branch: 'logistics', days: 1.4, cost: { money: 11000, grain: 700 }, req: ['rail_logistics'], bonus: { repair: 0.5 }, desc: 'Units in friendly territory recover 50% faster.' },

    // --- Home front --------------------------------------------------------
    { id: 'conscription', name: 'National Service Act', branch: 'homefront', days: 0.8, cost: { money: 5000, grain: 400 }, req: [], bonus: { manpower: 0.22 }, desc: '+22% manpower income.' },
    { id: 'total_mobilisation', name: 'Total Mobilisation', branch: 'homefront', days: 2.6, cost: { money: 30000, grain: 1500, iron: 1200 }, req: ['conscription'], bonus: { manpower: 0.28, morale: -3 }, desc: '+28% manpower, at a standing cost to morale everywhere.' },
    { id: 'propaganda_bureau', name: 'State Media Bureau', branch: 'homefront', days: 1.5, cost: { money: 13000 }, req: ['conscription'], bonus: { morale: 5 }, desc: 'Raises morale in every province you hold.' }
  ];

  var BY_ID = {};
  for (var i = 0; i < TECHS.length; i++) BY_ID[TECHS[i].id] = TECHS[i];

  var BRANCHES = [
    { id: 'infantry', name: 'Infantry', icon: '♟' },
    { id: 'artillery', name: 'Artillery', icon: '✲' },
    { id: 'armour', name: 'Armour', icon: '■' },
    { id: 'air', name: 'Air Force', icon: '✈' },
    { id: 'naval', name: 'Navy', icon: '⚓' },
    { id: 'industry', name: 'Industry', icon: '\u{1F3ED}' },
    { id: 'logistics', name: 'Logistics', icon: '⛭' },
    { id: 'homefront', name: 'Home Front', icon: '\u{1F3DB}' }
  ];

  global.IA = global.IA || {};
  global.IA.ResearchData = { TECHS: TECHS, BY_ID: BY_ID, BRANCHES: BRANCHES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
