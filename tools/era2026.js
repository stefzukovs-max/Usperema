/*
 * The world as it stands.
 *
 * The map compiler reads modern, public-domain Natural Earth geometry, so this
 * era is the one that needs no reconstruction: every present-day country is
 * itself, inside its own recognised borders, with the capital it governs from.
 *
 * Natural Earth groups territories under a sovereignty code (FR1, US1, DN1)
 * rather than an ISO country code, so dependencies fold in behind the state
 * that holds them — French Guiana under France, Greenland under Denmark — the
 * way an atlas prints them.  Disputed and indeterminate ground is left
 * unclaimed rather than awarded to either claimant.
 *
 * The alliances below are the standing ones of the present day.  They are a
 * statement about who has signed what, not about who is right.
 */
'use strict';

/*
 * Natural Earth ships some names in an older or abbreviated form.  These are
 * the current ones.  A null means the territory is not a place anyone plays
 * from — uninhabited islands and Antarctic claims — and is dropped.
 */
var NAME_NOW = {
  Turkey: 'Türkiye', 'Czech Rep.': 'Czechia', 'Czech Republic': 'Czechia',
  Swaziland: 'Eswatini', Macedonia: 'North Macedonia', 'North Macedonia': 'North Macedonia',
  'Cape Verde': 'Cabo Verde', 'Ivory Coast': "Côte d'Ivoire", Burma: 'Myanmar',
  'East Timor': 'Timor-Leste', 'Dem. Rep. Congo': 'DR Congo', 'Congo': 'Republic of the Congo',
  'Central African Rep.': 'Central African Republic', 'Dominican Rep.': 'Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea', 'S. Sudan': 'South Sudan',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Solomon Is.': 'Solomon Islands', 'Falkland Is.': 'Falkland Islands',
  'United States of America': 'United States', 'W. Sahara': 'Western Sahara',
  'Antigua and Barb.': 'Antigua and Barbuda',
  'St. Vin. and Gren.': 'Saint Vincent and the Grenadines',
  'Marshall Is.': 'Marshall Islands', 'St. Kitts and Nevis': 'Saint Kitts and Nevis',
  'Sao Tome and Principe': 'São Tomé and Príncipe',
  'N. Cyprus': 'Northern Cyprus', 'Fr. Polynesia': 'French Polynesia',
  'Fr. S. Antarctic Lands': null, 'Br. Indian Ocean Ter.': null,
  'S. Geo. and the Is.': null, 'Heard I. and McDonald Is.': null,
  'Fr. S. and Antarctic Lands': null
};

/* The two standing military alliances, by ISO code. */
var NATO = ('USA GBR FRA DEU ITA ESP PRT NLD BEL LUX DNK NOR ISL CAN TUR GRC ' +
  'POL CZE SVK HUN ROU BGR EST LVA LTU SVN HRV ALB MNE MKD FIN SWE').split(' ');
var CSTO = 'RUS BLR KAZ KGZ TJK ARM'.split(' ');

var BLOC_OF = {};
NATO.forEach(function (id) { BLOC_OF[id] = 'atlantic'; });
CSTO.forEach(function (id) { BLOC_OF[id] = 'eastern'; });

/**
 * Build the nation list from the country geometry, and a lookup from a
 * feature's properties to the nation that holds it.
 */
function nationsFrom(countriesGeo) {
  var nations = [];
  var byKey = {};

  function dropped(p) {
    if (p.ADM0_A3 === 'ATA' || p.ISO_A3 === 'ATA') return true;          // Antarctica
    return NAME_NOW[p.ADMIN] === null || NAME_NOW[p.SOVEREIGNT] === null;
  }

  // One nation per sovereignty group, named and coded from its home feature.
  var groups = {};
  countriesGeo.features.forEach(function (f) {
    var p = f.properties;
    if (dropped(p)) return;
    if (p.TYPE === 'Disputed' || p.TYPE === 'Indeterminate') return;
    var key = p.SOV_A3 || p.ADM0_A3;
    (groups[key] || (groups[key] = [])).push(f);
  });

  Object.keys(groups).forEach(function (key) {
    var list = groups[key];
    var home = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].properties.ADMIN === list[i].properties.SOVEREIGNT) { home = list[i]; break; }
    }
    if (!home) home = list[0];
    var hp = home.properties;
    var iso = hp.ISO_A3_EH && hp.ISO_A3_EH !== '-99' ? hp.ISO_A3_EH
      : (hp.ISO_A3 && hp.ISO_A3 !== '-99' ? hp.ISO_A3 : hp.ADM0_A3);
    byKey[key] = nations.length;
    nations.push({
      iso: iso,
      name: NAME_NOW[hp.ADMIN] || hp.ADMIN,
      bloc: BLOC_OF[iso] || 'neutral',
      capitalCity: null,               // taken from the gazetteer's own capitals
      area: 0, cells: [], pop: 0
    });
  });

  return {
    nations: nations,
    indexFor: function (p) {
      if (dropped(p)) return -2;                                  // not played at all
      if (p.TYPE === 'Disputed' || p.TYPE === 'Indeterminate') return -1;
      var at = byKey[p.SOV_A3 || p.ADM0_A3];
      return at === undefined ? -2 : at;
    }
  };
}

/*
 * Spot checks: each city must land inside the country that governs it, which
 * exercises the grouping, the projection and the raster at once.
 */
var CAPITAL_CHECKS = [
  ['France', 2.35, 48.86], ['Germany', 13.40, 52.52], ['Japan', 139.69, 35.69],
  ['Brazil', -47.93, -15.78], ['Egypt', 31.24, 30.04], ['India', 77.21, 28.61],
  ['China', 116.40, 39.90], ['United States', -77.04, 38.91],
  ['Australia', 149.13, -35.28], ['Russia', 37.62, 55.75], ['Nigeria', 7.49, 9.06],
  ['Mexico', -99.13, 19.43], ['Kazakhstan', 71.43, 51.16], ['Chile', -70.65, -33.44],
  ['Norway', 10.75, 59.91], ['Indonesia', 106.83, -6.18], ['Türkiye', 32.85, 39.93],
  ['South Africa', 28.19, -25.75], ['Canada', -75.70, 45.42], ['Poland', 21.01, 52.23]
];

module.exports = {
  id: '2026',
  title: 'The world as it stands',
  start: { year: 2026, month: 0, day: 5 },
  /*
   * No armistice is written in advance here, so the default campaign runs four
   * years — long enough for an industrial war to be decided, and the same order
   * of length as the one that was.
   */
  armisticeDays: 1461,
  /* Nobody is at war on the first morning. The blocs are signed, not shooting. */
  openingWar: false,
  nationsFrom: nationsFrom,
  SPLITS: [],
  PERIOD_NAMES: {},
  CAPITAL_CHECKS: CAPITAL_CHECKS,
  BLOC_OF: BLOC_OF
};
