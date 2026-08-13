/*
 * The calendar, the seasons, and the weather over each province.
 *
 * The war opens on 28 July 1914 and the clock runs from there, so the seasons
 * arrive when they should: the autumn rains turn the ground to mud, the winter
 * closes the mountain passes, and an offensive launched in October moves at
 * half the pace of one launched in June.
 *
 * Weather is settled once a day.  It is drawn per weather cell rather than per
 * province — roughly twelve degrees of longitude by ten of latitude — so a
 * front sits over a region for the day instead of flickering province by
 * province, and it is a pure function of the seed, the day and the cell, so it
 * survives a save without being stored.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};

  var START = Date.UTC(1914, 6, 28);              // 28 July 1914
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  /*
   * `speed` multiplies movement, `attack` multiplies the fire a stack puts out,
   * and `attrition` is hit points an hour per battalion lost to the conditions
   * themselves — men in the open in a blizzard, or in the desert in August.
   */
  var WEATHER = {
    clear: { name: 'Clear', icon: '☀', speed: 1.00, attack: 1.00, attrition: 0, wash: null },
    overcast: { name: 'Overcast', icon: '☁', speed: 1.00, attack: 0.97, attrition: 0, wash: null },
    rain: { name: 'Rain', icon: '☂', speed: 0.85, attack: 0.92, attrition: 0, wash: 'rgba(70,96,120,0.16)' },
    fog: { name: 'Fog', icon: '▤', speed: 0.90, attack: 0.78, attrition: 0, wash: 'rgba(206,212,216,0.16)' },
    mud: { name: 'Mud', icon: '≋', speed: 0.55, attack: 0.82, attrition: 0.05, wash: 'rgba(92,68,40,0.26)' },
    snow: { name: 'Snow', icon: '❄', speed: 0.65, attack: 0.85, attrition: 0.10, wash: 'rgba(226,236,244,0.17)' },
    blizzard: { name: 'Blizzard', icon: '✼', speed: 0.38, attack: 0.68, attrition: 0.28, wash: 'rgba(238,246,252,0.29)' },
    heat: { name: 'Heat', icon: '☼', speed: 0.85, attack: 0.92, attrition: 0.12, wash: 'rgba(224,168,72,0.18)' },
    storm: { name: 'Storm', icon: '⚡', speed: 0.70, attack: 0.85, attrition: 0.06, wash: 'rgba(48,66,92,0.30)' }
  };

  /*
   * Six draws per season per climate.  Repetition is the weighting: mud appears
   * twice in a temperate autumn because that is what a temperate autumn mostly
   * is.
   */
  var DRAWS = {
    temperate: {
      winter: ['snow', 'snow', 'rain', 'overcast', 'clear', 'blizzard'],
      spring: ['rain', 'mud', 'overcast', 'clear', 'clear', 'fog'],
      summer: ['clear', 'clear', 'clear', 'overcast', 'rain', 'heat'],
      autumn: ['rain', 'mud', 'mud', 'overcast', 'fog', 'clear']
    },
    polar: {
      winter: ['blizzard', 'snow', 'snow', 'snow', 'overcast', 'blizzard'],
      spring: ['snow', 'mud', 'mud', 'overcast', 'rain', 'clear'],
      summer: ['overcast', 'clear', 'rain', 'clear', 'fog', 'overcast'],
      autumn: ['snow', 'mud', 'rain', 'overcast', 'snow', 'fog']
    },
    arid: {
      winter: ['clear', 'clear', 'overcast', 'clear', 'rain', 'clear'],
      spring: ['clear', 'clear', 'heat', 'clear', 'overcast', 'clear'],
      summer: ['heat', 'heat', 'heat', 'clear', 'heat', 'overcast'],
      autumn: ['clear', 'heat', 'clear', 'overcast', 'clear', 'clear']
    },
    tropical: {
      winter: ['clear', 'rain', 'overcast', 'clear', 'rain', 'heat'],
      spring: ['rain', 'rain', 'mud', 'overcast', 'heat', 'clear'],
      summer: ['rain', 'mud', 'mud', 'rain', 'storm', 'overcast'],
      autumn: ['rain', 'rain', 'mud', 'overcast', 'clear', 'storm']
    },
    ocean: {
      winter: ['storm', 'overcast', 'rain', 'storm', 'overcast', 'clear'],
      spring: ['overcast', 'rain', 'clear', 'overcast', 'storm', 'clear'],
      summer: ['clear', 'clear', 'overcast', 'clear', 'rain', 'overcast'],
      autumn: ['rain', 'storm', 'overcast', 'rain', 'clear', 'overcast']
    }
  };

  function dayOfWar(state) { return Math.floor(state.time / 24); }

  function dateOf(state) {
    var d = new Date(START + dayOfWar(state) * 86400000);
    return { day: d.getUTCDate(), month: d.getUTCMonth(), year: d.getUTCFullYear() };
  }

  /** The day of the war a calendar date falls on. */
  function dayOfDate(year, month, day) {
    return Math.round((Date.UTC(year, month, day) - START) / 86400000);
  }

  function formatDate(state) {
    var d = dateOf(state);
    return d.day + ' ' + MONTHS[d.month] + ' ' + d.year;
  }

  function shortDate(state) {
    var d = dateOf(state);
    return d.day + ' ' + MONTHS[d.month].slice(0, 3);
  }

  /** Southern-hemisphere provinces run six months out of step. */
  function seasonAt(month, lat) {
    var m = lat < 0 ? (month + 6) % 12 : month;
    if (m === 11 || m <= 1) return 'winter';
    if (m <= 4) return 'spring';
    if (m <= 7) return 'summer';
    return 'autumn';
  }

  function season(state, prov) {
    return seasonAt(dateOf(state).month, prov ? prov.lat : 45);
  }

  function climateOf(prov) {
    if (prov.isSea) return 'ocean';
    var a = Math.abs(prov.lat);
    // Height stands in for latitude: a mountain range has a polar winter.
    if (prov.terrain === 'mountain' && a > 28) return 'polar';
    if (prov.terrain === 'desert') return 'arid';
    if (a >= 60 || prov.terrain === 'tundra' || prov.terrain === 'taiga') return 'polar';
    if (a < 23) return 'tropical';
    return 'temperate';
  }

  /*
   * Weather cells are wide, so a front covers a region rather than a province,
   * and the grid they are cut on drifts eastward day by day.  Without the drift
   * the same rectangles reappear every morning and the map reads as a grid
   * rather than as weather.
   */
  function cellOf(prov, day) {
    var drift = (day * 3.7) % 12;
    return Math.floor((prov.lon + 180 + drift) / 12) * 64 +
      Math.floor((prov.lat + 90 + drift * 0.4) / 10);
  }

  function roll(seed, day, cell) {
    var h = (Math.imul(seed ^ cell, 374761393) + Math.imul(day, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function refresh(state) {
    var seed = state.weatherSeed !== undefined
      ? state.weatherSeed
      : (state.weatherSeed = IA.hashString(String(state.seed)) >>> 0);
    var day = dayOfWar(state);
    var month = dateOf(state).month;
    var cache = {};
    for (var i = 0; i < state.provinces.length; i++) {
      var prov = state.provinces[i];
      if (prov.size === 0) continue;
      var climate = climateOf(prov);
      var cell = cellOf(prov, day);
      var key = climate + '|' + cell + '|' + (prov.lat < 0 ? 's' : 'n');
      var w = cache[key];
      if (w === undefined) {
        var draws = DRAWS[climate][seasonAt(month, prov.lat)];
        w = cache[key] = draws[Math.floor(roll(seed, day, cell + climate.length * 7919) * draws.length)];
      }
      prov.weather = w;
    }
  }

  function of(prov) { return WEATHER[prov && prov.weather] || WEATHER.clear; }

  IA.weather = {
    refresh: refresh, of: of, WEATHER: WEATHER,
    dateOf: dateOf, dayOfDate: dayOfDate, formatDate: formatDate, shortDate: shortDate,
    season: season, seasonAt: seasonAt, climateOf: climateOf, dayOfWar: dayOfWar
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
