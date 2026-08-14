/*
 * The unit icon set.
 *
 * Every icon is drawn here as canvas commands — there is no image, no font and
 * no emoji anywhere in it.  Emoji were what the game shipped with, and they are
 * the wrong thing twice over: they render differently on every platform, and a
 * chess pawn does not read as a battalion of infantry.
 *
 * The set is drawn in the flat, heavy silhouette style of a military map
 * symbol: legible at sixteen pixels, single colour, no detail that survives
 * only at large sizes.  Each is drawn into a 1x1 box and scaled by the caller.
 *
 * Icons are rasterised once per size into a small cache, because a stack marker
 * redraws every frame and re-running the path commands sixty times a second for
 * four hundred stacks is not free.
 */
(function (global) {
  'use strict';

  var IA = global.IA = global.IA || {};

  /*
   * Each entry draws into the unit box with the current fillStyle/strokeStyle.
   * Coordinates run 0..1 with a little margin, so nothing touches the edge.
   */
  var DRAW = {
    /** Crossed rifles: the mark of foot. */
    infantry: function (c) {
      c.lineWidth = 0.11;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(0.16, 0.82); c.lineTo(0.84, 0.18);
      c.moveTo(0.84, 0.82); c.lineTo(0.16, 0.18);
      c.stroke();
    },
    /** Crossed rifles with a bar: assault troops. */
    assault: function (c) {
      c.lineWidth = 0.11;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(0.16, 0.82); c.lineTo(0.84, 0.18);
      c.moveTo(0.84, 0.82); c.lineTo(0.16, 0.18);
      c.stroke();
      c.beginPath();
      c.moveTo(0.20, 0.12); c.lineTo(0.80, 0.12);
      c.lineWidth = 0.10;
      c.stroke();
    },
    /** A machine gun on its tripod. */
    machinegun: function (c) {
      c.lineWidth = 0.10;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(0.12, 0.34); c.lineTo(0.86, 0.34);       // barrel
      c.moveTo(0.44, 0.34); c.lineTo(0.24, 0.84);       // legs
      c.moveTo(0.44, 0.34); c.lineTo(0.64, 0.84);
      c.moveTo(0.44, 0.34); c.lineTo(0.46, 0.86);
      c.stroke();
    },
    /** A horse's head and neck, cut to a silhouette. */
    cavalry: function (c) {
      c.beginPath();
      c.moveTo(0.22, 0.86);
      c.lineTo(0.30, 0.48);
      c.quadraticCurveTo(0.36, 0.24, 0.58, 0.18);
      c.lineTo(0.62, 0.06);
      c.lineTo(0.70, 0.20);
      c.quadraticCurveTo(0.86, 0.28, 0.80, 0.46);
      c.quadraticCurveTo(0.72, 0.60, 0.60, 0.60);
      c.lineTo(0.52, 0.86);
      c.closePath();
      c.fill();
    },
    /** A field gun: barrel, wheel and trail. */
    artillery: function (c) {
      c.lineWidth = 0.10;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(0.14, 0.68); c.lineTo(0.86, 0.22);       // barrel
      c.moveTo(0.22, 0.62); c.lineTo(0.22, 0.86);       // trail
      c.stroke();
      c.beginPath();
      c.arc(0.40, 0.68, 0.15, 0, Math.PI * 2);          // wheel
      c.lineWidth = 0.09;
      c.stroke();
    },
    /** A heavy gun: the same, squatter, with a second wheel. */
    siege: function (c) {
      c.lineWidth = 0.12;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(0.10, 0.62); c.lineTo(0.90, 0.28);
      c.stroke();
      c.lineWidth = 0.09;
      c.beginPath(); c.arc(0.32, 0.72, 0.16, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(0.66, 0.74, 0.12, 0, Math.PI * 2); c.stroke();
    },
    /** A tracked hull with a gun: the landship. */
    tank: function (c) {
      c.beginPath();
      c.moveTo(0.10, 0.72);
      c.quadraticCurveTo(0.10, 0.50, 0.28, 0.46);
      c.lineTo(0.72, 0.46);
      c.quadraticCurveTo(0.90, 0.50, 0.90, 0.72);
      c.quadraticCurveTo(0.90, 0.84, 0.74, 0.84);
      c.lineTo(0.26, 0.84);
      c.quadraticCurveTo(0.10, 0.84, 0.10, 0.72);
      c.closePath();
      c.fill();
      c.beginPath();                                    // turret and barrel
      c.rect(0.38, 0.28, 0.26, 0.18);
      c.fill();
      c.lineWidth = 0.08;
      c.beginPath();
      c.moveTo(0.64, 0.36); c.lineTo(0.92, 0.36);
      c.stroke();
    },
    /** A boxed body on wheels: the armoured car. */
    armouredcar: function (c) {
      c.beginPath();
      c.moveTo(0.12, 0.66);
      c.lineTo(0.30, 0.40);
      c.lineTo(0.72, 0.40);
      c.lineTo(0.88, 0.66);
      c.lineTo(0.88, 0.74);
      c.lineTo(0.12, 0.74);
      c.closePath();
      c.fill();
      c.beginPath(); c.arc(0.30, 0.78, 0.12, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(0.70, 0.78, 0.12, 0, Math.PI * 2); c.fill();
    },
    /** A biplane seen from above. */
    plane: function (c) {
      c.beginPath();
      c.moveTo(0.50, 0.08);                             // nose
      c.lineTo(0.58, 0.34);
      c.lineTo(0.94, 0.50);                             // wing
      c.lineTo(0.94, 0.60);
      c.lineTo(0.56, 0.56);
      c.lineTo(0.54, 0.76);
      c.lineTo(0.74, 0.86);                             // tailplane
      c.lineTo(0.74, 0.92);
      c.lineTo(0.50, 0.88);
      c.lineTo(0.26, 0.92);
      c.lineTo(0.26, 0.86);
      c.lineTo(0.46, 0.76);
      c.lineTo(0.44, 0.56);
      c.lineTo(0.06, 0.60);
      c.lineTo(0.06, 0.50);
      c.lineTo(0.42, 0.34);
      c.closePath();
      c.fill();
    },
    /** A ship's hull with a funnel. */
    ship: function (c) {
      c.beginPath();
      c.moveTo(0.06, 0.58);
      c.lineTo(0.94, 0.58);
      c.lineTo(0.80, 0.80);
      c.lineTo(0.20, 0.80);
      c.closePath();
      c.fill();
      c.beginPath();
      c.rect(0.44, 0.30, 0.14, 0.28);                   // funnel
      c.fill();
      c.lineWidth = 0.07;
      c.beginPath();
      c.moveTo(0.30, 0.50); c.lineTo(0.30, 0.20);       // mast
      c.stroke();
    },
    /** A heavier hull with turrets: the capital ship. */
    dreadnought: function (c) {
      c.beginPath();
      c.moveTo(0.04, 0.56);
      c.lineTo(0.96, 0.56);
      c.lineTo(0.82, 0.80);
      c.lineTo(0.18, 0.80);
      c.closePath();
      c.fill();
      c.beginPath(); c.rect(0.24, 0.42, 0.14, 0.14); c.fill();
      c.beginPath(); c.rect(0.62, 0.42, 0.14, 0.14); c.fill();
      c.beginPath(); c.rect(0.44, 0.22, 0.12, 0.34); c.fill();
    },
    /** A submerged hull and a conning tower. */
    submarine: function (c) {
      c.beginPath();
      c.moveTo(0.08, 0.66);
      c.quadraticCurveTo(0.50, 0.50, 0.92, 0.66);
      c.quadraticCurveTo(0.50, 0.86, 0.08, 0.66);
      c.closePath();
      c.fill();
      c.beginPath();
      c.rect(0.44, 0.40, 0.12, 0.20);
      c.fill();
      c.lineWidth = 0.06;
      c.beginPath();
      c.moveTo(0.50, 0.40); c.lineTo(0.50, 0.24);       // periscope
      c.stroke();
    },
    /** A blunt hull: the transport. */
    transport: function (c) {
      c.beginPath();
      c.moveTo(0.08, 0.54);
      c.lineTo(0.92, 0.54);
      c.lineTo(0.84, 0.80);
      c.lineTo(0.16, 0.80);
      c.closePath();
      c.fill();
      c.beginPath();
      c.rect(0.34, 0.34, 0.32, 0.20);                   // deck cargo
      c.fill();
    }
  };

  /* Which drawing each unit type uses. */
  var FOR_UNIT = {
    line_infantry: 'infantry',
    guard_infantry: 'infantry',
    assault_infantry: 'assault',
    machine_gun: 'machinegun',
    cavalry: 'cavalry',
    scout_cavalry: 'cavalry',
    trench_mortar: 'artillery',
    field_artillery: 'artillery',
    heavy_artillery: 'siege',
    armoured_car: 'armouredcar',
    tank: 'tank',
    recon_plane: 'plane',
    fighter: 'plane',
    bomber: 'plane',
    transport: 'transport',
    destroyer: 'ship',
    cruiser: 'ship',
    submarine: 'submarine',
    dreadnought: 'dreadnought'
  };

  /* Fallbacks, so a unit added later still gets something sensible. */
  var FOR_CAT = { inf: 'infantry', arm: 'tank', air: 'plane', sea: 'ship' };

  function nameFor(typeId) {
    if (FOR_UNIT[typeId]) return FOR_UNIT[typeId];
    var type = IA.UnitData.BY_ID[typeId];
    return (type && FOR_CAT[type.cat]) || 'infantry';
  }

  /** Draw an icon straight into a context, in a box of `size` at `x`,`y`. */
  function paint(ctx, name, x, y, size, colour) {
    var draw = DRAW[name] || DRAW.infantry;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size, size);
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    ctx.lineJoin = 'round';
    draw(ctx);
    ctx.restore();
  }

  /*
   * Rasterised icons, keyed by shape, size and colour.  A stack marker redraws
   * every frame; running a dozen path commands per marker per frame for four
   * hundred stacks is exactly the sort of thing that costs a phone its frame.
   */
  var cache = {};
  var cacheKeys = [];
  var CACHE_LIMIT = 160;

  function sprite(name, size, colour) {
    var px = Math.max(4, Math.round(size));
    var key = name + '|' + px + '|' + colour;
    var hit = cache[key];
    if (hit) return hit;
    var canvas = global.document.createElement('canvas');
    canvas.width = px; canvas.height = px;
    paint(canvas.getContext('2d'), name, 0, 0, px, colour);
    cache[key] = canvas;
    cacheKeys.push(key);
    if (cacheKeys.length > CACHE_LIMIT) delete cache[cacheKeys.shift()];
    return canvas;
  }

  /** Blit the icon for a unit type, centred on `cx`,`cy`. */
  function drawUnit(ctx, typeId, cx, cy, size, colour) {
    var img = sprite(nameFor(typeId), size, colour);
    ctx.drawImage(img, Math.round(cx - img.width / 2), Math.round(cy - img.height / 2));
  }

  /** An icon as a data URL, for the DOM side of the interface. */
  function dataUrl(typeId, size, colour) {
    return sprite(nameFor(typeId), size || 24, colour || '#ece3cd').toDataURL();
  }

  IA.icons = {
    DRAW: DRAW, FOR_UNIT: FOR_UNIT,
    nameFor: nameFor, paint: paint, sprite: sprite,
    drawUnit: drawUnit, dataUrl: dataUrl,
    names: function () { return Object.keys(DRAW); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
