/*
 * The world as it stood in 1914, composed from present-day borders.
 *
 * The map compiler reads modern, public-domain Natural Earth geometry.  This
 * table says which 1914 power held each present-day territory, so the compiler
 * can merge them into the empires that actually fought the Great War.
 *
 * WHAT THIS IS AND IS NOT
 *
 * These are 1914 borders approximated from modern ones.  Where a 1914 frontier
 * ran along a present-day national border — Germany and Russia across the
 * Baltic states, Austria-Hungary around Bohemia — the result is exact.  Where
 * it cut through a country that did not exist yet, a country-level merge
 * cannot reproduce it, so `SPLITS` below carves those cases by longitude and
 * latitude: partitioned Poland, Alsace-Lorraine, Transylvania, the Italian
 * irredenta.  Those cuts are accurate to roughly the width of one province,
 * which is the resolution the game plays at.
 *
 * Colonies and dominions fold into the metropole that held them, the way an
 * atlas of the period would print them.  Every entry here is a statement about
 * 1914 political control, not an endorsement of it.
 */
'use strict';

/* The powers, in rough order of weight in the war. */
var POWERS = [
  { id: 'GER', name: 'German Empire', capital: 'Berlin', bloc: 'central' },
  { id: 'AUH', name: 'Austria-Hungary', capital: 'Vienna', bloc: 'central' },
  { id: 'OTT', name: 'Ottoman Empire', capital: 'Istanbul', bloc: 'central' },
  { id: 'BUL', name: 'Bulgaria', capital: 'Sofia', bloc: 'central' },

  { id: 'RUS', name: 'Russian Empire', capital: 'St. Petersburg', bloc: 'entente' },
  { id: 'FRA', name: 'France', capital: 'Paris', bloc: 'entente' },
  { id: 'GBR', name: 'British Empire', capital: 'London', bloc: 'entente' },
  { id: 'ITA', name: 'Italy', capital: 'Rome', bloc: 'entente' },
  { id: 'SER', name: 'Serbia', capital: 'Belgrade', bloc: 'entente' },
  { id: 'MNE', name: 'Montenegro', capital: 'Podgorica', bloc: 'entente' },
  { id: 'BEL', name: 'Belgium', capital: 'Brussels', bloc: 'entente' },
  { id: 'ROM', name: 'Romania', capital: 'Bucharest', bloc: 'entente' },
  { id: 'JPN', name: 'Empire of Japan', capital: 'Tokyo', bloc: 'entente' },
  { id: 'POR', name: 'Portugal', capital: 'Lisbon', bloc: 'entente' },
  { id: 'GRE', name: 'Greece', capital: 'Athens', bloc: 'entente' },

  { id: 'USA', name: 'United States', capital: 'Washington, D.C.', bloc: 'neutral' },
  { id: 'NLD', name: 'Netherlands', capital: 'Amsterdam', bloc: 'neutral' },
  { id: 'ESP', name: 'Spain', capital: 'Madrid', bloc: 'neutral' },
  { id: 'SWE', name: 'Sweden', capital: 'Stockholm', bloc: 'neutral' },
  { id: 'NOR', name: 'Norway', capital: 'Oslo', bloc: 'neutral' },
  { id: 'DEN', name: 'Denmark', capital: 'København', bloc: 'neutral' },
  { id: 'SUI', name: 'Switzerland', capital: 'Bern', bloc: 'neutral' },
  { id: 'CHN', name: 'Republic of China', capital: 'Beijing', bloc: 'neutral' },
  { id: 'PER', name: 'Persia', capital: 'Tehran', bloc: 'neutral' },
  { id: 'AFG', name: 'Afghanistan', capital: 'Kabul', bloc: 'neutral' },
  { id: 'SIA', name: 'Siam', capital: 'Bangkok', bloc: 'neutral' },
  { id: 'ETH', name: 'Abyssinia', capital: 'Addis Ababa', bloc: 'neutral' },
  { id: 'MEX', name: 'Mexico', capital: 'Mexico City', bloc: 'neutral' },
  { id: 'BRA', name: 'Brazil', capital: 'Rio de Janeiro', bloc: 'neutral' },
  { id: 'ARG', name: 'Argentina', capital: 'Buenos Aires', bloc: 'neutral' },
  { id: 'CHL', name: 'Chile', capital: 'Santiago', bloc: 'neutral' },
  { id: 'PRU', name: 'Peru', capital: 'Lima', bloc: 'neutral' },
  { id: 'COL', name: 'Colombia', capital: 'Bogota', bloc: 'neutral' },
  { id: 'VEN', name: 'Venezuela', capital: 'Caracas', bloc: 'neutral' },
  { id: 'BOL', name: 'Bolivia', capital: 'La Paz', bloc: 'neutral' },
  { id: 'URU', name: 'Uruguay', capital: 'Montevideo', bloc: 'neutral' },
  { id: 'PAR', name: 'Paraguay', capital: 'Asunción', bloc: 'neutral' },
  { id: 'ECU', name: 'Ecuador', capital: 'Quito', bloc: 'neutral' },
  { id: 'CUB', name: 'Cuba', capital: 'Havana', bloc: 'neutral' },
  { id: 'HAI', name: 'Haiti', capital: 'Port-au-Prince', bloc: 'neutral' },
  { id: 'DOM', name: 'Dominican Republic', capital: 'Santo Domingo', bloc: 'neutral' },
  { id: 'GUA', name: 'Guatemala', capital: 'Guatemala City', bloc: 'neutral' },
  { id: 'HON', name: 'Honduras', capital: 'Tegucigalpa', bloc: 'neutral' },
  { id: 'SAL', name: 'El Salvador', capital: 'San Salvador', bloc: 'neutral' },
  { id: 'NIC', name: 'Nicaragua', capital: 'Managua', bloc: 'neutral' },
  { id: 'CRC', name: 'Costa Rica', capital: 'San José', bloc: 'neutral' },
  { id: 'PAN', name: 'Panama', capital: 'Panama City', bloc: 'neutral' },
  { id: 'ALB', name: 'Albania', capital: 'Tirana', bloc: 'neutral' },
  { id: 'LIB', name: 'Liberia', capital: 'Monrovia', bloc: 'neutral' },
  { id: 'NEP', name: 'Nepal', capital: 'Kathmandu', bloc: 'neutral' },
  { id: 'BHU', name: 'Bhutan', capital: 'Thimphu', bloc: 'neutral' },
  { id: 'MON', name: 'Mongolia', capital: 'Ulaanbaatar', bloc: 'neutral' },
  { id: 'OMA', name: 'Muscat and Oman', capital: 'Muscat', bloc: 'neutral' },
  { id: 'NEJ', name: 'Emirate of Nejd', capital: 'Riyadh', bloc: 'neutral' }
];

