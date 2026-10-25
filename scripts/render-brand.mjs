// Renders the SVG brand assets to PNG (PWA icons, Apple touch icon, PDF/email use).
// Usage: node scripts/render-brand.mjs
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const pub = new URL('../web/public/', import.meta.url);
const render = (svgFile, outFile, width, opts = {}) => {
  let svg = readFileSync(new URL(svgFile, pub), 'utf8');
  if (opts.padForMaskable) {
    // Maskable icons need a safe zone: place the mark at 80% on a full-bleed brand background.
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#1e2e6f"/><g transform="translate(8 8)">${svg.replace(/<\?xml[^>]*>/, '').replace(/<svg[^>]*>/, '').replace('</svg>', '')}</g></svg>`;
  }
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' }, background: opts.background }).render().asPng();
  writeFileSync(new URL(outFile, pub), png);
  console.log(`  ${outFile} (${width}px, ${png.length} bytes)`);
};

render('brand/logo-mark.svg', 'icon-192.png', 192);
render('brand/logo-mark.svg', 'icon-512.png', 512);
render('brand/logo-mark.svg', 'apple-touch-icon.png', 180);
render('brand/logo-mark.svg', 'icon-maskable-512.png', 512, { padForMaskable: true });
render('brand/logo-mark.svg', 'brand/logo-mark.png', 256);
render('brand/logo.svg', 'brand/logo.png', 960, { background: 'rgba(255,255,255,0)' });
render('brand/logo-on-dark.svg', 'brand/logo-on-dark.png', 960);
