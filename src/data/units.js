/*
 * Unit roster.
 *
 * Combat resolves through four target classes: inf (foot/mechanised), arm
 * (armour), air, sea.  Every unit lists what it can hit (`atk`) and how well
 * it survives being hit by each class (`def`).
 *
 * speed   province-grid cells per game hour (a province is ~6-10 cells wide)
 * hp      hit points per battalion; a stack of 3 infantry has 90 hp
 * range   provinces an attack can reach without entering the target (0 = melee)
 * domain  'land' | 'sea' | 'air' — restricts which provinces it may occupy
 */
(function (global) {
  'use strict';

  var UNITS = [
    {
      id: 'infantry', name: 'Infantry', short: 'INF', cat: 'inf', domain: 'land', icon: '♟',
      hp: 30, speed: 0.42, range: 0, view: 12,
      atk: { inf: 4.0, arm: 1.6, air: 0.8, sea: 0.6 },
      def: { inf: 6.5, arm: 4.5, air: 3.0, sea: 3.0 },
      cost: { manpower: 240, food: 140, materials: 90, cash: 900 },
      time: 8, upkeep: { food: 3, cash: 6 }, ammo: 1.5,
      req: { building: 'recruiting', level: 1 },
      desc: 'Cheap, tough in cover, and the backbone of any occupation force.'
    },
    {
      id: 'mech_inf', name: 'Mechanised Infantry', short: 'MEC', cat: 'inf', domain: 'land', icon: '⛁',
      hp: 38, speed: 0.72, range: 0, view: 14,
      atk: { inf: 6.5, arm: 4.2, air: 1.6, sea: 1.0 },
      def: { inf: 8.5, arm: 7.0, air: 4.0, sea: 3.5 },
      cost: { manpower: 220, food: 130, materials: 240, fuel: 160, cash: 2100 },
      time: 14, upkeep: { food: 4, fuel: 5, cash: 13 }, ammo: 2.5,
      req: { building: 'recruiting', level: 2, tech: 'mech_inf' },
      desc: 'Infantry with wheels. Fast enough to plug a hole before it opens.'
    },
    {
      id: 'light_tank', name: 'Light Tank', short: 'LT', cat: 'arm', domain: 'land', icon: '▰',
      hp: 44, speed: 0.68, range: 0, view: 14,
      atk: { inf: 9.0, arm: 6.5, air: 1.2, sea: 1.4 },
      def: { inf: 9.0, arm: 8.0, air: 3.5, sea: 3.5 },
      cost: { manpower: 160, materials: 380, fuel: 240, cash: 2600 },
      time: 18, upkeep: { food: 2, fuel: 8, cash: 16 }, ammo: 3.0,
      req: { building: 'arms_factory', level: 1, tech: 'armour' },
      desc: 'Breakthrough armour. Punishes infantry in the open, folds to AT fire.'
    },
    {
      id: 'mbt', name: 'Main Battle Tank', short: 'MBT', cat: 'arm', domain: 'land', icon: '■',
      hp: 62, speed: 0.56, range: 0, view: 14,
      atk: { inf: 13.0, arm: 14.0, air: 1.8, sea: 2.0 },
      def: { inf: 15.0, arm: 14.0, air: 5.0, sea: 5.0 },
      cost: { manpower: 200, materials: 720, fuel: 420, chemicals: 120, cash: 5200 },
      time: 30, upkeep: { food: 3, fuel: 16, cash: 30 }, ammo: 5.0,
      req: { building: 'arms_factory', level: 2, tech: 'mbt' },
      desc: 'The hammer. Expensive to field, decisive where it arrives.'
    },
    {
      id: 'artillery', name: 'Artillery', short: 'ART', cat: 'inf', domain: 'land', icon: '✲',
      hp: 26, speed: 0.34, range: 1, view: 10,
      atk: { inf: 14.0, arm: 8.0, air: 0.4, sea: 5.0 },
      def: { inf: 3.0, arm: 2.0, air: 1.5, sea: 1.5 },
      cost: { manpower: 180, materials: 400, chemicals: 160, cash: 3000 },
      time: 22, upkeep: { food: 2, cash: 12 }, ammo: 8.0,
      req: { building: 'arms_factory', level: 1, tech: 'artillery' },
      desc: 'Shells the neighbouring province without ever entering it. Helpless if reached.'
    },
    {
      id: 'sam', name: 'SAM Battery', short: 'SAM', cat: 'inf', domain: 'land', icon: '▲',
      hp: 28, speed: 0.36, range: 1, view: 20,
      atk: { inf: 1.0, arm: 0.8, air: 22.0, sea: 0.6 },
      def: { inf: 4.0, arm: 3.0, air: 9.0, sea: 2.0 },
      cost: { manpower: 140, materials: 320, chemicals: 200, cash: 2800 },
      time: 20, upkeep: { food: 2, cash: 11 }, ammo: 3.0,
      req: { building: 'arms_factory', level: 1, tech: 'air_defence' },
      desc: 'Denies the sky over itself and one province out. Useless on the ground.'
    },
    {
      id: 'helicopter', name: 'Attack Helicopter', short: 'HEL', cat: 'air', domain: 'land', icon: '✥',
      hp: 34, speed: 1.9, range: 1, view: 22,
      atk: { inf: 11.0, arm: 13.0, air: 5.0, sea: 6.0 },
      def: { inf: 6.0, arm: 6.0, air: 6.0, sea: 5.0 },
      cost: { manpower: 120, materials: 460, fuel: 380, chemicals: 140, cash: 4400 },
      time: 26, upkeep: { fuel: 18, cash: 24 }, ammo: 4.5,
      req: { building: 'airbase', level: 1, tech: 'rotary_wing' },
      desc: 'Tank killer that lands anywhere friendly. Shredded by SAMs.'
    },
    {
      id: 'fighter', name: 'Fighter Jet', short: 'FTR', cat: 'air', domain: 'air', icon: '➤',
      hp: 30, speed: 3.6, range: 0, view: 30,
      atk: { inf: 4.0, arm: 3.0, air: 20.0, sea: 5.0 },
      def: { inf: 7.0, arm: 7.0, air: 12.0, sea: 6.0 },
      cost: { manpower: 90, materials: 520, fuel: 460, chemicals: 220, cash: 6200 },
      time: 30, upkeep: { fuel: 26, cash: 34 }, ammo: 4.0,
      req: { building: 'airbase', level: 2, tech: 'jet_engine' },
      desc: 'Owns the air. Must return to an airbase before its fuel runs dry.'
    },
    {
      id: 'bomber', name: 'Strategic Bomber', short: 'BMB', cat: 'air', domain: 'air', icon: '✈',
      hp: 40, speed: 2.6, range: 0, view: 26,
      atk: { inf: 20.0, arm: 15.0, air: 2.0, sea: 12.0 },
      def: { inf: 6.0, arm: 6.0, air: 5.0, sea: 5.0 },
      cost: { manpower: 140, materials: 780, fuel: 620, chemicals: 300, cash: 9000 },
      time: 40, upkeep: { fuel: 36, cash: 50 }, ammo: 9.0,
      req: { building: 'airbase', level: 3, tech: 'strategic_bombing' },
      desc: 'Flattens stacks and buildings alike. Needs friendly skies to survive.'
    },
    {
      id: 'destroyer', name: 'Destroyer', short: 'DD', cat: 'sea', domain: 'sea', icon: '⚓',
      hp: 70, speed: 1.15, range: 1, view: 26,
      atk: { inf: 9.0, arm: 7.0, air: 8.0, sea: 14.0 },
      def: { inf: 10.0, arm: 10.0, air: 10.0, sea: 12.0 },
      cost: { manpower: 300, materials: 900, fuel: 520, cash: 7600 },
      time: 36, upkeep: { food: 5, fuel: 22, cash: 40 }, ammo: 6.0,
      req: { building: 'naval_base', level: 1, tech: 'naval_doctrine' },
      desc: 'Escort and shore bombardment. Shells the coast from open water.'
    },
    {
      id: 'submarine', name: 'Submarine', short: 'SUB', cat: 'sea', domain: 'sea', icon: '◢',
      hp: 46, speed: 0.95, range: 0, view: 14,
      atk: { inf: 2.0, arm: 2.0, air: 0.5, sea: 26.0 },
      def: { inf: 5.0, arm: 5.0, air: 14.0, sea: 6.0 },
      cost: { manpower: 220, materials: 780, fuel: 480, chemicals: 180, cash: 8200 },
      time: 40, upkeep: { food: 4, fuel: 18, cash: 42 }, ammo: 5.0,
      req: { building: 'naval_base', level: 2, tech: 'submarine_warfare' },
      desc: 'Hunts shipping and transports. Nearly blind, nearly invisible.'
    },
    {
      id: 'carrier', name: 'Aircraft Carrier', short: 'CV', cat: 'sea', domain: 'sea', icon: '✦',
      hp: 110, speed: 0.9, range: 2, view: 40,
      atk: { inf: 14.0, arm: 11.0, air: 16.0, sea: 18.0 },
      def: { inf: 12.0, arm: 12.0, air: 9.0, sea: 10.0 },
      cost: { manpower: 600, materials: 2200, fuel: 1400, chemicals: 500, cash: 26000 },
      time: 72, upkeep: { food: 14, fuel: 60, cash: 130 }, ammo: 16.0,
      req: { building: 'naval_base', level: 3, tech: 'carrier_ops' },
      desc: 'A mobile airbase. Projects power two provinces inland from any sea.'
    },
    {
      id: 'ballistic_missile', name: 'Ballistic Missile', short: 'BM', cat: 'missile', domain: 'land', icon: '↑',
      hp: 10, speed: 0.30, range: 14, view: 0,
      atk: { inf: 120.0, arm: 110.0, air: 0.0, sea: 90.0 },
      def: { inf: 1.0, arm: 1.0, air: 1.0, sea: 1.0 },
      cost: { manpower: 80, materials: 900, fuel: 700, chemicals: 900, cash: 15000 },
      time: 48, upkeep: { cash: 20 }, ammo: 0,
      req: { building: 'arms_factory', level: 3, tech: 'rocketry' },
      desc: 'One-shot strike at strategic range. Wrecks a stack and the province morale with it.'
    }
  ];

  var BY_ID = {};
  for (var i = 0; i < UNITS.length; i++) BY_ID[UNITS[i].id] = UNITS[i];

  /** Resource keys a unit may cost or consume. */
  var RESOURCES = ['manpower', 'food', 'materials', 'fuel', 'ammo', 'chemicals', 'cash'];

  var RESOURCE_META = {
    manpower: { name: 'Manpower', icon: '⛑', color: '#8ea6b8' },
    food: { name: 'Food', icon: '\u{1F4E6}', color: '#7fbf5f' },
    materials: { name: 'Materials', icon: '⚙', color: '#7fa8c8' },
    fuel: { name: 'Fuel', icon: '⛽', color: '#d05f4f' },
    ammo: { name: 'Ammunition', icon: '\u{1F9F0}', color: '#8fbf4f' },
    chemicals: { name: 'Chemicals', icon: '⚗', color: '#d0904f' },
    cash: { name: 'Cash', icon: '\u{1F4B5}', color: '#5fbf8f' },
    gold: { name: 'Gold', icon: '\u{1F7E1}', color: '#e0b040' }
  };

  global.SWW = global.SWW || {};
  global.SWW.UnitData = { UNITS: UNITS, BY_ID: BY_ID, RESOURCES: RESOURCES, RESOURCE_META: RESOURCE_META };
})(typeof globalThis !== 'undefined' ? globalThis : this);