/*
 * Present-day ISO A3 -> the 1914 power that held that ground.
 * Anything absent from this table is left unclaimed.
 */
var HELD_BY = {
  // --- Central Powers ---------------------------------------------------
  DEU: 'GER', NAM: 'GER', TZA: 'GER', CMR: 'GER', TGO: 'GER', RWA: 'GER', BDI: 'GER',
  AUT: 'AUH', HUN: 'AUH', CZE: 'AUH', SVK: 'AUH', SVN: 'AUH', HRV: 'AUH', BIH: 'AUH',
  TUR: 'OTT', SYR: 'OTT', LBN: 'OTT', ISR: 'OTT', PSE: 'OTT', JOR: 'OTT', IRQ: 'OTT',
  YEM: 'OTT', KWT: 'OTT',
  BGR: 'BUL',

  // --- Russian Empire ---------------------------------------------------
  RUS: 'RUS', FIN: 'RUS', EST: 'RUS', LVA: 'RUS', LTU: 'RUS', BLR: 'RUS', UKR: 'RUS',
  MDA: 'RUS', GEO: 'RUS', ARM: 'RUS', AZE: 'RUS', KAZ: 'RUS', UZB: 'RUS', TKM: 'RUS',
  KGZ: 'RUS', TJK: 'RUS', POL: 'RUS',

  // --- British Empire ---------------------------------------------------
  GBR: 'GBR', IRL: 'GBR', IND: 'GBR', PAK: 'GBR', BGD: 'GBR', MMR: 'GBR', LKA: 'GBR',
  CAN: 'GBR', AUS: 'GBR', NZL: 'GBR', ZAF: 'GBR', EGY: 'GBR', SDN: 'GBR', SSD: 'GBR',
  NGA: 'GBR', GHA: 'GBR', KEN: 'GBR', UGA: 'GBR', ZMB: 'GBR', ZWE: 'GBR', BWA: 'GBR',
  MWI: 'GBR', SLE: 'GBR', GMB: 'GBR', CYP: 'GBR', MLT: 'GBR', MYS: 'GBR', SGP: 'GBR',
  BRN: 'GBR', GUY: 'GBR', BLZ: 'GBR', JAM: 'GBR', TTO: 'GBR', LSO: 'GBR', SWZ: 'GBR',
  SOM: 'GBR', BHS: 'GBR', FJI: 'GBR', PNG: 'GBR', ARE: 'GBR', QAT: 'GBR', BHR: 'GBR',

  // --- France -----------------------------------------------------------
  FRA: 'FRA', DZA: 'FRA', TUN: 'FRA', MAR: 'FRA', MRT: 'FRA', MLI: 'FRA', NER: 'FRA',
  TCD: 'FRA', SEN: 'FRA', GIN: 'FRA', CIV: 'FRA', BFA: 'FRA', BEN: 'FRA', GAB: 'FRA',
  COG: 'FRA', CAF: 'FRA', DJI: 'FRA', MDG: 'FRA', VNM: 'FRA', LAO: 'FRA', KHM: 'FRA',
  COM: 'FRA',

  // --- Other colonial powers -------------------------------------------
  ITA: 'ITA', LBY: 'ITA', ERI: 'ITA',
  BEL: 'BEL', COD: 'BEL',
  NLD: 'NLD', IDN: 'NLD', SUR: 'NLD',
  PRT: 'POR', AGO: 'POR', MOZ: 'POR', GNB: 'POR', TLS: 'POR', CPV: 'POR', STP: 'POR',
  ESP: 'ESP', ESH: 'ESP', GNQ: 'ESP',
  DNK: 'DEN', GRL: 'DEN', ISL: 'DEN',
  JPN: 'JPN', KOR: 'JPN', PRK: 'JPN', TWN: 'JPN',
  USA: 'USA', PHL: 'USA', PRI: 'USA',

  // --- Independent states ------------------------------------------------
  SRB: 'SER', MNE: 'MNE', ROU: 'ROM', GRC: 'GRE', ALB: 'ALB',
  SWE: 'SWE', NOR: 'NOR', CHE: 'SUI',
  CHN: 'CHN', MNG: 'MON', NPL: 'NEP', BTN: 'BHU', THA: 'SIA', AFG: 'AFG', IRN: 'PER',
  SAU: 'NEJ', OMN: 'OMA',
  ETH: 'ETH', LBR: 'LIB',
  MEX: 'MEX', BRA: 'BRA', ARG: 'ARG', CHL: 'CHL', PER: 'PRU', COL: 'COL', VEN: 'VEN',
  BOL: 'BOL', URY: 'URU', PRY: 'PAR', ECU: 'ECU', CUB: 'CUB', HTI: 'HAI', DOM: 'DOM',
  GTM: 'GUA', HND: 'HON', SLV: 'SAL', NIC: 'NIC', CRI: 'CRC', PAN: 'PAN'
};

