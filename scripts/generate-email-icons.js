'use strict';

/**
 * Rasterize the email icon set — Heroicons v2 **solid** glyphs → PNG. Email clients strip SVG,
 * so branded emails embed these as CID attachments. Solid (filled) glyphs read as far more
 * professional at small sizes than thin outlines. Badge icons are white (on the accent badge);
 * panel icons are slate (in the light "visit us" panel). Re-run after editing:
 *   node scripts/generate-email-icons.js
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SOLID = path.join(__dirname, '..', 'node_modules', 'heroicons', '24', 'solid');
const OUT = path.join(__dirname, '..', 'assets', 'email-icons');

// campaign badge → heroicon name (white, on accent badge)
const BADGES = { cake: 'cake', 'calendar-days': 'calendar-days', heart: 'heart', bell: 'bell' };
// info-panel → heroicon name (slate, in light chip)
const PANEL = { 'map-pin': 'map-pin', phone: 'phone' };

function loadSvg(name, color) {
  const raw = fs.readFileSync(path.join(SOLID, `${name}.svg`), 'utf8');
  return raw.replace(/fill="currentColor"/g, `fill="${color}"`);
}

async function render(name, color, size, outName) {
  const svg = Buffer.from(loadSvg(name, color));
  // Pad ~14% so the glyph doesn't touch the badge edge; density gives crisp retina output.
  const pad = Math.round(size * 0.14);
  await sharp(svg, { density: 384 })
    .resize(size - pad * 2, size - pad * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(OUT, outName));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = [];
  for (const [key, icon] of Object.entries(BADGES)) jobs.push(render(icon, '#ffffff', 120, `${key}-white.png`));
  for (const [key, icon] of Object.entries(PANEL)) jobs.push(render(icon, '#64748b', 72, `${key}-slate.png`));
  await Promise.all(jobs);
  for (const f of fs.readdirSync(OUT)) console.log('  ', f, fs.statSync(path.join(OUT, f)).size, 'bytes');
  console.log('✓ Heroicons-solid email icons →', OUT);
})();
