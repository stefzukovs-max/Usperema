/*
 * The order of battle.
 *
 * Combat resolves through four target classes: inf (foot, horse and gun), arm
 * (armour), air, sea.  Every unit lists what it can hit (`atk`) and how well it
 * survives being hit by each class (`def`).
 *
 * speed   province-grid cells per game hour (a province is ~6-10 cells wide)
 * hp      hit points per battalion; three infantry battalions field 90 hp
 * range   provinces an attack reaches without entering the target (0 = assault)
 * domain  'land' | 'sea' | 'air' — which provinces it may occupy
 * shells  ammunition burned per hour of combat; the shell crisis was real
 *
 * The shape of the war is in these numbers.  Infantry in the open die to
 * massed fire and artillery; guns cannot take ground; light forces are fast and
 * brittle against a dug-in enemy; armour is slow, expensive and decisive.
 */
(function (global) {
  'use strict';

  var UNITS = [
    // --- Foot ------------------------------------------------------------
    {
      id: 'line_infantry', name: 'Motor Rifle Company', short: 'INF', cat: 'inf', domain: 'land', icon: '♟',
      hp: 30, speed: 0.40, range: 0, view: 12,
      atk: { inf: 4.0, arm: 1.2, air: 0.6, sea: 0.5 },
      def: { inf: 6.0, arm: 4.0, air: 3.0, sea: 3.0 },
      cost: { manpower: 240, grain: 140, iron: 60, money: 800 },
      time: 8, upkeep: { grain: 3, money: 6 }, shells: 1.5,
      req: { building: 'barracks', level: 1 },
      desc: 'The rifle company that holds the ground. Cheap, patient, and still the only thing that truly takes it.'
    },
    {
      id: 'assault_infantry', name: 'Air Assault Infantry', short: 'ASL', cat: 'inf', domain: 'land', icon: '⚔',
      hp: 34, speed: 0.46, range: 0, view: 13,
      atk: { inf: 8.5, arm: 3.0, air: 0.8, sea: 0.6 },
      def: { inf: 7.0, arm: 4.5, air: 3.2, sea: 3.0 },
      cost: { manpower: 300, grain: 170, iron: 140, money: 2100 },
      time: 15, upkeep: { grain: 4, money: 12 }, shells: 3.0,
      req: { building: 'barracks', level: 2, tech: 'infiltration' },
      desc: 'Lifted in behind the strongpoint rather than sent at the front of it. Expensive in men and in helicopters.'
    },
    {
      id: 'guard_infantry', name: 'Marine Infantry', short: 'MAR', cat: 'inf', domain: 'land', icon: '♜',
      hp: 40, speed: 0.36, range: 0, view: 12,
      atk: { inf: 5.5, arm: 2.0, air: 1.0, sea: 0.6 },
      def: { inf: 11.0, arm: 7.0, air: 4.0, sea: 3.5 },
      cost: { manpower: 320, grain: 190, iron: 130, money: 2300 },
      time: 16, upkeep: { grain: 4, money: 13 }, shells: 2.2,
      req: { building: 'barracks', level: 2, tech: 'defence_in_depth' },
      desc: 'The regiments kept for the hardest ground. Slow to move, very hard to shift once they are on it.'
    },
    {
      id: 'machine_gun', name: 'Heavy Weapons Company', short: 'HW', cat: 'inf', domain: 'land', icon: '⁙',
      hp: 24, speed: 0.30, range: 0, view: 11,
      atk: { inf: 7.0, arm: 1.0, air: 2.5, sea: 0.4 },
      def: { inf: 14.0, arm: 3.0, air: 5.0, sea: 2.0 },
      cost: { manpower: 150, grain: 80, iron: 190, money: 1600 },
      time: 12, upkeep: { grain: 2, money: 9 }, shells: 4.0,
      req: { building: 'workshop', level: 1, tech: 'machine_guns' },
      desc: 'Interlocking fire and missiles that make open ground impassable. Nearly useless on the advance.'
    },

    // --- Horse -----------------------------------------------------------
    {
      id: 'cavalry', name: 'Armoured Cavalry', short: 'CAV', cat: 'inf', domain: 'land', icon: '♞',
      hp: 28, speed: 0.85, range: 0, view: 18,
      atk: { inf: 5.5, arm: 1.0, air: 0.4, sea: 0.4 },
      def: { inf: 4.0, arm: 2.5, air: 2.5, sea: 2.0 },
      cost: { manpower: 200, grain: 220, iron: 50, money: 1500 },
      time: 10, upkeep: { grain: 6, money: 10 }, shells: 1.2,
      req: { building: 'barracks', level: 1 },
      desc: 'Fast over open country and lethal against an enemy already broken. Against a prepared position, thin.'
    },
    {
      id: 'scout_cavalry', name: 'Reconnaissance Screen', short: 'RCN', cat: 'inf', domain: 'land', icon: '⚐',
      hp: 20, speed: 1.05, range: 0, view: 30,
      atk: { inf: 2.0, arm: 0.5, air: 0.3, sea: 0.3 },
      def: { inf: 3.0, arm: 2.0, air: 2.0, sea: 1.5 },
      cost: { manpower: 120, grain: 150, money: 900 },
      time: 7, upkeep: { grain: 4, money: 6 }, shells: 0.4,
      req: { building: 'barracks', level: 1 },
      desc: 'Eyes for the army, and the drones that go with them. Sees far, fights badly, should never be caught.'
    },

    // --- Guns ------------------------------------------------------------
    {
      id: 'trench_mortar', name: 'Mortar Battery', short: 'MTR', cat: 'inf', domain: 'land', icon: '↟',
      hp: 20, speed: 0.32, range: 1, view: 9,
      atk: { inf: 8.0, arm: 2.5, air: 0.2, sea: 1.0 },
      def: { inf: 3.0, arm: 2.0, air: 1.5, sea: 1.5 },
      cost: { manpower: 120, iron: 170, coal: 60, money: 1200 },
      time: 10, upkeep: { grain: 2, money: 7 }, shells: 5.0,
      req: { building: 'workshop', level: 1 },
      desc: 'Drops shells onto the next position. Short reach, cheap, and always hungry for ammunition.'
    },
    {
      id: 'field_artillery', name: 'Field Artillery', short: 'ART', cat: 'inf', domain: 'land', icon: '✲',
      hp: 26, speed: 0.30, range: 1, view: 10,
      atk: { inf: 14.0, arm: 7.0, air: 0.4, sea: 4.0 },
      def: { inf: 3.0, arm: 2.0, air: 1.5, sea: 1.5 },
      cost: { manpower: 180, iron: 380, coal: 140, money: 2800 },
      time: 20, upkeep: { grain: 3, money: 16 }, shells: 8.0,
      req: { building: 'workshop', level: 1, tech: 'quick_firing_guns' },
      desc: 'Still the great killer. Shells the neighbouring province, and is helpless once anything reaches it.'
    },
    {
      id: 'heavy_artillery', name: 'Rocket Artillery', short: 'MLRS', cat: 'inf', domain: 'land', icon: '✹',
      hp: 30, speed: 0.20, range: 2, view: 10,
      atk: { inf: 20.0, arm: 12.0, air: 0.3, sea: 8.0 },
      def: { inf: 3.5, arm: 2.5, air: 1.5, sea: 2.0 },
      cost: { manpower: 260, iron: 780, coal: 320, money: 6200 },
      time: 34, upkeep: { grain: 4, money: 34 }, shells: 16.0,
      req: { building: 'factory', level: 1, tech: 'siege_guns' },
      desc: 'Salvoes that flatten a fortified province from two provinces away. Ruinously slow to move and to reload.'
    },

    // --- Armour ----------------------------------------------------------
    {
      id: 'armoured_car', name: 'Infantry Fighting Vehicle', short: 'IFV', cat: 'arm', domain: 'land', icon: '▰',
      hp: 34, speed: 0.80, range: 0, view: 16,
      atk: { inf: 7.0, arm: 4.0, air: 0.8, sea: 0.8 },
      def: { inf: 8.0, arm: 6.0, air: 3.0, sea: 3.0 },
      cost: { manpower: 130, iron: 300, oil: 180, money: 2400 },
      time: 16, upkeep: { grain: 1, oil: 7, money: 15 }, shells: 2.5,
      req: { building: 'workshop', level: 2, tech: 'motorisation' },
      desc: 'Fast on a road and thin where it matters. Good for exploiting a gap, poor for making one.'
    },
    {
      id: 'tank', name: 'Main Battle Tank', short: 'MBT', cat: 'arm', domain: 'land', icon: '■',
      hp: 55, speed: 0.34, range: 0, view: 12,
      atk: { inf: 15.0, arm: 9.0, air: 0.6, sea: 1.2 },
      def: { inf: 16.0, arm: 11.0, air: 4.0, sea: 4.0 },
      cost: { manpower: 200, iron: 820, oil: 380, coal: 200, money: 5600 },
      time: 32, upkeep: { grain: 2, oil: 15, money: 34 }, shells: 5.0,
      req: { building: 'factory', level: 2, tech: 'landships' },
      desc: 'Goes through a prepared position rather than round it. Thirsty, temperamental, and decisive where it arrives.'
    },

    // --- Air -------------------------------------------------------------
    {
      id: 'recon_plane', name: 'Reconnaissance Drone', short: 'UAV', cat: 'air', domain: 'air', icon: '⌁',
      hp: 18, speed: 2.6, range: 0, view: 40,
      atk: { inf: 1.0, arm: 0.5, air: 2.0, sea: 0.8 },
      def: { inf: 5.0, arm: 5.0, air: 4.0, sea: 4.0 },
      cost: { manpower: 60, timber: 180, iron: 120, oil: 160, money: 2200 },
      time: 14, upkeep: { oil: 10, money: 14 }, shells: 0.5,
      req: { building: 'airfield', level: 1, tech: 'aviation' },
      desc: 'Spots the enemy and ranges the guns. Cheap, slow and unarmed; it survives by not being looked at.'
    },
    {
      id: 'fighter', name: 'Air Superiority Fighter', short: 'FTR', cat: 'air', domain: 'air', icon: '➤',
      hp: 22, speed: 3.2, range: 0, view: 26,
      atk: { inf: 3.0, arm: 1.5, air: 14.0, sea: 2.0 },
      def: { inf: 7.0, arm: 7.0, air: 9.0, sea: 5.0 },
      cost: { manpower: 70, timber: 200, iron: 220, oil: 240, money: 3600 },
      time: 20, upkeep: { oil: 16, money: 22 }, shells: 2.0,
      req: { building: 'airfield', level: 2, tech: 'interceptors' },
      desc: 'Clears the sky so everything else can work. Owning the air is most of owning the ground.'
    },
    {
      id: 'bomber', name: 'Strike Bomber', short: 'BMB', cat: 'air', domain: 'air', icon: '✈',
      hp: 30, speed: 2.2, range: 0, view: 22,
      atk: { inf: 14.0, arm: 9.0, air: 1.5, sea: 7.0 },
      def: { inf: 6.0, arm: 6.0, air: 4.0, sea: 5.0 },
      cost: { manpower: 110, timber: 320, iron: 420, oil: 420, money: 6800 },
      time: 30, upkeep: { oil: 26, money: 38 }, shells: 7.0,
      req: { building: 'airfield', level: 3, tech: 'strategic_bombing' },
      desc: 'Carries the war past the front, to rail hubs and factories. Needs a friendly sky to come home from it.'
    },

    // --- Sea -------------------------------------------------------------
    {
      id: 'transport', name: 'Amphibious Transport', short: 'TRP', cat: 'sea', domain: 'sea', icon: '⛴',
      hp: 40, speed: 2.6, range: 0, view: 14,
      atk: { inf: 0.5, arm: 0.5, air: 0.5, sea: 0.8 },
      def: { inf: 4.0, arm: 4.0, air: 4.0, sea: 3.0 },
      cost: { manpower: 140, timber: 300, iron: 320, coal: 180, money: 2600 },
      time: 18, upkeep: { grain: 3, coal: 8, money: 14 }, shells: 0.2,
      req: { building: 'harbour', level: 1 },
      desc: 'Hulls with a well deck and no guns worth the name. The only way an army crosses deep water.'
    },
    {
      id: 'destroyer', name: 'Destroyer', short: 'DD', cat: 'sea', domain: 'sea', icon: '⚓',
      hp: 55, speed: 4.2, range: 1, view: 26,
      atk: { inf: 6.0, arm: 5.0, air: 5.0, sea: 12.0 },
      def: { inf: 9.0, arm: 9.0, air: 8.0, sea: 10.0 },
      cost: { manpower: 220, iron: 700, coal: 400, oil: 120, money: 5400 },
      time: 26, upkeep: { grain: 5, coal: 16, money: 32 }, shells: 5.0,
      req: { building: 'harbour', level: 1, tech: 'naval_gunnery' },
      desc: 'Fast escort and submarine hunter. The screen without which nothing larger dares sail.'
    },
    {
      id: 'submarine', name: 'Attack Submarine', short: 'SSN', cat: 'sea', domain: 'sea', icon: '◢',
      hp: 34, speed: 2.8, range: 0, view: 12,
      atk: { inf: 1.5, arm: 1.5, air: 0.4, sea: 22.0 },
      def: { inf: 4.0, arm: 4.0, air: 11.0, sea: 5.0 },
      cost: { manpower: 160, iron: 620, coal: 220, oil: 260, money: 6000 },
      time: 30, upkeep: { grain: 4, oil: 14, money: 34 }, shells: 4.0,
      req: { building: 'harbour', level: 2, tech: 'submarine_warfare' },
      desc: 'Hunts shipping and capital ships alike. Almost blind, almost invisible, and hated for both.'
    },
    {
      id: 'cruiser', name: 'Guided Missile Cruiser', short: 'CG', cat: 'sea', domain: 'sea', icon: '✦',
      hp: 80, speed: 3.4, range: 1, view: 30,
      atk: { inf: 11.0, arm: 9.0, air: 5.0, sea: 16.0 },
      def: { inf: 13.0, arm: 13.0, air: 9.0, sea: 13.0 },
      cost: { manpower: 420, iron: 1500, coal: 800, oil: 200, money: 12000 },
      time: 44, upkeep: { grain: 9, coal: 30, money: 70 }, shells: 9.0,
      req: { building: 'harbour', level: 2, tech: 'naval_gunnery' },
      desc: 'Guards shipping and threatens it. Fast enough to choose its fights, armed enough to win most of them.'
    },
    {
      id: 'dreadnought', name: 'Aircraft Carrier', short: 'CV', cat: 'sea', domain: 'sea', icon: '⬤',
      hp: 150, speed: 2.6, range: 2, view: 32,
      atk: { inf: 18.0, arm: 15.0, air: 6.0, sea: 30.0 },
      def: { inf: 22.0, arm: 22.0, air: 12.0, sea: 22.0 },
      cost: { manpower: 900, iron: 4200, coal: 2000, oil: 600, money: 34000 },
      time: 80, upkeep: { grain: 20, coal: 70, money: 210 }, shells: 22.0,
      req: { building: 'harbour', level: 3, tech: 'dreadnoughts' },
      desc: 'A national treasury turned into a flight deck. Rules any sea it enters, and too precious to risk.'
    }
  ];

  var BY_ID = {};
  for (var i = 0; i < UNITS.length; i++) BY_ID[UNITS[i].id] = UNITS[i];

  /** Resource keys a unit may cost or consume. */
  var RESOURCES = ['manpower', 'grain', 'timber', 'coal', 'iron', 'oil', 'shells', 'money'];

  var RESOURCE_META = {
    manpower: { name: 'Manpower', icon: '⛊', color: '#8ea6b8' },
    grain: { name: 'Grain', icon: '\u{1F33E}', color: '#c9a24a' },
    timber: { name: 'Timber', icon: '\u{1F332}', color: '#8a6a3f' },
    coal: { name: 'Coal', icon: '⬢', color: '#6c7076' },
    iron: { name: 'Iron', icon: '⛓', color: '#8fa3b5' },
    oil: { name: 'Oil', icon: '\u{1F6E2}', color: '#4a5058' },
    shells: { name: 'Shells', icon: '\u{1F4A5}', color: '#a8863f' },
    money: { name: 'Treasury', icon: '\u{1F4B0}', color: '#5fbf8f' },
    gold: { name: 'War Bonds', icon: '\u{1F396}', color: '#e0b040' }
  };

  global.IA = global.IA || {};
  global.IA.UnitData = { UNITS: UNITS, BY_ID: BY_ID, RESOURCES: RESOURCES, RESOURCE_META: RESOURCE_META };
})(typeof globalThis !== 'undefined' ? globalThis : this);