/*
 * Frontiers that ran through countries which did not exist in 1914.  Applied
 * to the raster after the country fills, so provinces grow inside the corrected
 * borders rather than straddling them.  Boxes are [west, south, east, north].
 */
var SPLITS = [
  // Partitioned Poland. Poland defaults to Russia above; these carve off the
  // Prussian and Austrian shares. `from` keeps each cut inside the country it
  // is dividing, so the Silesian box cannot reach into Bohemia next door.
  { from: 'RUS', power: 'GER', box: [14.0, 49.5, 19.3, 54.6], note: 'Posen, Silesia, West Prussia' },
  { from: 'RUS', power: 'AUH', box: [18.8, 48.9, 24.3, 50.8], note: 'Galicia' },
  // German gains of 1871.
  { from: 'FRA', power: 'GER', box: [6.8, 47.4, 8.4, 49.6], note: 'Alsace-Lorraine' },
  // Austro-Hungarian holdings inside modern Romania and Italy.
  { from: 'ROM', power: 'AUH', box: [20.9, 45.2, 26.3, 48.2], note: 'Transylvania and the Banat' },
  { from: 'ITA', power: 'AUH', box: [10.3, 45.6, 14.1, 47.2], note: 'Trentino, Görz, Trieste' },
  // The Ottoman Hejaz along the Red Sea coast.
  { from: 'NEJ', power: 'OTT', box: [34.5, 19.5, 44.0, 31.5], note: 'Hejaz and Asir' },
  // Northern New Guinea was German; the south and east were British.
  { from: 'GBR', power: 'GER', box: [140.0, -6.6, 148.5, -1.0], note: 'Kaiser-Wilhelmsland' }
];

