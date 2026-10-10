// A QR code as one SVG path, drawn by the page rather than parsed from a string of markup.

import qrcode from 'qrcode-generator';

export interface QrCode {
  /** Modules on a side. */
  size: number;
  /** One unit square per dark module, in a `size` × `size` view box. */
  path: string;
}

/** `text` as a QR code at medium error correction, the smallest version that holds it. */
export function qrCode(text: string): QrCode {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++)
      if (code.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`;
  return { size, path };
}
