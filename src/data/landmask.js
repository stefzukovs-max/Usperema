/*
 * Coarse equirectangular land mask of Earth.
 *
 * The world is described at 64x32 resolution as horizontal runs of land per
 * row.  Column c covers longitude -180 + c * 5.625 degrees, row r covers
 * latitude 90 - r * 5.625 degrees.  Runs are inclusive [startCol, endCol].
 *
 * Storing ranges rather than an ASCII picture keeps the data readable and
 * makes miscounted columns impossible.  worldgen.js upsamples and smooths
 * this into the playable grid.
 */
(function (global) {
  'use strict';

  var COLS = 64;
  var ROWS = 32;

  // row: [ [startCol, endCol], ... ]
  var RUNS = {
    1: [[12, 17], [21, 27], [34, 35]],
    2: [[10, 19], [21, 28], [34, 35], [49, 51]],
    3: [[4, 7], [8, 16], [22, 28], [35, 37], [38, 63]],
    4: [[3, 7], [8, 21], [23, 25], [28, 29], [33, 37], [38, 63]],
    5: [[3, 7], [8, 22], [30, 31], [33, 37], [38, 63]],
    6: [[9, 22], [30, 32], [33, 37], [38, 62]],
    7: [[10, 21], [31, 37], [38, 58], [57, 58]],
    8: [[10, 19], [30, 40], [41, 56], [56, 57]],
    9: [[11, 19], [30, 40], [41, 55], [55, 57]],
    10: [[12, 18], [30, 38], [39, 54]],
    11: [[12, 16], [18, 19], [29, 38], [39, 53]],
    12: [[13, 17], [29, 39], [44, 48], [49, 52]],
    13: [[15, 17], [29, 40], [44, 47], [49, 51]],
    14: [[17, 20], [30, 40], [46, 46], [49, 51], [53, 54]],
    15: [[18, 23], [33, 40], [49, 53]],
    16: [[18, 24], [33, 40], [50, 56]],
    17: [[19, 25], [34, 40], [52, 59]],
    18: [[19, 25], [34, 40], [54, 58]],
    19: [[19, 25], [34, 40], [40, 41], [52, 59]],
    20: [[20, 24], [34, 38], [52, 59]],
    21: [[19, 23], [35, 38], [52, 59]],
    22: [[19, 22], [53, 58], [62, 63]],
    23: [[19, 21], [61, 63]],
    24: [[19, 20]],
    25: [[19, 20]]
  };

  /** @return {Float32Array} COLS*ROWS coverage values in [0,1]. */
  function baseField() {
    var f = new Float32Array(COLS * ROWS);
    for (var r in RUNS) {
      if (!Object.prototype.hasOwnProperty.call(RUNS, r)) continue;
      var runs = RUNS[r];
      for (var i = 0; i < runs.length; i++) {
        for (var c = runs[i][0]; c <= runs[i][1]; c++) {
          if (c < 0 || c >= COLS) continue;
          f[(+r) * COLS + c] = 1;
        }
      }
    }
    return f;
  }

  global.SWW = global.SWW || {};
  global.SWW.LandMask = { COLS: COLS, ROWS: ROWS, RUNS: RUNS, baseField: baseField };
})(typeof globalThis !== 'undefined' ? globalThis : this);