/*
 * Period names for places the modern gazetteer lists otherwise.  Only cities
 * that genuinely carried a different name in 1914 are listed.
 */
var PERIOD_NAMES = {
  'Istanbul': 'Constantinople',
  'St. Petersburg': 'Petrograd',
  'København': 'Copenhagen',
  'Volgograd': 'Tsaritsyn',
  'Kaliningrad': 'Königsberg',
  'Gdansk': 'Danzig',
  'Gdańsk': 'Danzig',
  'Wroclaw': 'Breslau',
  'Wrocław': 'Breslau',
  'Szczecin': 'Stettin',
  'Lviv': 'Lemberg',
  'Vilnius': 'Wilno',
  'Bratislava': 'Pressburg',
  'Rijeka': 'Fiume',
  'Chisinau': 'Kishinev',
  'Chișinău': 'Kishinev',
  'Almaty': 'Verny',
  'Bishkek': 'Pishpek',
  'Dushanbe': 'Dyushambe',
  'Yekaterinburg': 'Ekaterinburg',
  'Nizhniy Novgorod': 'Nizhny Novgorod',
  'Ho Chi Minh City': 'Saigon',
  'Jakarta': 'Batavia',
  'Mumbai': 'Bombay',
  'Kolkata': 'Calcutta',
  'Chennai': 'Madras',
  'Yangon': 'Rangoon',
  'Guangzhou': 'Canton',
  'Beijing': 'Peking',
  'Harare': 'Salisbury',
  'Maputo': 'Lourenço Marques',
  'Kinshasa': 'Léopoldville',
  'Oslo': 'Christiania',
  'Thessaloniki': 'Salonika',
  'Izmir': 'Smyrna',
  'Tallinn': 'Reval',
  'Tartu': 'Dorpat',
  'Daugavpils': 'Dvinsk',
  'Klaipeda': 'Memel',
  'Klaipėda': 'Memel'
};

/*
 * Spot checks on the 1914 composition.  These cities must sit inside the power
 * that actually held them, which exercises the territory table, the frontier
 * splits and the raster all at once.  Warsaw, Poznan and Lviv are the
 * interesting ones: they check that partitioned Poland was carved correctly.
 */
