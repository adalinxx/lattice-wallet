// Deterministic vector exports. Run: node scripts/render-selfhold-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
const master = readFileSync('public/assets/selfhold-mark.svg', 'utf8');
const geometry = master.match(/<g id="mark"[^>]*>([\s\S]*?)<\/g>/)[1];
mkdirSync('docs/brand', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  // At the two smallest sizes, open the key shaft and enlarge its center.
  const shape = size <= 32 ? geometry.replace('H166', 'H168').replaceAll('136', '132').replaceAll('168', '172').replace('r="21"', 'r="24"') : geometry;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><rect x="4" y="4" width="312" height="312" rx="68" fill="#101112" stroke="#85878a" stroke-width="8"/><g fill="#fff" transform="translate(38 38) scale(.76)">${shape}</g></svg>`;
  writeFileSync(`public/assets/selfhold-icon-${size}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
  if (size === 128) writeFileSync('docs/brand/selfhold-icon.svg', svg + '\n');
}
const plain = master.replace(/<style>[\s\S]*?<\/style>/, '').replace('class="ink"', 'fill="#101112"');
writeFileSync('docs/brand/selfhold-mark.png', new Resvg(plain, { fitTo: { mode: 'width', value: 640 } }).render().asPng());
console.log('Rendered Selfhold master and 16/32/48/128px icons.');
