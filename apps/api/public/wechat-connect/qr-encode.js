/**
 * Byte-mode QR encoder (ECC level M), versions 1–15 → SVG.
 * Written for the TOMEET multi-user kiosk; no external dependency.
 */
(function (global) {
  "use strict";

  // [dataCodewords, eccPerBlock, blocksGroup1, dataPerBlock1, blocksGroup2, dataPerBlock2]
  const M = {
    1: [16, 10, 1, 16, 0, 0],
    2: [28, 16, 1, 28, 0, 0],
    3: [44, 26, 1, 44, 0, 0],
    4: [64, 18, 2, 32, 0, 0],
    5: [86, 24, 2, 43, 0, 0],
    6: [108, 16, 4, 27, 0, 0],
    7: [124, 18, 4, 31, 0, 0],
    8: [154, 22, 2, 38, 2, 39],
    9: [182, 22, 3, 36, 2, 37],
    10: [216, 26, 4, 43, 1, 44],
    11: [254, 30, 1, 50, 4, 51],
    12: [290, 22, 6, 36, 2, 37],
    13: [334, 22, 8, 37, 1, 38],
    14: [365, 24, 4, 40, 5, 41],
    15: [415, 24, 5, 41, 5, 42]
  };

  const ALIGN = {
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
    11: [6, 30, 54],
    12: [6, 32, 58],
    13: [6, 34, 62],
    14: [6, 26, 46, 66],
    15: [6, 26, 48, 70]
  };

  // Format bits for ECC=M (01), masks 0–7
  const FORMAT = [
    0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0
  ];

  // Version info bits for versions 7–15
  const VERSION_BITS = {
    7: 0x07c94,
    8: 0x085bc,
    9: 0x09a99,
    10: 0x0a4d3,
    11: 0x0bbf6,
    12: 0x0c762,
    13: 0x0d847,
    14: 0x0e60d,
    15: 0x0f928
  };

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, eccLen) {
    const gen = rsGenerator(eccLen);
    const res = new Array(eccLen).fill(0);
    for (const b of data) {
      const factor = b ^ res[0];
      res.shift();
      res.push(0);
      if (!factor) continue;
      for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  function chooseVersion(byteLen) {
    for (let v = 1; v <= 15; v++) {
      const charCountBits = v >= 10 ? 16 : 8;
      const totalBits = 4 + charCountBits + byteLen * 8 + 4;
      if (Math.ceil(totalBits / 8) <= M[v][0]) return v;
    }
    throw new Error("QR content too long for versions 1–15");
  }

  function encodeData(text, version) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const capacity = M[version][0];
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(0b0100, 4);
    push(bytes.length, version >= 10 ? 16 : 8);
    for (const b of bytes) push(b, 8);
    const remaining = capacity * 8 - bits.length;
    push(0, Math.min(4, Math.max(0, remaining)));
    while (bits.length % 8 !== 0) bits.push(0);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      codewords.push(v);
    }
    const pads = [0xec, 0x11];
    for (let i = 0; codewords.length < capacity; i++) codewords.push(pads[i & 1]);
    return codewords;
  }

  function interleave(version, data) {
    const [, eccLen, g1, d1, g2, d2] = M[version];
    const blocks = [];
    let offset = 0;
    for (let i = 0; i < g1; i++) {
      const block = data.slice(offset, offset + d1);
      offset += d1;
      blocks.push({ data: block, ecc: rsEncode(block, eccLen) });
    }
    for (let i = 0; i < g2; i++) {
      const block = data.slice(offset, offset + d2);
      offset += d2;
      blocks.push({ data: block, ecc: rsEncode(block, eccLen) });
    }
    const out = [];
    const maxD = Math.max(d1, d2);
    for (let i = 0; i < maxD; i++) {
      for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    }
    for (let i = 0; i < eccLen; i++) {
      for (const b of blocks) out.push(b.ecc[i]);
    }
    return out;
  }

  function sizeOf(version) {
    return 17 + version * 4;
  }

  function setModule(mod, r, c, val, size) {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mod[r][c] = val;
  }

  function placeFinder(mod, row, col, size) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on =
          r >= 0 &&
          r <= 6 &&
          c >= 0 &&
          c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        mod[rr][cc] = on ? 1 : 0;
      }
    }
  }

  function placeAlign(mod, version, size) {
    const positions = ALIGN[version];
    if (!positions) return;
    for (const r of positions) {
      for (const c of positions) {
        if (mod[r][c] !== null) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const on =
              Math.abs(dr) === 2 ||
              Math.abs(dc) === 2 ||
              (dr === 0 && dc === 0);
            setModule(mod, r + dr, c + dc, on ? 1 : 0, size);
          }
        }
      }
    }
  }

  function placeTiming(mod, size) {
    for (let i = 8; i < size - 8; i++) {
      if (mod[6][i] === null) mod[6][i] = i % 2 === 0 ? 1 : 0;
      if (mod[i][6] === null) mod[i][6] = i % 2 === 0 ? 1 : 0;
    }
  }

  function reserveFormatAreas(mod, size) {
    for (let i = 0; i < 9; i++) {
      if (mod[8][i] === null) mod[8][i] = 0;
      if (mod[i][8] === null) mod[i][8] = 0;
    }
    for (let i = 0; i < 8; i++) {
      if (mod[8][size - 1 - i] === null) mod[8][size - 1 - i] = 0;
      if (mod[size - 1 - i][8] === null) mod[size - 1 - i][8] = 0;
    }
  }

  function reserveVersionAreas(mod, version, size) {
    if (version < 7) return;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        if (mod[i][size - 11 + j] === null) mod[i][size - 11 + j] = 0;
        if (mod[size - 11 + j][i] === null) mod[size - 11 + j][i] = 0;
      }
    }
  }

  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function placeData(mod, size, data, mask) {
    let bit = 0;
    const total = data.length * 8;
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i;
        for (let j = 0; j < 2; j++) {
          const c = col - j;
          if (mod[row][c] !== null) continue;
          let dark = 0;
          if (bit < total) {
            dark = (data[bit >> 3] >> (7 - (bit & 7))) & 1;
            bit++;
          }
          if (maskBit(mask, row, c)) dark ^= 1;
          mod[row][c] = dark;
        }
      }
      up = !up;
    }
  }

  function placeFormat(mod, size, mask) {
    const bits = FORMAT[mask];
    const positions = [
      // bit 0..14 → module coordinates around finders
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    const positions2 = [
      [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
      [size - 5, 8], [size - 6, 8], [size - 7, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
      [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
    ];
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> (14 - i)) & 1;
      mod[positions[i][0]][positions[i][1]] = bit;
      mod[positions2[i][0]][positions2[i][1]] = bit;
    }
    mod[size - 8][8] = 1;
  }

  function placeVersion(mod, version, size) {
    if (version < 7) return;
    const bits = VERSION_BITS[version];
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      mod[r][c] = bit;
      mod[c][r] = bit;
    }
  }

  function penalty(mod, size) {
    let score = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (mod[r][c] === mod[r][c - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (mod[r][c] === mod[r - 1][c]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
    let dark = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (mod[r][c]) dark++;
        if (r < size - 1 && c < size - 1) {
          const s =
            mod[r][c] + mod[r][c + 1] + mod[r + 1][c] + mod[r + 1][c + 1];
          if (s === 0 || s === 4) score += 3;
        }
      }
    }
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function buildMatrix(text) {
    const bytes = new TextEncoder().encode(text);
    const version = chooseVersion(bytes.length);
    const data = interleave(version, encodeData(text, version));
    const size = sizeOf(version);
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const mod = Array.from({ length: size }, () => Array(size).fill(null));
      placeFinder(mod, 0, 0, size);
      placeFinder(mod, 0, size - 7, size);
      placeFinder(mod, size - 7, 0, size);
      placeAlign(mod, version, size);
      placeTiming(mod, size);
      reserveFormatAreas(mod, size);
      reserveVersionAreas(mod, version, size);
      placeData(mod, size, data, mask);
      placeFormat(mod, size, mask);
      placeVersion(mod, version, size);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) if (mod[r][c] === null) mod[r][c] = 0;
      }
      const score = penalty(mod, size);
      if (score < bestScore) {
        bestScore = score;
        best = mod;
      }
    }
    return best;
  }

  function toSvg(text, modulePx = 6, margin = 3) {
    const mod = buildMatrix(text);
    const n = mod.length;
    const dim = (n + margin * 2) * modulePx;
    let body = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!mod[r][c]) continue;
        body += `<rect x="${(c + margin) * modulePx}" y="${(r + margin) * modulePx}" width="${modulePx}" height="${modulePx}"/>`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="100%" height="100%" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><g fill="#111111">${body}</g></svg>`;
  }

  function renderInto(el, text) {
    el.innerHTML = toSvg(text);
  }

  global.TomeetQr = { toSvg, renderInto, buildMatrix };
})(typeof window !== "undefined" ? window : globalThis);
