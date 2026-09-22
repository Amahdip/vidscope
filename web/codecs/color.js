// Code points shared by video codecs and containers (ITU-T H.273 / ISO/IEC 23091-2).

export const COLOUR_PRIMARIES = {
  0: 'reserved',
  1: 'BT.709',
  2: 'unspecified',
  4: 'BT.470 System M',
  5: 'BT.470 System B/G (BT.601 625-line)',
  6: 'SMPTE 170M (BT.601 525-line)',
  7: 'SMPTE 240M',
  8: 'Generic film',
  9: 'BT.2020 / BT.2100',
  10: 'SMPTE ST 428-1 (CIE XYZ)',
  11: 'SMPTE RP 431-2 (DCI-P3)',
  12: 'SMPTE EG 432-1 (Display P3)',
  22: 'EBU Tech 3213-E',
};

export const TRANSFER_CHARACTERISTICS = {
  0: 'reserved',
  1: 'BT.709',
  2: 'unspecified',
  4: 'Gamma 2.2 (BT.470 System M)',
  5: 'Gamma 2.8 (BT.470 System B/G)',
  6: 'SMPTE 170M (BT.601)',
  7: 'SMPTE 240M',
  8: 'Linear',
  9: 'Logarithmic 100:1',
  10: 'Logarithmic 316:1',
  11: 'IEC 61966-2-4 (xvYCC)',
  12: 'BT.1361',
  13: 'IEC 61966-2-1 (sRGB)',
  14: 'BT.2020 (10-bit)',
  15: 'BT.2020 (12-bit)',
  16: 'SMPTE ST 2084 (PQ, HDR10)',
  17: 'SMPTE ST 428-1',
  18: 'ARIB STD-B67 (HLG)',
};

export const MATRIX_COEFFICIENTS = {
  0: 'Identity (RGB / GBR)',
  1: 'BT.709',
  2: 'unspecified',
  4: 'FCC 73.682',
  5: 'BT.470 System B/G (BT.601 625-line)',
  6: 'SMPTE 170M (BT.601 525-line)',
  7: 'SMPTE 240M',
  8: 'YCgCo',
  9: 'BT.2020 non-constant luminance',
  10: 'BT.2020 constant luminance',
  11: 'SMPTE ST 2085',
  12: 'Chromaticity-derived non-constant luminance',
  13: 'Chromaticity-derived constant luminance',
  14: 'ICtCp',
};

export const VIDEO_FORMAT = { 0: 'Component', 1: 'PAL', 2: 'NTSC', 3: 'SECAM', 4: 'MAC', 5: 'Unspecified' };

export const CHROMA_FORMAT = { 0: '4:0:0 (monochrome)', 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' };

/** Sample aspect ratio presets (H.264 Table E-1, H.265 Table E-1). */
export const ASPECT_RATIO_IDC = {
  0: 'unspecified', 1: '1:1', 2: '12:11', 3: '10:11', 4: '16:11', 5: '40:33', 6: '24:11', 7: '20:11',
  8: '32:11', 9: '80:33', 10: '18:11', 11: '15:11', 12: '64:33', 13: '160:99', 14: '4:3', 15: '3:2',
  16: '2:1', 255: 'Extended_SAR (explicit width and height follow)',
};

export const SAR_VALUES = {
  1: [1, 1], 2: [12, 11], 3: [10, 11], 4: [16, 11], 5: [40, 33], 6: [24, 11], 7: [20, 11], 8: [32, 11],
  9: [80, 33], 10: [18, 11], 11: [15, 11], 12: [64, 33], 13: [160, 99], 14: [4, 3], 15: [3, 2], 16: [2, 1],
};

/** Short human summary such as "BT.709" or "BT.2020 / PQ (HDR10)". */
export function colourSummary(primaries, transfer, matrix) {
  const p = COLOUR_PRIMARIES[primaries];
  const t = TRANSFER_CHARACTERISTICS[transfer];
  if (transfer === 16) return `${p ?? `primaries ${primaries}`}, PQ (HDR10)`;
  if (transfer === 18) return `${p ?? `primaries ${primaries}`}, HLG`;
  if (primaries === 1 && transfer === 1 && matrix === 1) return 'BT.709 (SDR)';
  return [p, t, MATRIX_COEFFICIENTS[matrix]].filter(Boolean).join(' / ');
}