var CAPITAL_CHECKS = [
  ['France', 2.35, 48.86],                   // Paris
  ['German Empire', 13.40, 52.52],           // Berlin
  ['German Empire', 7.75, 48.58],            // Strasbourg, in Alsace-Lorraine
  ['German Empire', 16.93, 52.41],           // Poznan, in Prussian Poland
  ['Austria-Hungary', 16.37, 48.21],         // Vienna
  ['Austria-Hungary', 14.42, 50.09],         // Prague, in Bohemia
  ['Austria-Hungary', 24.03, 49.84],         // Lviv, in Galicia
  ['Austria-Hungary', 23.60, 46.77],         // Cluj, in Transylvania
  ['Russian Empire', 21.01, 52.23],          // Warsaw, in Congress Poland
  ['Russian Empire', 30.32, 59.94],          // Petrograd
  ['Russian Empire', 24.75, 59.44],          // Reval, in the Baltic provinces
  ['Ottoman Empire', 28.98, 41.01],          // Constantinople
  ['Ottoman Empire', 44.36, 33.31],          // Baghdad, in Mesopotamia
  ['British Empire', -0.13, 51.51],          // London
  ['British Empire', 77.21, 28.61],          // Delhi
  ['British Empire', 31.24, 30.04],          // Cairo
  ['Empire of Japan', 139.69, 35.69],        // Tokyo
  ['Empire of Japan', 126.98, 37.57],        // Seoul, annexed in 1910
  ['Belgium', 15.31, -4.32],                 // Leopoldville, in the Congo
  ['Netherlands', 106.83, -6.18],            // Batavia, in the East Indies
  ['United States', -77.04, 38.91],          // Washington
  ['Serbia', 20.47, 44.80],                  // Belgrade
  ['Brazil', -43.20, -22.91]                 // Rio de Janeiro
];

/**
 * The powers of 1914, and a lookup from a present-day territory to whichever
 * of them held it.  Anything the table does not name is left unclaimed rather
 * than guessed at.
 */
function nationsFrom() {
  var nations = [];
  var byIso = {};
  POWERS.forEach(function (power) {
    byIso[power.id] = nations.length;
    nations.push({
      iso: power.id, name: power.name, bloc: power.bloc,
      capitalCity: power.capital, area: 0, cells: [], pop: 0
    });
  });
  return {
    nations: nations,
    indexFor: function (p) {
      if (p.ADM0_A3 === 'ATA' || p.ISO_A3 === 'ATA') return -2;
      if (p.TYPE === 'Disputed' || p.TYPE === 'Indeterminate') return -2;
      var iso = p.ISO_A3_EH && p.ISO_A3_EH !== '-99' ? p.ISO_A3_EH
        : (p.ISO_A3 && p.ISO_A3 !== '-99' ? p.ISO_A3 : p.ADM0_A3);
      var powerId = HELD_BY[iso];
      if (powerId === undefined) return -1;                 // nobody's, and named as such
      return byIso[powerId];
    }
  };
}

module.exports = {
  id: '1914',
  title: 'The Great War',
  start: { year: 1914, month: 6, day: 28 },
  /* To 11 November 1918: the armistice that actually ended it. */
  armisticeDays: Math.round((Date.UTC(1918, 10, 11) - Date.UTC(1914, 6, 28)) / 86400000),
  /* The blocs are already shooting on the first morning. */
  openingWar: true,
  nationsFrom: nationsFrom,
  POWERS: POWERS,
  HELD_BY: HELD_BY,
  SPLITS: SPLITS,
  PERIOD_NAMES: PERIOD_NAMES,
  CAPITAL_CHECKS: CAPITAL_CHECKS,
  byId: function (id) {
    for (var i = 0; i < POWERS.length; i++) if (POWERS[i].id === id) return POWERS[i];
    return null;
  }
};
