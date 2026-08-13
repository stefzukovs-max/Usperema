/*
 * Officers: the names they go by, the ranks they hold, and what they are good
 * at.
 *
 * Names are ordinary surnames drawn from a pool per language, chosen so an
 * Austrian corps is not commanded by a General Nakamura.  They are common
 * family names, not the names of real commanders — nobody in this game is
 * meant to be a particular person.
 */
(function (global) {
  'use strict';

  var SURNAMES = {
    germanic: ['Brandt', 'Keller', 'Vogel', 'Reinhardt', 'Sauer', 'Hartmann', 'Lindner',
      'Steiner', 'Kolbe', 'Wendt', 'Ritter', 'Falk', 'Haas', 'Neumann'],
    slavic: ['Belov', 'Karpov', 'Sokolov', 'Marek', 'Tomic', 'Novak', 'Pavlic',
      'Zorin', 'Dragan', 'Ilic', 'Petrov', 'Krajnik', 'Vasilev', 'Radic'],
    romance: ['Duval', 'Marchand', 'Ferrer', 'Rossi', 'Bertrand', 'Lombardi', 'Moreau',
      'Fontana', 'Carrera', 'Vidal', 'Bassano', 'Renard', 'Salvi', 'Aubert'],
    anglo: ['Ashcombe', 'Marlow', 'Whitfield', 'Crane', 'Halloway', 'Pemberton', 'Fairweather',
      'Blackwood', 'Reddington', 'Thorne', 'Grantley', 'Merrick', 'Wexford', 'Stanhope'],
    nordic: ['Lindqvist', 'Aalto', 'Berg', 'Hakonsen', 'Dahl', 'Rask', 'Sundberg',
      'Nyholm', 'Bratt', 'Ekman', 'Vinter', 'Solheim'],
    levantine: ['Demirel', 'Kaya', 'Haddad', 'Nasri', 'Ozan', 'Serdar', 'Bahri',
      'Kirmani', 'Sabri', 'Yalcin', 'Tahir', 'Rashad'],
    eastasian: ['Nakamura', 'Ishida', 'Ogawa', 'Kuroda', 'Shirai', 'Zhao', 'Feng',
      'Lu', 'Sakai', 'Hu', 'Mori', 'Tan'],
    iberian: ['Almeida', 'Salazar', 'Bustos', 'Quiroga', 'Ferreira', 'Ocampo', 'Navarro',
      'Cardoso', 'Estrada', 'Mendoza', 'Ribeiro', 'Valdes'],
    southasian: ['Thapa', 'Rana', 'Gurung', 'Bahadur', 'Sherchan', 'Dorji', 'Batbold',
      'Naran', 'Tsering'],
    african: ['Tesfaye', 'Kebede', 'Bayo', 'Warrick', 'Mensah', 'Assefa', 'Duku']
  };

  /* Which pool each power's officers come from. */
  var POOL_OF = {
    GER: 'germanic', AUH: 'germanic', SUI: 'germanic', NLD: 'germanic',
    RUS: 'slavic', BUL: 'slavic', SER: 'slavic', MNE: 'slavic', ALB: 'slavic',
    FRA: 'romance', ITA: 'romance', BEL: 'romance', ROM: 'romance',
    GBR: 'anglo', USA: 'anglo', LIB: 'anglo',
    SWE: 'nordic', NOR: 'nordic', DEN: 'nordic',
    OTT: 'levantine', PER: 'levantine', AFG: 'levantine', OMA: 'levantine', NEJ: 'levantine',
    GRE: 'levantine',
    JPN: 'eastasian', CHN: 'eastasian', SIA: 'eastasian',
    ESP: 'iberian', POR: 'iberian', MEX: 'iberian', BRA: 'iberian', ARG: 'iberian',
    CHL: 'iberian', PRU: 'iberian', COL: 'iberian', VEN: 'iberian', BOL: 'iberian',
    URU: 'iberian', PAR: 'iberian', ECU: 'iberian', CUB: 'iberian', HAI: 'iberian',
    DOM: 'iberian', GUA: 'iberian', HON: 'iberian', SAL: 'iberian', NIC: 'iberian',
    CRC: 'iberian', PAN: 'iberian',
    NEP: 'southasian', BHU: 'southasian', MON: 'southasian',
    ETH: 'african'
  };

  /*
   * Rank is earned by being in battles that finish.  Each step is worth a
   * little in itself, and opens room for another trait.
   */
  var RANKS = [
    { name: 'Colonel', xp: 0, traits: 1 },
    { name: 'Brigadier', xp: 40, traits: 1 },
    { name: 'Major General', xp: 110, traits: 2 },
    { name: 'Lieutenant General', xp: 240, traits: 2 },
    { name: 'General', xp: 440, traits: 3 },
    { name: 'Field Marshal', xp: 760, traits: 3 }
  ];

  /*
   * Traits are two-sided wherever they are strong.  An officer who presses
   * every attack is not the one you want holding a line.
   */
  var TRAITS = [
    { id: 'aggressive', name: 'Aggressive', desc: 'Presses every attack home. +14% attack, -9% defence.',
      attack: 0.14, defence: -0.09 },
    { id: 'methodical', name: 'Methodical', desc: 'Will not move until everything is in place. +16% defence, -12% pace.',
      defence: 0.16, speed: -0.12 },
    { id: 'driver', name: 'Driver', desc: 'Keeps the column moving. +18% pace.',
      speed: 0.18 },
    { id: 'gunner', name: 'Gunner', desc: 'Came up through the artillery. +22% fire from guns.',
      artillery: 0.22 },
    { id: 'sapper', name: 'Sapper', desc: 'Digs in the moment the advance stops. +35% entrenchment rate.',
      entrench: 0.35 },
    { id: 'quartermaster', name: 'Quartermaster', desc: 'Finds supply where there is none. Halves attrition.',
      attrition: -0.5 },
    { id: 'inspiring', name: 'Inspiring', desc: 'The men will hold for him. +12% attack when the stack is hurt.',
      resolve: 0.12 },
    { id: 'cautious', name: 'Cautious', desc: 'Spends ground rather than men. -16% damage taken, -8% attack.',
      damageTaken: -0.16, attack: -0.08 }
  ];

  var TRAIT_BY_ID = {};
  for (var i = 0; i < TRAITS.length; i++) TRAIT_BY_ID[TRAITS[i].id] = TRAITS[i];

  global.IA = global.IA || {};
  global.IA.CommanderData = {
    SURNAMES: SURNAMES, POOL_OF: POOL_OF, RANKS: RANKS,
    TRAITS: TRAITS, TRAIT_BY_ID: TRAIT_BY_ID
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
