import sharp from 'sharp';
import { mkdirSync, copyFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
// Source icon SVG is not tracked in this repo — pass its path as the first
// CLI arg (node scripts/generate-icons.mjs path/to/icon.svg) or via the
// SIGNET_ICON_SOURCE env var. Ask whoever owns the brand assets for the file.
const svgSourceArg = process.argv[2] || process.env.SIGNET_ICON_SOURCE;
if (!svgSourceArg) {
  console.error('Usage: node scripts/generate-icons.mjs <path-to-source-icon.svg>');
  console.error('(or set SIGNET_ICON_SOURCE)');
  process.exit(1);
}
const svgSource = resolve(process.cwd(), svgSourceArg);
const outDir = resolve(root, 'public', 'icons');

mkdirSync(outDir, { recursive: true });

const svg = readFileSync(svgSource);

// Standard icons: shield fills the canvas
async function generateIcon(size, filename) {
  await sharp(svg)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(resolve(outDir, filename));
}

// Maskable icon: shield at 80% on white background (safe zone)
async function generateMaskable(size, filename) {
  const innerSize = Math.round(size * 0.7);
  const innerSvg = await sharp(svg)
    .resize(innerSize, innerSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  })
    .composite([{ input: innerSvg, gravity: 'centre' }])
    .png()
    .toFile(resolve(outDir, filename));
}

await generateIcon(192, 'icon-192.png');
await generateIcon(512, 'icon-512.png');
await generateIcon(180, 'apple-touch-icon.png');
await generateMaskable(512, 'icon-512-maskable.png');

// Favicon: 32x32 PNG (modern browsers accept PNG favicons)
await generateIcon(32, 'favicon-32.png');

// Convert 32x32 PNG to ICO format (single-size ICO)
const png32 = await sharp(svg)
  .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

// Write as PNG — browsers accept .ico containing PNG for sizes >= 32
// ICO header: 6 bytes header + 16 bytes entry + PNG data
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);     // reserved
icoHeader.writeUInt16LE(1, 2);     // type: ICO
icoHeader.writeUInt16LE(1, 4);     // count: 1

const icoEntry = Buffer.alloc(16);
icoEntry.writeUInt8(32, 0);        // width
icoEntry.writeUInt8(32, 1);        // height
icoEntry.writeUInt8(0, 2);         // colour palette
icoEntry.writeUInt8(0, 3);         // reserved
icoEntry.writeUInt16LE(1, 4);      // colour planes
icoEntry.writeUInt16LE(32, 6);     // bits per pixel
icoEntry.writeUInt32LE(png32.length, 8);  // data size
icoEntry.writeUInt32LE(22, 12);    // data offset (6 + 16)

const { writeFileSync } = await import('fs');
writeFileSync(resolve(root, 'public', 'favicon.ico'), Buffer.concat([icoHeader, icoEntry, png32]));

// Copy SVG as favicon.svg
copyFileSync(svgSource, resolve(root, 'public', 'favicon.svg'));

// Clean up temp file
const { unlinkSync } = await import('fs');
try { unlinkSync(resolve(outDir, 'favicon-32.png')); } catch {}

console.log('Icons generated:');
console.log('  public/icons/icon-192.png');
console.log('  public/icons/icon-512.png');
console.log('  public/icons/icon-512-maskable.png');
console.log('  public/icons/apple-touch-icon.png');
console.log('  public/favicon.ico');
console.log('  public/favicon.svg');
