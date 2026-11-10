/* =====================================================================================================================
   Hummingbolt - hb.js: the page logic for every page, and FLEDGE, the feather engine (home and values).

   A field of tiny feathers lives behind the page. It re-forms into a different shape for every section, the camera
   glides between them, and feathers ruffle where a pointer or finger passes. Now and then the same feathers gather into
   Flux, a faceted hummingbird: it visits, hovers, plays, then lets go and falls back into the formation. A tap or a
   click on an empty part of the page summons it. On the text pages (privacy, legal, not found) the same wingpath is
   drawn once, still, as a backdrop.

   Layout of this script (each block depends only on the ones above it):
     0. TOKENS ................. the brand colours (Anna's, light and dark) for the page and the scene, and the mascot
     1. environment ............ flags, tiers, small maths helpers
     2. FORMATIONS ............. the shapes, as data: shader kind + params, camera, light, colour
     3. PATHS .................. curves sampled on the CPU and handed to the GPU as a texture (the wingpath, card outlines)
     4. page ................... loader, menu, copy button, theme, section tracking
     5. flow ................... which formation the feathers are leaving and which they are joining (per-feather stagger)
     6. camera ................. a critically damped spring per channel; lens shift keeps the form clear of the text
     7. ruffle ................. pointer and touch become a world-space ray, a velocity and a strength
     7b. THE BIRD .............. a faceted hummingbird mesh, posed on the CPU each frame; a director per section says
                                 whether the feathers are a formation or a bird, where it is and what it does
     8. GL ..................... transform-feedback simulation + instanced feather draw
     9. still / poster ......... reduced motion (GL still frames) and no-WebGL (a Canvas 2D still)
    10. boot

   Per feather, the GPU keeps 6 x vec4 (96 bytes), ping-ponged through transform feedback:
     P = position.xyz, ruffle      V = velocity.xyz, roll (spin)      F = shaft direction.xyz, visibility
     N = vane normal.xyz, glint    T = last target.xyz, size          B = bird: progress, goal, eased progress, lock
   and 2 x vec4 that never change: its own spot on the bird (triangle, barycentric coordinates, body part), its turn in
   the bird subset and its place in the assembly wave (beak first).
   Every frame each feather asks its formation(s) for a target frame {position, shaft, normal, presence, size, glint},
   blends the leaving and joining formation with its own delay, blends that toward its spot on the bird by its own bird
   progress, and follows the target on a spring (locked to the bird once it has arrived).

   Nothing here talks to a server: no requests, no cookies. The one thing kept is the light/dark choice, in this
   browser's localStorage ('hb-theme'), and only once the visitor uses the switch.
   ===================================================================================================================== */
(() => {
'use strict';

/* ================= 0. TOKENS =================
   The one source for every colour in the scene, and the mascot's name. ANNA'S: the hummingbird that lives in the Bay
   Area all year - a rose-pink gorget over a bronze-green body.
   Per mode: page (bg, surface, text, text2, muted, hair, hair2, accent, accent2, focus), feathers at rest (shade, lit,
   sheen, and an alt tone for a share of them), the structural-colour flash (four stops, low to high), the ground's faint
   lift, and the bird's parts. Every text pairing meets WCAG AA in both modes.
   The page tokens are mirrored as CSS custom properties in hb.css (a stylesheet cannot be written from here under the
   site's Content Security Policy); keep the two in step. */
const MASCOT_NAME = 'Flux';
const TOKENS = {
  name: "Anna's",
  dark: { bg: '#082725', surface: '#11312F', text: '#F5F1E8', text2: '#C8DBD0', muted: '#ABCBBC', hair: '#274340', hair2: '#44625B', accent: '#FF99BF', accent2: '#B6DB66', focus: '#FF98C2',
    feather: { shade: '#064C38', lit: '#88A83D', sheen: '#D4D26C', alt: '#BF5883', altShare: 0 }, flash: ['#4FCE74', '#F5D24F', '#F44094', '#FFB0DC'], lift: '#0F3B33',
    bird: { back: '#6F9436', gorget: '#421326', belly: '#C8CDBB', wing: '#4B503D', beak: '#292620', tail: '#385E2F', rim: '#EBE8DA', eye: '#050706', catchlight: '#F6F2EA' } },
  light: { bg: '#F8F3EB', surface: '#F0E9DE', text: '#0C2721', text2: '#2A4339', muted: '#3D564B', hair: '#DDD9CE', hair2: '#BEBFB1', accent: '#A30C5A', accent2: '#3A7224', focus: '#A30C5A',
    feather: { shade: '#003927', lit: '#4B781A', sheen: '#A8A405', alt: '#AC2263', altShare: 0 }, flash: ['#008D41', '#CB9400', '#CA0069', '#9B0058'], lift: '#FDFAF4',
    bird: { back: '#3A7411', gorget: '#551B33', belly: '#D3D2C0', wing: '#767A66', beak: '#221F1A', tail: '#1E4821', rim: '#122F26', eye: '#060807', catchlight: '#FFFDF8' } }
};

/* ================= 1. environment ================= */
const doc = document, root = doc.documentElement;
const $ = (s, r) => (r || doc).querySelector(s);
const $$ = (s, r) => Array.from((r || doc).querySelectorAll(s));
const mq = q => { try { return window.matchMedia(q); } catch (e) { return { matches: false }; } };
// MediaQueryList.addEventListener is missing on older Safari (addListener only): never let that stop the script
const onMQ = (m, fn) => { try { if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn); } catch (e) {} };
if (!root.lang) root.lang = 'en';
const mqReduce = mq('(prefers-reduced-motion: reduce)');
const mqFine = mq('(hover: hover) and (pointer: fine)');
// touch-first devices: a phone in landscape is still a phone; a tablet starts at the mid count
const coarse = mq('(pointer: coarse)').matches && !mqFine.matches;
const shortSide = Math.min((window.screen && screen.width) || 1e4, (window.screen && screen.height) || 1e4);
const isPhone = mq('(max-width: 700px)').matches || (coarse && shortSide < 600);
const QS = location.search || '';
// test hooks, harmless for visitors: ?nogl shows the no-WebGL still; ?tier=high|mid|phone forces a feather count and
// switches the frame-time downgrade off
const NOGL = /nogl/.test(QS);
const FORCE = (QS.match(/tier=(high|mid|phone)/) || [])[1] || '';
// the live scene runs where the page has its canvas (home, values); elsewhere a still backdrop is drawn, if there is one
const ENGINE = !!doc.getElementById('gl');
const DBG = window.__hb = { mode: 'init', errors: [], tier: '', active: 0, revealed: false, form: '', page: (doc.body && doc.body.getAttribute('data-page')) || '' };
const logErr = m => { if (DBG.errors.length < 24) DBG.errors.push(String(m)); };
let reduce = mqReduce.matches;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, k) => a + (b - a) * k;
const easeInOut = t => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

/* ================= 2. FORMATIONS =================
   kind  : which shape function the update shader runs (see form() in UPDATE_VS)
   p     : four shape parameters, documented next to each shape function in the shader
   cam   : [azimuth, elevation, distance, fov, target x, y, z, roll]
   flut  : idle flutter of the targets       light : [azimuth offset, speed, elevation] of the key light, camera-relative
   warm  : pushes the throat colours toward copper and gold       expo : exposure */
const KIND = { WING: 0, APPS: 1, PLAY: 2, ORB: 3, TOWER: 4, NEST: 5, FOUR: 6, SETTLE: 7, SWEEP: 8, TINKER: 9, COLLAPSE: 10, MACRO: 11 };
const FORMATIONS = {
  wing:     { kind: KIND.WING,     p: [0.32, 0.012, 0.9, 0.3],   cam: [0.26, 0.1, 6.6, 34, 0, 0, 0, -0.04],   flut: 0.6, light: [0.0, 0.11, 0.62], warm: 0.0, expo: 1.0 },
  apps:     { kind: KIND.APPS,     p: [1, 0.016, 0, 0],          cam: [-0.34, 0.10, 6.4, 34, 0.0, 0, 0.1, 0.02], flut: 0.35, light: [0.5, 0.08, 0.55], warm: 0.0, expo: 1.08, shx: 0.47 },
  games:    { kind: KIND.PLAY,     p: [0.74, -0.84, 0, 0],       cam: [0.30, 0.22, 5.4, 34, 0, 0.06, 0, 0.0],  flut: 0.3, light: [-0.3, 0.1, 0.7], warm: 0.0, expo: 1.05 },
  ai:       { kind: KIND.ORB,      p: [1.02, 0.07, 0, 0],        cam: [0.10, 0.16, 5.5, 34, 0, 0, 0, 0.0],     flut: 0.25, light: [0.4, 0.13, 0.6], warm: 0.0, expo: 1.0 },
  tower:    { kind: KIND.TOWER,    p: [9, 0.028, 0, 0],          cam: [0.62, 0.30, 5.3, 34, 0, 0.02, 0, 0.0],  flut: 0.25, light: [-0.6, 0.06, 0.65], warm: 0.1, expo: 1.14 },
  nest:     { kind: KIND.NEST,     p: [0, 0.07, 0, 0],           cam: [0.18, 0.58, 5.2, 34, 0, 0.3, 0, 0.0],  flut: 0.8, light: [0.2, 0.05, 0.75], warm: 1.0, expo: 1.08 },
  four:     { kind: KIND.FOUR,     p: [0, 0, 0, 0],              cam: [-0.12, 0.16, 5.6, 34, 0, 0, 0, 0.03],   flut: 0.5, light: [0.0, 0.12, 0.6], warm: 0.2, expo: 1.05 },
  settle:   { kind: KIND.SETTLE,   p: [1.1, 0.5, 0, 0],          cam: [-0.22, 0.5, 5.1, 34, 0, -0.25, 0, 0.0], flut: 0.4, light: [0.0, 0.22, 0.5], warm: 0.35, expo: 1.05 },
  wing2:    { kind: KIND.WING,     p: [0.36, 0.01, 1.0, 0.45],  cam: [-0.42, 0.18, 6.9, 34, 0, 0, 0, 0.06],  flut: 0.7, light: [0.3, 0.09, 0.6], warm: 0.1, expo: 1.0 },
  sweep:    { kind: KIND.SWEEP,    p: [0.46, 0.15, 0, 0],        cam: [-0.30, 0.12, 5.4, 34, 0, 0, 0, 0.02],   flut: 0.2, light: [0.2, 0.05, 0.6], warm: 0.0, expo: 1.08 },
  tinker:   { kind: KIND.TINKER,   p: [0.15, 2.6, 0, 0],         cam: [0.22, 0.14, 5.3, 34, 0, 0, 0, 0.0],     flut: 0.2, light: [0.0, 0.1, 0.6], warm: 0.0, expo: 1.08 },
  collapse: { kind: KIND.COLLAPSE, p: [7, 7.4, 0, 0],            cam: [0.42, 0.22, 5.2, 34, 0, -0.08, 0, 0.0], flut: 0.15, light: [-0.4, 0.07, 0.65], warm: 0.1, expo: 1.05 },
  macro:    { kind: KIND.MACRO,    p: [0, 0, 0, 0],              cam: [0.10, 0.06, 4.1, 30, 0.12, 0.1, 0, 0.0], flut: 0.1, light: [0.35, 0.06, 0.55], warm: 0.0, expo: 1.02 },
  settle2:  { kind: KIND.SETTLE,   p: [1.0, 0.42, 0, 0],         cam: [0.30, 0.44, 5.0, 34, 0, -0.25, 0, 0.0], flut: 0.4, light: [0.6, 0.2, 0.5], warm: 0.5, expo: 1.05 }
};
for (const k in FORMATIONS) FORMATIONS[k].pf = new Float32Array(FORMATIONS[k].p);

/* ================= 3. PATHS =================
   Closed curves sampled at 512 equal arc-length steps, one texture row each (RGBA32F: x, y, z, unused).
   Row 0: the wingpath centre-line (the loader's path, so the feathers start exactly on the drawn stroke).
   Row 1: a wide rounded card (a web window).  Row 2: a tall rounded card (a phone). */
const PATH_N = 512, PATH_ROWS = 4;
const WING = { cx: 32, cy: 32, svgW: 48.6136, worldW: 2.9, viewW: 51.2 };   // bbox centre / width in SVG units -> world width
WING.S = WING.svgW / WING.worldW;
const PATHS = new Float32Array(PATH_N * PATH_ROWS * 4);
(function buildPaths() {
  const pts = [];
  const line = (a, b, n) => { for (let i = 0; i < n; i++) { const t = i / n; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } };
  const arc = (cx, cy, r, a1, da, n) => { for (let i = 0; i < n; i++) { const t = a1 + da * i / n; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); } };
  // M21.31 26.17 L46.92 30.69 A8 8 0 1 0 41.12 19.3 L29.72 42.68 A11.6 11.6 0 1 1 21.31 26.17 Z (arc centres solved offline)
  line([21.31, 26.17], [46.92, 30.69], 600);
  arc(48.30821, 22.81137, 8, 1.745205, -4.432401, 900);
  line([41.12, 19.3], [29.72, 42.68], 600);
  arc(19.29463, 37.59358, 11.6, 0.453911, 4.433103, 1200);
  const resample = (P, row, toWorld) => {
    const n = P.length, L = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) { const a = P[i - 1], b = P[i % n]; L[i] = L[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]); }
    const tot = L[n];
    let j = 0;
    for (let k = 0; k < PATH_N; k++) {
      const want = tot * k / PATH_N;
      while (j < n - 1 && L[j + 1] < want) j++;
      const f = (want - L[j]) / Math.max(1e-9, L[j + 1] - L[j]);
      const a = P[j], b = P[(j + 1) % n];
      const o = (row * PATH_N + k) * 4, w = toWorld(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, k / PATH_N);
      PATHS[o] = w[0]; PATHS[o + 1] = w[1]; PATHS[o + 2] = w[2]; PATHS[o + 3] = 1;
    }
  };
  // over-under: the second straight (s = 0.519) passes over the first (s = 0.111) where they cross
  const bump = (s, c) => { let d = Math.abs(s - c); d = Math.min(d, 1 - d); return Math.exp(-(d * d) / (0.055 * 0.055)); };
  const out = [0, 0, 0];
  resample(pts, 0, (x, y, s) => { out[0] = (x - WING.cx) / WING.S; out[1] = -(y - WING.cy) / WING.S; out[2] = 0.2 * (bump(s, 0.519) - bump(s, 0.111)) + 0.05 * Math.sin(TAU * s); return out; });
  const rrect = (hw, hh, r) => {
    const P = [], seg = 64;
    const corner = (cx, cy, a0) => { for (let i = 0; i < seg; i++) { const a = a0 + (Math.PI / 2) * i / seg; P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
    corner(hw - r, hh - r, 0); corner(-hw + r, hh - r, Math.PI / 2); corner(-hw + r, -hh + r, Math.PI); corner(hw - r, -hh + r, 1.5 * Math.PI);
    // densify the straights so equal-length resampling stays exact
    const D = []; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01)); for (let k = 0; k < n; k++) D.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }
    return D;
  };
  resample(rrect(1.0, 0.64, 0.1), 1, (x, y) => { out[0] = x; out[1] = y; out[2] = 0; return out; });
  resample(rrect(0.36, 0.74, 0.13), 2, (x, y) => { out[0] = x; out[1] = y; out[2] = 0; return out; });
})();

/* ================= 4. page: elements, loader ================= */
const glCanvas = $('#gl'), posterCanvas = $('#poster'), loader = $('#loader'), ldMark = $('#ld-mark');
const mainEl = $('main'), footEl = $('#foot');
const railEl = $('#v-rail');

let revealed = false, revealAt = -1, hardCap = 0;
const t0 = performance.now();
function reveal() {
  if (revealed) return; revealed = true; DBG.revealed = true; DBG.tReveal = Math.round(performance.now() - t0);
  clearTimeout(hardCap);
  revealAt = performance.now();
  if (loader) {
    loader.classList.add(reduce || mode !== 'gl' ? 'fade' : 'out');
    setTimeout(() => { loader.hidden = true; }, reduce ? 320 : 900);
  }
  // the feathers leave the stroke for whatever this section is (if GL is still compiling, they leave once it is up)
  introHold = false;
  if (targetKey !== curA) setTarget(targetKey, true);
}
// When to lift the loader: 2.5 s at the latest, sooner once the scene is ready (revealSoon). Long timers can be starved
// while a slow GPU or the poster is busy, so the deadline is also checked on every animation frame (and by the frame
// loop), and CSS lifts the loader on its own by 2.5 s even if the script is held up or never gets that far.
let revealDue = 2500;
function revealCheck() { if (!revealed && performance.now() - t0 >= revealDue) reveal(); }
function revealWatch() { revealCheck(); if (!revealed) requestAnimationFrame(revealWatch); }
function revealSoon(minMs) { revealDue = Math.min(revealDue, Math.max(minMs, performance.now() - t0)); setTimeout(reveal, Math.max(0, minMs - (performance.now() - t0))); revealCheck(); }
if (ENGINE) { hardCap = setTimeout(reveal, 2500); requestAnimationFrame(revealWatch); }
// the fonts are our own files (font-display: swap): once they are in, the words have moved, so measure again
try { doc.fonts.ready.then(() => measure(), () => {}); doc.fonts.addEventListener('loadingdone', () => measure()); } catch (e) {}

/* ================= menu (phones and narrow windows) ================= */
const menu = $('#menu'), menuBtn = $('#menu-btn');
const behindMenu = [mainEl, footEl, $('.skip')];
let menuOpen = false;
// While the full-screen menu is open, everything behind it is inert and the page does not scroll.
function menuState(on) { behindMenu.forEach(el => { if (el) { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } }); root.classList.toggle('menu-open', on); }
function openMenu() { if (!menu) return; menuOpen = true; menu.hidden = false; menuState(true); menuBtn.setAttribute('aria-expanded', 'true'); menuBtn.textContent = 'Close'; const a = $('a', menu); if (a) a.focus(); syncLoop(); chipSync(); }
function closeMenu() { if (!menuOpen) return; menuOpen = false; menu.hidden = true; menuState(false); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.textContent = 'Menu'; syncLoop(); chipSync(); }
if (menu && menuBtn) {
  menuBtn.addEventListener('click', () => { if (menuOpen) { closeMenu(); menuBtn.focus(); } else openMenu(); });
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && menuOpen) { closeMenu(); menuBtn.focus(); } });
  // a link closes the menu first, so the page can scroll (or leave) at once
  $$('a', menu).forEach(a => a.addEventListener('click', () => closeMenu()));
  onMQ(mq('(min-width: 900px)'), e => { if (e.matches) closeMenu(); });
}

/* ================= copy address (clipboard, with a selection fallback) ================= */
(function () {
  const btn = $('#copy-btn'), status = $('#copy-status'), email = $('#email-text');
  if (!btn || !status || !email) return;
  const addr = 'admin@hummingbolt.com';
  const select = () => { try { const r = doc.createRange(); r.selectNodeContents(email); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {} };
  // the old way copies the selection: select the address, copy, and let go of the selection again once it has worked
  // (a selection left behind would also stop the next tap or click from calling Flux)
  const legacy = () => {
    select();
    let ok = false;
    try { ok = !!(doc.execCommand && doc.execCommand('copy')); } catch (e) { ok = false; }
    if (ok) { try { window.getSelection().removeAllRanges(); } catch (e) {} }
    return ok;
  };
  let tm = 0;
  const done = ok => {
    status.textContent = ok ? 'Copied. Paste it into your email app.' : 'Copy is blocked here. The address is selected, so you can copy it yourself.';
    if (!ok) select();
    btn.textContent = ok ? 'Copied' : 'Copy address';
    clearTimeout(tm); tm = setTimeout(() => { btn.textContent = 'Copy address'; }, 2400);
  };
  btn.addEventListener('click', () => {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(addr).then(() => done(true), () => done(legacy())); return; } } catch (e) {}
    done(legacy());
  });
})();

/* ================= theme =================
   theme.js (in the head, before the stylesheet) has already set data-theme: a stored choice wins, then the visitor's
   colour scheme. The page follows the CSS tokens for that theme; the scene reads TOKENS. A switch eases both on one
   400 ms curve: the registered CSS tokens transition, and the scene's colours (one flat array, uploaded as uniforms
   every frame) are tweened toward the new set. Reduced motion switches at once. */
const SC_KEYS = ['bg', 'lift', 'shade', 'lit', 'sheen', 'alt', 'f0', 'f1', 'f2', 'f3', 'back', 'gorget', 'belly', 'wing', 'beak', 'tail', 'rim', 'eye', 'catch'];
const SC_N = SC_KEYS.length * 3 + 3;   // and three numbers: glow (1 on dark), the alt tone's share, the quill's lift
const SCN = new Float32Array(SC_N), SC_FROM = new Float32Array(SC_N), SC_TO = new Float32Array(SC_N);
const SV = {};
SC_KEYS.forEach((k, i) => { SV[k] = SCN.subarray(i * 3, i * 3 + 3); });
SV.rest = SCN.subarray(6, 18);     // shade, lit, sheen, alt
SV.ramp = SCN.subarray(18, 30);    // the flash, four stops
SV.bird = SCN.subarray(30, 57);    // back, gorget, belly, wing, beak, tail, rim, eye, catchlight
SV.thm = SCN.subarray(57, 60);
let theme = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
let themeStored = false, animTm = 0, scT0 = -1, scDur = 0.4;
try { const st = localStorage.getItem('hb-theme'); themeStored = st === 'light' || st === 'dark'; } catch (e) {}
function sceneFill(out, t) {
  const T = TOKENS[t], F = T.feather, B = T.bird;
  const put = (k, h) => { const i = SC_KEYS.indexOf(k) * 3; for (let j = 0; j < 3; j++) out[i + j] = parseInt(h.slice(1 + j * 2, 3 + j * 2), 16) / 255; };
  put('bg', T.bg); put('lift', T.lift); put('shade', F.shade); put('lit', F.lit); put('sheen', F.sheen); put('alt', F.alt);
  for (let j = 0; j < 4; j++) put('f' + j, T.flash[j]);
  put('back', B.back); put('gorget', B.gorget); put('belly', B.belly); put('wing', B.wing); put('beak', B.beak); put('tail', B.tail); put('rim', B.rim); put('eye', B.eye); put('catch', B.catchlight);
  out[57] = t === 'dark' ? 1 : 0; out[58] = F.altShare || 0; out[59] = t === 'dark' ? 1 : 0.55;
}
try { sceneFill(SCN, theme); } catch (e) { logErr('tokens: ' + (e && e.message)); }
/* A switch while the scene is animating is driven from the frame loop, for the page as well as the scene: each frame
   that draws the feathers also writes the page's colour tokens (inline, on the root, through the CSSOM), so the veils
   and the header's fade - drawn in the page colour over the scene - can never be a step ahead of it, at any frame rate.
   Otherwise (the poster, a paused loop) the registered tokens transition in CSS, and the still frames switch at once. */
const TOK = ['bg', 'surface', 'text', 'text2', 'muted', 'hair', 'hair2', 'accent', 'accent2', 'focus'];
const TOKN = ['--bg', '--surface', '--text', '--text-2', '--muted', '--hair', '--hair-2', '--accent', '--accent-2', '--focus'];
const TK_FROM = new Float32Array(30), TK_TO = new Float32Array(30), TK_CUR = new Float32Array(30);
let tkLive = false;
function tokFill(out, t) { const T = TOKENS[t]; TOK.forEach((k, i) => { for (let j = 0; j < 3; j++) out[i * 3 + j] = parseInt(T[k].slice(1 + j * 2, 3 + j * 2), 16) / 255; }); }
function sceneTick(now) {
  if (scT0 < 0) return;
  const kt = scDur > 0 ? clamp((now - scT0) / (scDur * 1000), 0, 1) : 1, e = kt * kt * (3 - 2 * kt);
  for (let i = 0; i < SC_N; i++) SCN[i] = SC_FROM[i] + (SC_TO[i] - SC_FROM[i]) * e;
  if (tkLive) {
    for (let i = 0; i < 30; i++) TK_CUR[i] = TK_FROM[i] + (TK_TO[i] - TK_FROM[i]) * e;
    if (kt < 1) for (let i = 0; i < 10; i++) root.style.setProperty(TOKN[i], 'rgb(' + Math.round(TK_CUR[i * 3] * 255) + ',' + Math.round(TK_CUR[i * 3 + 1] * 255) + ',' + Math.round(TK_CUR[i * 3 + 2] * 255) + ')');
  }
  if (kt >= 1) { scT0 = -1; if (tkLive) { tkLive = false; for (let i = 0; i < 10; i++) root.style.removeProperty(TOKN[i]); root.classList.remove('theme-drive'); } }
}
// Anything that stops the frame loop mid-switch (a paused loop, reduced motion switched on, a lost context, the poster)
// lands the switch first, so the page's inline colours and the scene never stay part-way between two themes.
function finishSwitch() { if (scT0 >= 0) sceneTick(performance.now() + 1e6); }
function sceneTo(drive) {
  SC_FROM.set(SCN); sceneFill(SC_TO, theme);
  scDur = drive ? 0.4 : 0; scT0 = performance.now();
  if (!drive) sceneTick(scT0 + 1e6);   // nothing is animating the scene: take the new set now
  if (mode === 'still') drawStill();
  else if (mode === 'poster' && posterCanvas) {
    // the poster is redrawn behind a short fade (the page's own colours ease meanwhile)
    posterCanvas.classList.add('swap'); clearTimeout(posterTm);
    posterTm = setTimeout(() => { drawPoster(); posterCanvas.classList.remove('swap'); }, reduce ? 0 : 200);
  } else if (mode === 'gl' && !raf && G) { try { renderGL(0); } catch (e) {} }
}
const themeBtn = $('#theme-btn');
const store = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
function syncThemeUI() {
  const light = theme === 'light';
  if (themeBtn) {
    // the label names what the button does; no aria-pressed as well (a pressed "Switch to dark mode" would read wrong)
    themeBtn.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  }
  // the browser's own toolbar follows the page
  $$('meta[name="theme-color"]').forEach(m => m.setAttribute('content', TOKENS[theme].bg));
  DBG.theme = theme;
}
function applyTheme(t) {
  if (t === theme || !TOKENS[t]) return;
  // the live scene drives the page's colours from its own frames; otherwise CSS eases them (reduced motion: at once)
  const drive = !reduce && mode === 'gl' && !!raf;
  if (drive) {
    if (tkLive) TK_FROM.set(TK_CUR); else tokFill(TK_FROM, theme);
    tokFill(TK_TO, t); TK_CUR.set(TK_FROM); tkLive = true; root.classList.add('theme-drive');
    for (let i = 0; i < 10; i++) root.style.setProperty(TOKN[i], 'rgb(' + Math.round(TK_FROM[i * 3] * 255) + ',' + Math.round(TK_FROM[i * 3 + 1] * 255) + ',' + Math.round(TK_FROM[i * 3 + 2] * 255) + ')');
  } else {
    // eased by CSS (or, with reduced motion, at once): the controls follow the tokens exactly, not 300 ms behind them
    root.classList.add('theme-drive'); if (!reduce) root.classList.add('theme-anim');
    clearTimeout(animTm); animTm = setTimeout(() => { root.classList.remove('theme-anim'); if (!tkLive) root.classList.remove('theme-drive'); }, reduce ? 60 : 460);
  }
  theme = t;
  root.setAttribute('data-theme', t);
  syncThemeUI();
  sceneTo(drive);
}
if (themeBtn) themeBtn.addEventListener('click', () => { const t = theme === 'light' ? 'dark' : 'light'; themeStored = true; store('hb-theme', t); applyTheme(t); });
// no stored choice: the page keeps following the visitor's colour scheme
onMQ(mq('(prefers-color-scheme: light)'), e => { if (!themeStored) applyTheme(e.matches ? 'light' : 'dark'); });
// another tab of this site switched: follow it
window.addEventListener('storage', e => { if (e.key === 'hb-theme' && (e.newValue === 'light' || e.newValue === 'dark')) { themeStored = true; applyTheme(e.newValue); } });
syncThemeUI();
DBG.look = t => applyTheme(t || theme);
DBG.scn = SCN;
DBG.tokens = TOKENS;

/* ================= how to call Flux: a line under the hero's buttons, and a chip once that line has gone =================
   "Tap" on touch-first screens, "Click" elsewhere. After the first summon the chip says only the name, then fades. */
const hintEl = $('#flux-hint'), chip = $('#flux-chip');
const HINT = (mq('(pointer: coarse)').matches ? 'Tap' : 'Click') + ' to summon ' + MASCOT_NAME;
$$('[data-mascot]').forEach(e => { e.textContent = MASCOT_NAME; });
if (hintEl) $('.fh-t', hintEl).textContent = HINT;
if (chip) $('.fc-t', chip).textContent = HINT;
let hintInView = !!hintEl, metFlux = false, chipTm = 0;
function chipSync() {
  if (!chip) return;
  const can = root.classList.contains('can-summon');
  if (!metFlux) chip.classList.toggle('on', can && !hintInView && !menuOpen);
}
if (hintEl) {
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { hintInView = es[es.length - 1].isIntersecting; chipSync(); }).observe(hintEl);
  else hintInView = false;
}
function metOnce() {
  if (metFlux || !chip) return;
  metFlux = true; DBG.met = true;
  $('.fc-t', chip).textContent = MASCOT_NAME;
  chip.classList.remove('gone'); chip.classList.add('met', 'on');
  clearTimeout(chipTm); chipTm = setTimeout(() => chip.classList.add('gone'), 2600);
}

/* ================= sections & scroll ================= */
const secs = [];
let activeIdx = -1, secProg = 0.5, targetKey = 'wing', sideKey = 'hero';
function measure() {
  secs.length = 0;
  const sy = window.scrollY || 0;
  $$('[data-form]', mainEl || doc).forEach(el => {
    const r = el.getBoundingClientRect();
    const s = { el, key: el.getAttribute('data-form'), side: el.getAttribute('data-side') || 'right', top: r.top + sy, h: Math.max(1, r.height),
      sl: 0, st: 0, sr: 0, sb: 0, al: 0, at: 0, ar: 0, ab: 0 };
    // the text block (its soft dark field included) and the words the bird keeps beside, in document coordinates
    const blk = $('.slab', el) || $('.hero-copy', el) || $('.stack', el);
    if (blk) { const b = blk.getBoundingClientRect(); s.sl = b.left; s.st = b.top + sy; s.sr = b.right; s.sb = b.bottom + sy; }
    const an = $('[data-bird]', el) || $('h1,h2,h3', el);
    if (an) {
      let b = null;
      try { const rg = doc.createRange(); rg.selectNodeContents(an); b = rg.getBoundingClientRect(); } catch (e) { b = null; }
      if (!b || !b.width) b = an.getBoundingClientRect();
      s.al = b.left; s.at = b.top + sy; s.ar = b.right; s.ab = b.bottom + sy;
    }
    secs.push(s);
  });
  activeIdx = -1;
}
function updateActive() {
  if (!secs.length) return;
  const y = (window.scrollY || 0) + window.innerHeight * 0.5;
  let idx = secs.length - 1, prog = 1;
  for (let i = 0; i < secs.length; i++) { const s = secs[i]; if (y < s.top + s.h) { idx = i; prog = (y - s.top) / s.h; break; } }
  secProg = clamp(prog, 0, 1);
  if (idx !== activeIdx) { activeIdx = idx; onSection(secs[idx]); }
}
function onSection(s) {
  targetKey = s.key; sideKey = s.side; DBG.form = s.key;
  if (!introHold) setTarget(s.key);
  stillTap.until = 0;   // a still Flux summoned in reduced motion stays with the section it was called to
  if (railEl) $$('a', railEl).forEach(a => { if (a.getAttribute('data-for') === s.el.id) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
  if (mode === 'still') scheduleStill();
}

/* ================= 5. flow between formations =================
   Feathers never respawn. When the section changes, each feather leaves formation A for formation B on its own clock:
   its delay mixes a sweep across the new shape (left to right) with a per-feather random, then it flies for DUR seconds
   along an arc stirred by a little turbulence. The shader does the per-feather part; this keeps the two keys and the clock. */
const STAG = 0.85, DUR = 1.25, FLOW_T = STAG + DUR;
let curA = 'wing', curB = 'wing', mixT = 99, blending = false, introHold = true;
function setTarget(key, force) {
  if (!FORMATIONS[key]) return;
  if (!force && (key === curB)) return;
  const dom = (blending && mixT > FLOW_T * 0.5) ? curB : curA;   // where most feathers are right now
  if (dom === key && !force) { curA = curB = key; blending = false; mixT = 99; return; }
  curA = dom; curB = key; mixT = 0; blending = curA !== curB;
  if (!blending) mixT = 99;
  // Long sessions: the shader clock is 32-bit, so after an hour it is rebased while the feathers are in flight anyway.
  if (blending && simT > 3600) simT = 60;
}
function advanceFlow(dt) {
  if (!blending) return;
  mixT += dt;
  if (mixT >= FLOW_T) { curA = curB; blending = false; mixT = 99; }
}

/* ================= 6. camera ================= */
const CKEYS = ['az', 'el', 'dist', 'fov', 'tx', 'ty', 'tz', 'roll', 'sx', 'sy'];
const C = {}, T = {}, CV = {};
CKEYS.forEach(k => { C[k] = T[k] = CV[k] = 0; });
C.dist = T.dist = 6; C.fov = T.fov = 34;
function camSnap() { for (let i = 0; i < CKEYS.length; i++) { C[CKEYS[i]] = T[CKEYS[i]]; CV[CKEYS[i]] = 0; } }
const VPm = new Float32Array(16);
const cam = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, A: 1, B: 1, dist: 6 };
let cssW = window.innerWidth, cssH = window.innerHeight;
// Lens shift keeps the form on the side away from the text (data-side), or above it on a portrait phone.
function shiftFor(side, out) {
  const wide = cssW >= 900, portrait = cssH >= cssW;   // as the CSS's orientation
  if (wide) {
    if (side === 'right') { out.sx = 0.38; out.sy = 0.02; }
    else if (side === 'left') { out.sx = -0.38; out.sy = 0.02; }
    else { out.sx = 0.45; out.sy = 0.16; }  // hero: up and to the right of the headline
  } else if (portrait) { out.sx = 0; out.sy = 0.42; }
  else { out.sx = 0.34; out.sy = 0.06; }   // a phone on its side: the words are always at the left
}
let ptrSX = 0, ptrSY = 0;
function camTarget(key, side, prog, t, out) {
  const c = FORMATIONS[key].cam;
  const aspect = cssW / cssH;
  const pm = aspect < 1 ? 1 + (1 - aspect) * 1.32 : 1;   // portrait: step back so the form fits the width
  out.az = c[0] + (prog - 0.5) * 0.42 + Math.sin(t * 0.07) * 0.08 + ptrSX * 0.05;
  out.el = c[1] - (prog - 0.5) * 0.1 + ptrSY * 0.035;
  out.dist = c[2] * (1 - (prog - 0.5) * 0.06) * pm;
  out.fov = c[3] * (aspect < 1 ? 1 + (1 - aspect) * 0.3 : 1);
  out.tx = c[4]; out.ty = c[5]; out.tz = c[6]; out.roll = c[7];
  shiftFor(side, out);
  if (FORMATIONS[key].shx && cssW >= 900 && side !== 'hero') out.sx = (side === 'left' ? -1 : 1) * FORMATIONS[key].shx;
}
// Where the camera starts: square on to the wingpath, at the distance that makes the feather stroke exactly as large as
// the loader's drawn mark (both centred on the screen).
let markW = 0;   // the loader mark's width in CSS px, measured once (and again on resize) rather than every frame
function introPose(out) {
  const f1 = 1 / Math.tan(34 * Math.PI / 360);
  if (!(markW > 20)) { try { markW = ldMark.getBoundingClientRect().width; } catch (e) {} }
  if (!(markW > 20)) markW = Math.min(440, Math.max(Math.min(cssW, cssH) * 0.46, cssW * 0.62));
  const ppu = markW * (WING.svgW / WING.viewW) / WING.worldW;      // CSS px per world unit
  CKEYS.forEach(k => { out[k] = 0; });
  out.fov = 34; out.dist = f1 * cssH / (2 * ppu);
}
function buildCamera(c, w, h) {
  const dist = c.dist, az = c.az, el = clamp(c.el, -1.35, 1.35);
  const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az), sa = Math.sin(az);
  const px = c.tx + dist * ce * sa, py = c.ty + dist * se, pz = c.tz + dist * ce * ca;
  let fx = c.tx - px, fy = c.ty - py, fz = c.tz - pz; let l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l;
  let rx = -fz, rz = fx; l = Math.hypot(rx, rz) || 1; rx /= l; rz /= l; const ry = 0;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const cr = Math.cos(c.roll), sr = Math.sin(c.roll);
  const Rx = rx * cr + ux * sr, Ry = ry * cr + uy * sr, Rz = rz * cr + uz * sr;
  const Ux = ux * cr - rx * sr, Uy = uy * cr - ry * sr, Uz = uz * cr - rz * sr;
  const f1 = 1 / Math.tan(c.fov * Math.PI / 360), asp = w / h, A = f1 / asp, B = f1;
  const n = 0.05, fa = 40, Cc = (fa + n) / (n - fa), D = 2 * fa * n / (n - fa), sx = c.sx, sy = c.sy;
  const tr = -(Rx * px + Ry * py + Rz * pz), tu = -(Ux * px + Uy * py + Uz * pz), tf = fx * px + fy * py + fz * pz;
  VPm[0] = A * Rx + sx * fx; VPm[4] = A * Ry + sx * fy; VPm[8] = A * Rz + sx * fz; VPm[12] = A * tr - sx * tf;
  VPm[1] = B * Ux + sy * fx; VPm[5] = B * Uy + sy * fy; VPm[9] = B * Uz + sy * fz; VPm[13] = B * tu - sy * tf;
  VPm[2] = -Cc * fx; VPm[6] = -Cc * fy; VPm[10] = -Cc * fz; VPm[14] = Cc * tf + D;
  VPm[3] = fx; VPm[7] = fy; VPm[11] = fz; VPm[15] = -tf;
  cam.px = px; cam.py = py; cam.pz = pz; cam.fx = fx; cam.fy = fy; cam.fz = fz;
  cam.rx = Rx; cam.ry = Ry; cam.rz = Rz; cam.ux = Ux; cam.uy = Uy; cam.uz = Uz; cam.A = A; cam.B = B; cam.dist = dist;
}
const P3 = new Float32Array(3);
function project(x, y, z, out) {
  const cx = VPm[0] * x + VPm[4] * y + VPm[8] * z + VPm[12];
  const cy = VPm[1] * x + VPm[5] * y + VPm[9] * z + VPm[13];
  const cw = VPm[3] * x + VPm[7] * y + VPm[11] * z + VPm[15];
  const iw = cw > 1e-4 ? 1 / cw : 0;
  out[0] = (cx * iw * 0.5 + 0.5) * cssW; out[1] = (0.5 - cy * iw * 0.5) * cssH; out[2] = cw;
}

/* ================= 7. ruffle input =================
   Pointer or finger -> a ray through the scene, a world-space velocity (the drift) and a strength. Touch listeners are
   passive and nothing calls preventDefault, so a finger on the feathers ruffles them and still scrolls the page. */
const ptr = { x: cssW * 0.62, y: cssH * 0.4, has: false, inside: false, dx: 0, dy: 0, touchUntil: 0, touching: false };
const ray = { ox: 0, oy: 0, oz: 6, dx: 0, dy: 0, dz: -1 };
const pv = new Float32Array(3);
const seg = new Float32Array([0, 0, 0, 0]);   // the pointer's path since the last frame, aspect-corrected NDC
DBG.seg = seg;
let pulse = 0, ruffleS = 0, segFresh = true;
function pointerRay() {
  const nx = ptr.x / cssW * 2 - 1, ny = 1 - ptr.y / cssH * 2;
  const xv = (nx - C.sx) / cam.A, yv = (ny - C.sy) / cam.B;
  let dx = cam.fx + cam.rx * xv + cam.ux * yv, dy = cam.fy + cam.ry * xv + cam.uy * yv, dz = cam.fz + cam.rz * xv + cam.uz * yv;
  const l = Math.hypot(dx, dy, dz) || 1;
  ray.ox = cam.px; ray.oy = cam.py; ray.oz = cam.pz; ray.dx = dx / l; ray.dy = dy / l; ray.dz = dz / l;
}
function ptrAt(x, y, isTouch) {
  if (ptr.has) { ptr.dx += x - ptr.x; ptr.dy += y - ptr.y; }
  ptr.x = x; ptr.y = y; ptr.has = true; ptr.inside = true;
  if (isTouch) ptr.touchUntil = performance.now() + 450;
}
window.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') return;                                  // touch is followed through touch events
  if (!ptr.has && e.clientX === 0 && e.clientY === 0) return;             // the synthetic (0,0) move some browsers send on load
  ptrAt(e.clientX, e.clientY, false);
}, { passive: true });
window.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') { ptrAt(e.clientX, e.clientY, false); pulse = 1; } }, { passive: true });
window.addEventListener('touchstart', e => { const t = e.touches[0]; if (!t) return; ptr.has = false; segFresh = true; ptrAt(t.clientX, t.clientY, true); ptr.touching = true; pulse = 1; }, { passive: true });
window.addEventListener('touchmove', e => { const t = e.touches[0]; if (t) ptrAt(t.clientX, t.clientY, true); }, { passive: true });
window.addEventListener('touchend', e => { if (!e.touches.length) { ptr.touching = false; ptr.touchUntil = performance.now() + 450; } }, { passive: true });
doc.addEventListener('mouseout', e => { if (!e.relatedTarget) ptr.inside = false; });
window.addEventListener('blur', () => { ptr.inside = false; });
function updatePointer(dt, now) {
  pointerRay();
  const nx = (ptr.x / cssW * 2 - 1) * (cssW / cssH), ny = 1 - ptr.y / cssH * 2;
  if (segFresh || !ptr.has) { seg[0] = nx; seg[1] = ny; segFresh = !ptr.has; } else { seg[0] = seg[2]; seg[1] = seg[3]; }
  seg[2] = nx; seg[3] = ny;
  const wpp = (2 * cam.dist / cam.B) / cssH;            // world units per CSS px at the focus distance
  const inv = dt > 0 ? 1 / dt : 0;
  const sx = ptr.dx * wpp * inv, sy = -ptr.dy * wpp * inv;
  ptr.dx = 0; ptr.dy = 0;
  let vx = cam.rx * sx + cam.ux * sy, vy = cam.ry * sx + cam.uy * sy, vz = cam.rz * sx + cam.uz * sy;
  const l = Math.hypot(vx, vy, vz); if (l > 6) { vx *= 6 / l; vy *= 6 / l; vz *= 6 / l; }
  pv[0] = pv[0] * 0.6 + vx * 0.4; pv[1] = pv[1] * 0.6 + vy * 0.4; pv[2] = pv[2] * 0.6 + vz * 0.4;
  const speed = Math.hypot(pv[0], pv[1], pv[2]);
  const touchOn = ptr.touching || now < ptr.touchUntil;
  const on = ptr.has && (touchOn || (ptr.inside && mqFine.matches));
  // a resting pointer lifts the feathers under it a little; moving through them ruffles them properly
  const want = on ? clamp((touchOn ? 0.55 : 0.32) + speed * 0.35, 0, 1) : 0;
  ruffleS = lerp(ruffleS, want, 1 - Math.exp(-dt * 10));
  pulse *= Math.exp(-dt * 9); if (pulse < 0.01) pulse = 0;
}

/* ================= 7b. THE BIRD =================
   A faceted hummingbird, built here from numbers: a slim tapered body of hexagonal rings, a round head, a long needle
   of a beak, a forked tail fan, two wings hinged at the shoulder - 44 vertices for the body, 6 for the tail, 9 for each
   wing (and again for three ghosts of each wing, a little earlier in the beat: the blur), 3 for each eye. 128 in all.
   The feathers ARE the bird. Each feather owns one fixed spot on one triangle (area-weighted, picked once on the CPU and
   stored as triangle + barycentric coordinates), so wherever the mesh is posed, the GPU knows where that feather sits and
   which way it lies: along the facet, shaft toward the tail (toward the wingtip on a wing, along the needle on the beak).
   Every frame the CPU poses the mesh (position, heading, bank, pitch, tail pump, figure-eight wingbeat) and uploads the
   128 posed vertices as a uniform array. A director reads the section in view and decides: feathers (a formation) or a
   bird, how big, where (always on the empty side of the layout), and what it does there. */
const BP_BODY = 0, BP_CROWN = 1, BP_GORGET = 2, BP_BELLY = 3, BP_BEAK = 4, BP_TAIL = 5, BP_WING = 6, BP_EYE = 10, BP_GLINT = 11;
const G_N = 4, G_SP = 0.64;                  // the wing now, and three ghosts G_SP radians of beat behind it (a fan of ~110 degrees)
const SHOULDER = [0.03, 0.054, 0.034];
// body rings from the beak back to the tail: x (forward), centre height, half-height, half-width (bird units: beak tip
// to tail tips is 1.04)
const RINGS = [
  [0.215, 0.014, 0.017, 0.016],
  [0.14, 0.033, 0.063, 0.057],
  [0.068, 0.02, 0.056, 0.052],
  [-0.035, -0.006, 0.083, 0.07],
  [-0.14, -0.02, 0.07, 0.06],
  [-0.232, -0.028, 0.041, 0.037],
  [-0.29, -0.032, 0.017, 0.021]
];
// the forked tail fan: root, then the outer, inner, middle, inner, outer tips (the outer pair longest)
const TAILV = [[-0.268, -0.03, 0], [-0.5, -0.034, -0.088], [-0.462, -0.05, -0.044], [-0.424, -0.057, 0], [-0.462, -0.05, 0.044], [-0.5, -0.034, 0.088]];
// one wing, in the body's axes before it moves: x along the chord (leading edge forward), y up, z out along the span
const WINGV = [[0.03, 0, 0], [0.042, 0.008, 0.15], [0.022, 0.004, 0.32], [-0.03, 0, 0.5], [-0.075, 0, 0.4], [-0.088, 0, 0.24], [-0.062, 0, 0.035], [-0.012, 0.014, 0.14], [-0.03, 0.008, 0.33]];
const WINGF = [[0, 1, 7], [1, 8, 7], [1, 2, 8], [2, 3, 8], [3, 4, 8], [4, 5, 8], [5, 7, 8], [5, 6, 7], [6, 0, 7]];
const EYEV = [[0.18, 0.046, 0.051], [0.148, 0.066, 0.051], [0.148, 0.026, 0.051]];   // one eye; mirrored for the other
const NBV = 128, B_TIP = 42, B_CAP = 43, B_T0 = 44, B_W0 = 50, B_E0 = 122;
const BV0 = [], BTRI = [], BCDF = [];
let B_AEFF = 0;   // the bird's surface as the feathers are spread over it (part weights included), bird units squared
(function buildBird() {
  RINGS.forEach((r, i) => {
    for (let j = 0; j < 6; j++) {
      const a = Math.PI / 2 - j * Math.PI / 3, sy = Math.sin(a), cz = Math.cos(a);
      let x = r[0];
      if (sy < -0.1 && (i === 2 || i === 3)) x += i === 3 ? 0.024 : 0.012;   // throat and breast swell forward
      if (sy > 0.6 && i === 1) x -= 0.006;                                   // a rounder crown
      BV0.push([x, r[1] + r[2] * sy, r[3] * cz]);
    }
  });
  BV0.push([0.54, -0.007, 0]); BV0.push([-0.304, -0.033, 0]);               // beak tip, tail cap
  TAILV.forEach(v => BV0.push(v.slice()));
  for (let g = 0; g < G_N; g++) for (let w = 0; w < 2; w++) WINGV.forEach(v => BV0.push([v[0] + SHOULDER[0], v[1] + SHOULDER[1], (w ? -1 : 1) * (v[2] + SHOULDER[2])]));
  for (let w = 0; w < 2; w++) EYEV.forEach(v => BV0.push([v[0], v[1], (w ? -1 : 1) * v[2]]));
  // the throat patch (gorget), the crown, a pale breast and belly, a bronze back
  const matFor = (i, rel) => i === 0 ? (rel < -0.2 ? BP_GORGET : BP_CROWN) : i === 1 ? (rel < 0.05 ? BP_GORGET : BP_CROWN)
    : i === 2 ? (rel < -0.3 ? BP_GORGET : BP_BODY) : (rel < (i === 3 ? -0.42 : -0.3) ? BP_BELLY : BP_BODY);
  for (let i = 0; i < RINGS.length - 1; i++) {
    const ay = (RINGS[i][1] + RINGS[i + 1][1]) / 2, ry = (RINGS[i][2] + RINGS[i + 1][2]) / 2;
    for (let j = 0; j < 6; j++) {
      const a = i * 6 + j, b = i * 6 + (j + 1) % 6, c = (i + 1) * 6 + (j + 1) % 6, d = (i + 1) * 6 + j;
      const qs = (i + j) % 2 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
      for (const q of qs) { const cy = (BV0[q[0]][1] + BV0[q[1]][1] + BV0[q[2]][1]) / 3; BTRI.push([q[0], q[1], q[2], matFor(i, (cy - ay) / ry)]); }
    }
  }
  for (let j = 0; j < 6; j++) { BTRI.push([j, (j + 1) % 6, B_TIP, BP_BEAK]); BTRI.push([36 + j, 36 + (j + 1) % 6, B_CAP, BP_BODY]); }
  for (let k = 1; k < 5; k++) BTRI.push([B_T0, B_T0 + k, B_T0 + k + 1, BP_TAIL]);
  for (let g = 0; g < G_N; g++) for (let w = 0; w < 2; w++) { const b = B_W0 + (g * 2 + w) * 9; WINGF.forEach(f => BTRI.push([b + f[0], b + f[1], b + f[2], BP_WING + g])); }
  BTRI.push([B_E0, B_E0 + 1, B_E0 + 2, BP_EYE]); BTRI.push([B_E0 + 3, B_E0 + 4, B_E0 + 5, BP_EYE]);
  // area-weighted, with a little more for the needle and the throat, fewer feathers on each fainter ghost of the wing,
  // and the two eyes always 1.4 % of the bird whatever their size
  const PW = [1, 1, 1.2, 1, 1.7, 1.1, 0.8, 0.5, 0.38, 0.28, 0, 0];
  const area = t => { const A = BV0[t[0]], B = BV0[t[1]], Cc = BV0[t[2]]; const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2]; return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); };
  const w = BTRI.map(t => area(t) * PW[t[3]]);
  let tot = 0; w.forEach(x => { tot += x; });
  const eyeW = tot * 0.014 / 0.986 / 2;
  BTRI.forEach((t, i) => { if (t[3] === BP_EYE) w[i] = eyeW; });
  let acc = 0; tot += eyeW * 2;
  w.forEach(x => { acc += x; BCDF.push(acc / tot); });
  B_AEFF = tot;
})();
DBG.birdMesh = { vertices: NBV, triangles: BTRI.length, area: Math.round(B_AEFF * 1e4) / 1e4 };
// a small integer hash (the same family as the shader's), for the per-feather bird data
function hj(x) { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); x ^= x >>> 16; return (x >>> 8) / 16777216; }
/* Each feather's fixed place on the bird, 8 floats: the triangle's three corners, body part, barycentric (2), its turn
   in the bird subset (sel: the feathers with sel < share are the bird), its place in the assembly wave (0 beak tip ..
   1 tail tips; the wings unfold in the middle). Triangle and sel come from a 2D low-discrepancy sequence, so any share
   of any prefix of the buffer (tiers draw prefixes) covers the whole bird evenly. */
function birdAttrs(n) {
  const out = new Float32Array(n * 8), NT = BTRI.length;
  for (let i = 0; i < n; i++) {
    const u = (0.5 + i * 0.7548776662466927) % 1, sel = (0.5 + i * 0.5698402909980532) % 1;
    let lo = 0, hi = NT - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (BCDF[m] < u) lo = m + 1; else hi = m; }
    const T = BTRI[lo];
    let part = T[3];
    const r1 = hj(i * 3 + 11), r2 = hj(i * 3 + 12), sq = Math.sqrt(r1);
    let b0 = 1 - sq, b1 = sq * (1 - r2);
    if (part === BP_EYE && hj(i * 3 + 13) < 0.16) { part = BP_GLINT; b0 = 0.6 + 0.1 * r1; b1 = 0.28 + 0.06 * r2; }   // a catchlight, front and high in the eye
    const A = BV0[T[0]], B = BV0[T[1]], Cc = BV0[T[2]], b2 = 1 - b0 - b1;
    const x = A[0] * b0 + B[0] * b1 + Cc[0] * b2, z = A[2] * b0 + B[2] * b1 + Cc[2] * b2;
    const key = part >= BP_WING && part <= BP_WING + 3 ? 0.3 + 0.42 * clamp((Math.abs(z) - 0.034) / 0.5, 0, 1) : clamp((0.54 - x) / 1.04, 0, 1);
    const o = i * 8;
    out[o] = T[0]; out[o + 1] = T[1]; out[o + 2] = T[2]; out[o + 3] = part;
    out[o + 4] = b0; out[o + 5] = b1; out[o + 6] = sel; out[o + 7] = key;
  }
  return out;
}

/* ---- the bird's state: where it is and how it moves ---- */
const bird = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, yaw: 0, yawV: 0, pitch: 0.7, roll: 0, psi: 0, s: 0.3, sT: 0.3, tail: 0.1, spread: 0.8, om: 4, ze: 0.85, vmax: 3, head: 0 };
const BPm = { om: 4, ze: 0.9, vmax: 3, faceVel: 0, beat: 1 };   // what the director asks of the flight
const TG = new Float32Array(3), LK = new Float32Array(3), TQ = new Float32Array(3), TQ2 = new Float32Array(3);
const BVW = new Float32Array(NBV * 3);          // the posed mesh, world space: uploaded every frame
const BAX = new Float32Array(9);                // its unit axes: forward, up, right
// what the feathers are told: wanted (0/1), share, seconds since that last changed; the stagger and the flight time of
// the assembly (beak first) and the dissolve (tail first); the size of a feather on the bird
let bWant = 0, bShare = 0.2, bClk = 99, bLevel = 0, bLen = 1, bGhost = 1, bSnap = false, bPlace = false;
let bStagA = 2.1, bStagD = 1.5, bDur = 0.6;
let bT = 0, bMode = '', bModeT = 0, bSince = -1, bDimK = 0;
const hero = { phase: 'wait', t: 0, s: 0 };
DBG.bird = { mode: '', kind: '', on: false, phase: '', want: 0, share: 0, level: 0, n: 0, px: 0, sx: 0, sy: 0, apps: 0, taps: 0, orb: '' };
// its length on screen (CSS px, beak tip to tail tips, at its own depth): desktop, phone
const BPX = { hero: [250, 160], tower: [220, 140], beside: [250, 160], sip: [250, 160], dart: [320, 190], tap: [190, 140], visit: [210, 136], play: [205, 118] };
function birdPx(m) { if (DBG.qaPx > 0) return DBG.qaPx; const P = BPX[m] || BPX.beside; return cssW >= 900 ? P[0] : P[1]; }
// how many of the feathers it takes: enough that, on screen, they sit about 3 px apart
function shareFor(px) {
  const pitch = cssW >= 900 ? 3.3 : 2.9, k = px / 1.04;
  return clamp(B_AEFF * k * k / (pitch * pitch) / Math.max(256, active), 0.025, 0.42);   // a low tier keeps its formation: larger feathers instead
}
function setWant(w, sh) {
  if (w !== bWant || (w && Math.abs(sh - bShare) > 0.004)) {
    if (w && !bWant && bLevel <= 0.002) bPlace = true;      // nothing of it is left: it forms where it is wanted
    bWant = w; if (w) bShare = sh; bClk = 0;
  }
}

/* ---- small vector helpers (no allocation) ---- */
function setV(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; }
function cpy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }
function addCam(o, k) { o[0] -= cam.fx * k; o[1] -= cam.fy * k; o[2] -= cam.fz * k; }    // toward the camera
function addR(o, k) { o[0] += cam.rx * k; o[1] += cam.ry * k; o[2] += cam.rz * k; }     // screen right
function addU(o, k) { o[0] += cam.ux * k; o[1] += cam.uy * k; o[2] += cam.uz * k; }     // screen up
// a screen point (CSS px) at camera depth w, back into the world (the inverse of project(), lens shift included)
function unproject(sx, sy, w, out) {
  const nx = sx / cssW * 2 - 1, ny = 1 - sy / cssH * 2;
  const xv = (nx - C.sx) / cam.A, yv = (ny - C.sy) / cam.B;
  out[0] = cam.px + w * (cam.fx + cam.rx * xv + cam.ux * yv);
  out[1] = cam.py + w * (cam.fy + cam.ry * xv + cam.uy * yv);
  out[2] = cam.pz + w * (cam.fz + cam.rz * xv + cam.uz * yv);
  return out;
}
function pathPt(s, o) {
  const x = ((s % 1) + 1) % 1 * PATH_N, i = Math.floor(x), f = x - i, a = i * 4, b = ((i + 1) % PATH_N) * 4;
  return setV(o, lerp(PATHS[a], PATHS[b], f), lerp(PATHS[a + 1], PATHS[b + 1], f), lerp(PATHS[a + 2], PATHS[b + 2], f));
}
const ppuAt = w => cam.B * cssH * 0.5 / Math.max(w, 0.1);      // CSS px per world unit at camera depth w
const hdrPx = () => cssW >= 900 ? 72 : 60;
/* The bird keeps clear of the words: its box on screen (half sizes hw, hh) is pushed off the text block of the section
   in view (sideways on a wide screen, up on a phone) and kept inside the viewport, below the header. In flight it may
   still pass behind a line, and the text is always drawn above it. */
function guard(o, hw, hh, free) {
  project(o[0], o[1], o[2], P3);
  let x = P3[0], y = P3[1];
  const w = P3[2], s = secs[activeIdx], sy = window.scrollY || 0;
  if (w < 0.2) return o;
  // free: the spot was already chosen clear of every line of words (a summon), so only the screen's edges apply
  if (!free && s && s.sr > s.sl) {
    // the text block plus most of its soft dark field (the bird would only be dimmed behind it)
    const wide = cssW >= 900, land = !wide && cssW > cssH, mx = wide || land ? 60 : 12, my = wide ? 30 : 50;
    const l = s.sl - mx, r = s.sr + mx, t = s.st - sy - my, b = s.sb - sy + my;
    if (x + hw > l && x - hw < r && y + hh > t && y - hh < b) {
      if (wide) { if (s.side === 'left') x = Math.min(x, l - hw); else x = Math.max(x, r + hw); }
      else if (land) x = Math.max(x, r + hw);
      else y = Math.min(y, t - hh);
    }
  }
  x = clamp(x, hw + 8, cssW - hw - 8); y = clamp(y, hdrPx() + hh + 6, cssH - hh - 8);
  if (x !== P3[0] || y !== P3[1]) unproject(x, y, w, o);
  return o;
}
// a screen point and depth for a hover beside the words of section s (cx, cy: CSS px; returns the look direction too)
function besideAnchor(s, L, out) {
  const sy = window.scrollY || 0, wide = cssW >= 900;
  if (wide) {
    const left = s.side === 'left';                         // form on the left, text on the right
    const ay = s.at + (s.ab - s.at) * 0.34 - sy;
    out[0] = left ? Math.min(s.sl - 70 - 0.5 * L, cssW * 0.4) : Math.max(s.sr + 70 + 0.5 * L, cssW * 0.6);
    out[1] = clamp(ay, hdrPx() + 0.6 * L, cssH - 0.5 * L);
    out[2] = left ? 1 : -1;                                 // look toward the words
  } else {
    out[0] = cssW * 0.6; out[1] = clamp(s.st - sy - 50 - 0.36 * L, hdrPx() + 0.45 * L, cssH * 0.5); out[2] = -0.4;
  }
  return out;
}
const ANC = new Float32Array(3);
// the hero bird's flight: the wingpath, a little larger and in front of the feathered stroke, so it traces it
function heroPt(s, o) { pathPt(s, o); o[2] += 0.5; return o; }
/* ---- Flux's appearances ----
   One at a time, of three kinds:
     feature : the section's own scene with the bird (the hero's flight, the game, the tower, the nest, the address, the
               dart). It starts as the visitor arrives and the formation has begun to flow, plays for a while, and lets go.
     auto    : Flux turning up on its own, 12-22 s after it last let go (sooner between rounds of the game): the section's
               scene again, or elsewhere a short visit to an empty part of the layout. Never while the page is moving.
     tap     : summoned, anywhere on the page that is not a word or a control. A second tap moves it.
   Every appearance ends the same way: the bird dissolves back into the formation, and its behaviour carries on while it
   does. Leaving a section lets go of whatever the bird was doing there, where it is. */
const FEATURE = { wing: 'hero', games: 'play', tower: 'tower', nest: 'beside', settle: 'sip', sweep: 'dart', settle2: 'beside' };
const FEAT_DUR = { play: 13, tower: 8, beside: 8.5, sip: 8.4, dart: 11.2 };
const app = { on: false, kind: '', b: '', t0: 0, dur: 0, sec: -1, x: 0, y: 0, v: 0, dx: 0, dy: 0, touch: false, spot: false, placed: false, ox: 0, oy: 0, sy0: 0 };
let appSec = -2, pendFeat = '', pendAt = 0, nextAuto = 14, lastB = '';
// the director's own small random (xorshift), so a run can be replayed
let rs = 2463534242;
function rnd() { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; return (rs >>> 0) / 4294967296; }
function gapAuto(b) { return b === 'play' ? 5 + rnd() * 4 : 12 + rnd() * 10; }
function startApp(kind, b) {
  app.on = true; app.kind = kind; app.b = b; app.t0 = bT; app.sec = activeIdx; app.spot = false;
  app.dur = b === 'tap' ? 4.6 : b === 'visit' ? 4.4 + rnd() * 1.6 : b === 'hero' ? 99 : (FEAT_DUR[b] || 8) * (kind === 'auto' && b !== 'play' ? 0.8 : 1);
  if (b === 'visit') app.v = Math.floor(rnd() * 3);
  if (b === 'hero') { hero.phase = 'gather'; hero.t = 0; hero.s = 0.53; } else hero.phase = 'wait';
  if (b === 'play') playStart();
  bMode = b; bModeT = 0; lastB = b;
  DBG.bird.apps++; DBG.bird.last = kind + ':' + b;
}
function endApp() {
  if (!app.on) return;
  app.on = false;
  nextAuto = bT + gapAuto(app.b);
  if (app.b === 'hero' && hero.phase !== 'wait') hero.phase = 'leave';
}
// Flux turns up on its own only into a still page: no scroll for a moment, the formation arrived, the camera settled
function calm() {
  return performance.now() - lastScrollAt > 900 && !blending && !menuOpen && Math.abs(CV.az) + Math.abs(CV.el) + Math.abs(CV.sx) + Math.abs(CV.sy) < 0.2;
}
function schedule() {
  const s = secs[activeIdx];
  if (activeIdx !== appSec) {
    appSec = activeIdx;
    if (app.on) endApp();
    pendFeat = s ? (FEATURE[s.key] || '') : '';
    pendAt = bT + 0.45;
    nextAuto = Math.max(nextAuto, bT + 4);
  }
  if (!s || mode !== 'gl' || reduce || !revealed || introHold) return;
  if (app.on) { if (app.b !== 'hero' && bT - app.t0 >= app.dur) endApp(); return; }
  // the section's own scene: once the page has paused for a moment (a quick scroll past never starts one)
  if (pendFeat && bT >= pendAt && performance.now() - lastScrollAt > 260 && (pendFeat !== 'hero' || bSince > 0.7)) { startApp('feature', pendFeat); pendFeat = ''; return; }
  if (!pendFeat && bT >= nextAuto && bLevel <= 0.01) {
    if (calm()) startApp('auto', FEATURE[s.key] || 'visit');
    else nextAuto = bT + 0.5;   // try again shortly
  }
}
// a free place for a visit, in CSS px: on the far side of the words on a wide screen, above them on a phone
function emptySpot(s, L) {
  const sy = window.scrollY || 0, wide = cssW >= 900, top = hdrPx() + 0.62 * L;
  if (wide && s.side !== 'hero') {
    let x0, x1;
    if (s.side === 'left') { x0 = 0.6 * L + 24; x1 = s.sl - 0.7 * L - 40; } else { x0 = s.sr + 0.7 * L + 40; x1 = cssW - 0.6 * L - 24; }
    if (x1 < x0) x0 = x1 = (x0 + x1) * 0.5;
    app.x = lerp(x0, x1, 0.15 + 0.7 * rnd());
    app.y = lerp(top, Math.max(top, cssH * 0.64), 0.1 + 0.8 * rnd());
  } else {
    // the hero (the words are at the foot of the screen) and every section on a phone: the open space above the words
    const yMax = Math.max(top, Math.min(cssH * (wide ? 0.5 : 0.42), s.st - sy - 0.62 * L - 12));
    const xa = wide ? cssW * 0.42 : 0.62 * L, xb = cssW - 0.62 * L - (wide ? 40 : 0);
    app.x = lerp(xa, xb, 0.15 + 0.7 * rnd());
    app.y = lerp(top, yMax, 0.15 + 0.7 * rnd());
  }
  const dir = app.x < cssW * 0.5 ? 1 : -1;
  app.dx = dir * (wide ? 0.1 : 0.2) * cssW; app.dy = -(0.03 + 0.05 * rnd()) * cssH;
  app.spot = true;
}
/* ---- summoned: a tap or a click on an empty part of the page ---- */
function summon(x, y, touch) {
  if (!revealed || (mode !== 'gl' && mode !== 'still')) return false;
  if (mode === 'gl' && (introHold || reduce)) return false;
  // the section under the finger is the one it is summoned to, even if the frame loop has not seen the scroll yet
  updateActive();
  if (activeIdx !== appSec) { appSec = activeIdx; nextAuto = Math.max(nextAuto, bT + 4); }
  pendFeat = '';                       // the section's own scene waits for its next turn
  app.on = false; startApp('tap', 'tap');
  app.x = x; app.y = y; app.touch = !!touch;
  tapPlace(x, y, !!touch);
  DBG.bird.taps++;
  metOnce();
  if (mode === 'still') { stillTap.x = x; stillTap.y = y; stillTap.touch = !!touch; stillTap.until = performance.now() + 4200; drawStill(); clearTimeout(stillTap.tm); stillTap.tm = setTimeout(() => { stillTap.until = 0; if (mode === 'still') drawStill(); }, 4300); }
  return true;
}
// reduced motion: a summoned Flux is drawn still and formed, for a few seconds
const stillTap = { x: 0, y: 0, touch: false, until: 0, tm: 0 };
/* Where a summoned Flux hovers: as close as it can to its usual place beside the spot (the open side, a little above),
   clear of every line of words and every control on screen. Checked against the lines themselves, not the whole text
   block, so a tap in the open space beside a short line brings it right there, not to the far side of the block.
   Worked out once per summon (a few dozen rectangles), in screen pixels. */
const TPC = [-1.5, -1.1, -0.75, -0.36, 0, 0.36, 0.75, 1.1, 1.5], TPR = [-1.05, -0.75, -0.44, -0.12, 0.2, 0.5, 0.8];
const TP_OBS = 'h1,h2,h3,p,li,address,.btn,.v-index a';
// the blocks whose soft veil would hide the bird (the words' own veils), and the fixed pills drawn over the scene
const TP_VEIL = '.slab,.hero-copy,.v-intro .wrap > .stack,.foot-in';
function tapPlace(x, y, touch) {
  app.placed = false; app.sy0 = window.scrollY || 0;
  const L = birdPx('tap'), hw = 0.42 * L, hh = 0.3 * L, wide = cssW >= 900, m = wide ? 14 : 10;
  const box = [];
  const put = (q, mx, my) => { if (q.width > 0 && q.bottom > 0 && q.top < cssH) box.push(q.left - mx, q.top - my, q.right + mx, q.bottom + my); };
  try {
    const roots = [mainEl, footEl];
    for (let k = 0; k < roots.length; k++) {
      if (!roots[k]) continue;
      const els = roots[k].querySelectorAll(TP_OBS);
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.matches('.btn,.v-index a')) { put(el.getBoundingClientRect(), m, m); continue; }
        TRG.selectNodeContents(el); const rs = TRG.getClientRects();
        for (let j = 0; j < rs.length; j++) put(rs[j], m, m);
      }
      // the veil reaches past its block (as the guard reckons it): a bird inside it would barely show
      const vs = roots[k].querySelectorAll(TP_VEIL);
      for (let i = 0; i < vs.length; i++) put(vs[i].getBoundingClientRect(), wide || cssW > cssH ? 60 : 12, wide ? 30 : 50);
    }
    const pills = [railEl];
    if (chip && chip.classList.contains('on') && !chip.classList.contains('gone')) pills.push(chip);
    pills.forEach(el => { if (el) put(el.getBoundingClientRect(), 8, 8); });   // hidden ones have no box, and add nothing
  } catch (e) { return; }
  const side = x < cssW * 0.5 ? 1 : -1;
  const px = x + side * (touch ? 0.26 : 0.36) * L, py = y - (touch ? 0.44 : 0.12) * L;
  const x0 = hw + 8, x1 = cssW - hw - 8, y0 = hdrPx() + hh + 6, y1 = cssH - hh - 8;
  let best = 1e9, bx = 0, by = 0;
  for (let a = 0; a < TPC.length; a++) for (let c = 0; c < TPR.length; c++) {
    const cx = clamp(x + side * TPC[a] * L, x0, x1), cy = clamp(y + TPR[c] * L, y0, y1);
    const d = Math.hypot(cx - px, cy - py);
    if (d >= best) continue;
    let hit = false;
    for (let i = 0; i < box.length && !hit; i += 4) hit = cx + hw > box[i] && cx - hw < box[i + 2] && cy + hh > box[i + 1] && cy - hh < box[i + 3];
    if (!hit) { best = d; bx = cx; by = cy; }
  }
  if (best < 1e9) { app.placed = true; app.ox = bx; app.oy = by; }
  DBG.bird.placed = app.placed ? Math.round(best) : -1;
}

/* ---- the game (Games): Flux keeps a small feathered orb up ----
   The orb belongs to the PLAY formation: its centre, size, flash and recent path go to the shader every frame, and the
   pool below ripples out from each touch. Here it flies. A touch sends it up in an arc (apex 0.85-1.25 bird lengths,
   1.1-1.4 s) toward a fresh spot inside the play area; Flux moves to where it will come down and meets it with the tip
   of its beak, with a little upward nod, and the orb flashes the throat colour. With no bird to meet it, it sinks back
   to its resting place and floats there. World units, in the formation's own frame (it faces the camera). */
const ORB_N = 20, PLAY_YB = 0.06, ORB_REST_Y = -0.1;
const orb = { x: 0, y: ORB_REST_Y, z: 0, vx: 0, vy: 0, g: 1, lx: 0, R: 0.09, flash: 0, rip: new Float32Array([0, 0, 9, 0]), tr: new Float32Array(ORB_N * 3 + 3), trAcc: 0, bumps: 0, side: 1, nod: 0, tx: 0.36, ty: 0.34, tz: 0.08, fly: false, t0: 0, live: false, tagF: null, tagN: -1, tagL: null };
const TRV = orb.tr.subarray(0, ORB_N * 3);
function orbReset() {
  orb.fly = false; orb.x = 0; orb.y = ORB_REST_Y; orb.z = 0; orb.vx = orb.vy = 0; orb.flash = 0; orb.bumps = 0; orb.nod = 0;
  for (let i = 0; i <= ORB_N; i++) { orb.tr[i * 3] = orb.x; orb.tr[i * 3 + 1] = orb.y; orb.tr[i * 3 + 2] = orb.z; }
}
orbReset();
function playStart() { orb.bumps = 0; orb.side = rnd() < 0.5 ? 1 : -1; orb.t0 = bT; }
function playLw() { return birdPx('play') / Math.max(1, ppuAt(cam.dist)); }   // the bird's length, world units
function playHalf() { return cssW >= 900 ? 0.44 : 0.3; }
function bump(Lw) {
  orb.bumps++; orb.flash = 1; orb.nod = 0.26;
  orb.rip[0] = orb.x; orb.rip[1] = orb.z; orb.rip[2] = 0; orb.rip[3] = 1;
  const half = playHalf();
  let nx = orb.x + (rnd() < 0.5 ? -1 : 1) * (0.2 + 0.32 * rnd()) * Lw;
  if (nx > half || nx < -half) nx = 2 * orb.x - nx;              // a plan that would leave the area turns back
  nx = clamp(nx, -half, half);
  const h = (0.85 + 0.4 * rnd()) * Lw, T = 1.1 + 0.3 * rnd();
  orb.g = 8 * h / (T * T);
  orb.vy = (PLAY_YB - orb.y + 0.5 * orb.g * T * T) / T;          // back down to the meeting height after T
  orb.vx = (nx - orb.x) / T; orb.lx = nx; orb.fly = true;
  if (orb.bumps % 4 === 0) orb.side = -orb.side;                // now and then Flux comes round to the other side
}
function playStep(dt) {
  const inPlay = curB === 'games' || curA === 'games';
  if (!inPlay) { if (orb.live) { orb.live = false; orbReset(); } return; }
  orb.live = true;
  const Lw = playLw();
  orb.R = lerp(orb.R, 0.105 * Lw, 1 - Math.exp(-dt * 4));
  const playing = bMode === 'play' && app.on && bWant && bLevel > 0.82;
  const tx = BVW[B_TIP * 3], ty = BVW[B_TIP * 3 + 1], tz = BVW[B_TIP * 3 + 2];
  const reach = Math.hypot(orb.x - tx, orb.y - orb.R - ty, orb.z - tz);   // the beak tip to the orb's underside
  if (orb.fly) {
    orb.vy -= orb.g * dt; orb.x += orb.vx * dt; orb.y += orb.vy * dt;
    if (orb.vy < 0 && (orb.y <= PLAY_YB || (playing && reach < orb.R * 0.9 && orb.y < PLAY_YB + 0.25 * Lw))) {
      if (playing) bump(Lw); else orb.fly = false;
    }
  } else {
    // at rest: a soft, critically damped return to its place, and a slow bob
    const w = 3.4, ry = ORB_REST_Y + 0.035 * Math.sin(bT * 1.7);
    orb.vx += (-w * w * orb.x - 2 * w * orb.vx) * dt; orb.vy += (w * w * (ry - orb.y) - 2 * w * orb.vy) * dt;
    orb.x += orb.vx * dt; orb.y += orb.vy * dt;
    // the first touch of a round: Flux comes up under it
    if (playing && (reach < orb.R * 1.3 || bT - orb.t0 > 4.2)) bump(Lw);
  }
  if (!(Math.abs(orb.x) + Math.abs(orb.y) < 50)) orbReset();
  orb.flash *= Math.exp(-dt * 2.6); orb.nod = Math.max(0, orb.nod - dt); orb.rip[2] = Math.min(orb.rip[2] + dt, 60);
  orb.trAcc += dt;
  while (orb.trAcc >= 1 / 30) { orb.trAcc -= 1 / 30; orb.tr.copyWithin(3, 0, ORB_N * 3); orb.tr[0] = orb.x; orb.tr[1] = orb.y; orb.tr[2] = orb.z; }
}
// Flux's place in the game: below where the orb will come down, on its side, the beak tip just under the orb
function playBird(Lw) {
  const px = orb.fly ? orb.lx : orb.x, py = orb.fly ? PLAY_YB : orb.y;
  let ox = BVW[B_TIP * 3] - bird.x, oy = BVW[B_TIP * 3 + 1] - bird.y, oz = BVW[B_TIP * 3 + 2] - bird.z;
  if (ox * orb.side < 0.1 * Lw || bLevel < 0.5) { ox = orb.side * 0.36 * Lw; oy = 0.32 * Lw; oz = 0.06 * Lw; }   // still turning: the usual reach
  const k = 0.12;
  orb.tx = lerp(orb.tx, ox, k); orb.ty = lerp(orb.ty, oy, k); orb.tz = lerp(orb.tz, oz, k);
  const nod = orb.nod > 0 ? Math.sin(Math.PI * (1 - orb.nod / 0.26)) * 0.07 * Lw : 0;
  setV(TG, px - orb.tx, py - orb.R * 0.9 - orb.ty + nod, -orb.tz);
  setV(LK, orb.x, orb.y + 0.2 * orb.R, orb.z);
  BPm.om = 5.4; BPm.ze = 0.82; BPm.vmax = 4.6; BPm.faceVel = 0;
}

function birdDirect(dt) {
  schedule();
  const s = secs[activeIdx], wide = cssW >= 900, ws = bird.s;
  const shown = !(introHold || !revealed || mode === 'poster');
  const m = !shown ? '' : app.on ? app.b : (bLevel > 0.001 ? lastB : '');
  if (m !== bMode) { bMode = m; bModeT = 0; }
  bModeT += dt;
  BPm.om = 4.2; BPm.ze = 0.9; BPm.vmax = 3; BPm.faceVel = 0; BPm.beat = 1;
  bStagA = 2.1; bStagD = 1.5; bDur = 0.6;
  // the formation steps back toward the page while Flux is there (more where it may form over the formation itself)
  bDimK = m === 'hero' ? 0.34 : m === 'tap' ? 0.46 : m === 'sip' ? 0.38 : m === 'beside' ? 0.4 : m === 'visit' ? 0.42 : m === 'play' ? 0.14 : m === 'tower' ? 0.3 : 0.26;
  if (m !== 'hero' && hero.phase === 'leave' && bLevel <= 0) hero.phase = 'wait';
  if (!m || !s) { setWant(0, bShare); return; }
  // letting go after leaving its section: it stays where it was (the camera carries it off) and dissolves
  if (!app.on && app.sec !== activeIdx && m !== 'hero') { setWant(0, bShare); return; }
  const L = birdPx(m);
  let depth = cam.dist, want = app.on ? 1 : 0;
  const bob = 0.035 * Math.sin(bT * 2.1) + 0.012 * Math.sin(bT * 5.3);
  if (m === 'hero') {
    /* Hero: the feathers bloom out of the drawn stroke, a few gather into the bird at the crossing, it beats its wings
       and flies the figure-eight once, then lets go and falls back into it: the stroke is its flight path. */
    hero.t += dt;
    if (hero.phase === 'wait') want = 0;
    if (hero.phase === 'gather') {
      heroPt(hero.s, TG); addU(TG, bob * ws);
      heroPt(hero.s + 0.04, LK);
      if (hero.t > bStagA + bDur + 0.6) { hero.phase = 'fly'; hero.t = 0; }
    } else if (hero.phase === 'fly' || hero.phase === 'leave') {
      const sp = hero.phase === 'fly' ? 1 / 6.4 : 1 / 11;
      hero.s += dt * sp;
      heroPt(hero.s + 0.018, TG); addU(TG, bob * ws * 0.5);
      heroPt(hero.s + 0.06, LK);
      BPm.om = 6.5; BPm.ze = 0.8; BPm.vmax = 4.5; BPm.faceVel = 0.9;
      if (hero.phase === 'fly' && hero.t > 6.4 * 0.95) { endApp(); hero.t = 0; }
      if (hero.phase === 'leave') { want = 0; if (bLevel <= 0) hero.phase = 'wait'; }
    }
    guard(TG, 0.45 * L, 0.3 * L);
    project(TG[0], TG[1], TG[2], P3); depth = P3[2];
  } else if (m === 'play') {
    // Games: keepy-uppy (see playStep)
    const Lw = playLw();
    playBird(Lw);
    guard(TG, 0.48 * L, 0.34 * L);
    project(TG[0], TG[1], TG[2], P3); depth = P3[2];
    bStagA = 1.5; bStagD = 1.2;
  } else if (m === 'tower') {
    // Toppleton: the feathers stack into the tower, and the bird hovers above its top, looking toward the words
    setV(TG, 0.02, 1.12 + bob * ws, 0.04);
    project(TG[0], TG[1], TG[2], P3); depth = P3[2];
    const ls = wide ? (s.side === 'left' ? 1 : -1) : 0.7;
    cpy(LK, TG); addR(LK, ls); if (!wide) addU(LK, -0.4);
    guard(TG, 0.5 * L, 0.36 * L);
  } else if (m === 'beside') {
    // Where we started (and the end of the values): small and close, hovering beside the words, turned toward them
    besideAnchor(s, L, ANC);
    depth = cam.dist * 0.8;
    unproject(ANC[0] + 6 * Math.sin(bT * 0.7), ANC[1] + bob * L * 0.5, depth, TG);
    unproject(ANC[0] + ANC[2] * L * (wide ? 2 : 0.6), ANC[1] + (wide ? 0.1 : 0.8) * L, depth, LK);
    guard(TG, 0.5 * L, 0.36 * L);
  } else if (m === 'sip') {
    // Contact: it hovers by the address with its beak toward it, and every few seconds dips in twice, sipping
    const sy = window.scrollY || 0;
    let ex, ey;
    if (wide) { ex = Math.max(s.ar + 40, s.sr + 50); ey = (s.at + s.ab) * 0.5 - sy; ANC[0] = ex + 0.5 * L; ANC[1] = clamp(ey - 0.32 * L, hdrPx() + 0.6 * L, cssH - 0.5 * L); }
    else { ex = s.ar - 0.2 * L; ey = s.st - sy; ANC[0] = cssW * 0.64; ANC[1] = clamp(s.st - sy - 50 - 0.4 * L, hdrPx() + 0.45 * L, cssH * 0.5); }
    depth = cam.dist * 0.74;
    const cyc = bModeT % 3.4, dip = cyc < 1.5 ? Math.pow(Math.max(0, Math.sin(cyc / 0.75 * Math.PI)), 2) : 0;
    const dx = ex - ANC[0], dy = (wide ? ey : ey + 30) - ANC[1], dl = Math.hypot(dx, dy) || 1;
    unproject(ANC[0] + dx / dl * dip * 0.09 * L, ANC[1] + dy / dl * dip * 0.09 * L + bob * L * 0.4, depth, TG);
    unproject(ANC[0] + dx / dl * L, ANC[1] + dy / dl * L, depth, LK);
    guard(TG, 0.5 * L, 0.36 * L);
  } else if (m === 'dart') {
    // Be bold: it hovers, then darts forward - out toward you - overshoots a little, holds, and backs off to try again
    const cyc = bModeT % 5.6, out = cyc > 1.7 && cyc < 3.9;
    if (wide) { const left = s.side === 'left'; ANC[0] = cssW * (left ? 0.33 : 0.66); ANC[1] = cssH * 0.47; }
    else { ANC[0] = cssW * 0.42; ANC[1] = Math.min(cssH * 0.26, (s.st - (window.scrollY || 0)) - 0.5 * L); }
    const dir = wide && s.side === 'left' ? -1 : 1;
    const fx = ANC[0] + dir * (wide ? 0.07 : 0.2) * cssW, fy = ANC[1] - (wide ? 0.07 : 0.02) * cssH;
    depth = cam.dist * (out ? 0.7 : 1.0);
    unproject(out ? fx : ANC[0], (out ? fy : ANC[1]) + bob * L * 0.4, depth, TG);
    unproject(fx + dir * L * 1.5, fy - 0.05 * L, cam.dist * 0.6, LK);
    if (out) { BPm.om = 8.5; BPm.ze = 0.42; BPm.vmax = 9; BPm.faceVel = 0.85; }
    else { BPm.om = 3.4; BPm.ze = 0.95; BPm.vmax = 2.2; }   // backing off: still looking ahead, so it flies backwards
    guard(TG, 0.5 * L, 0.36 * L);
  } else if (m === 'visit') {
    /* a visit, in a free part of the layout: (0) it hovers and looks at the heading, then at you, then back; (1) it
       hovers, darts a short way across, and holds; (2) it drifts a slow, small loop, looking about */
    if (!app.spot) emptySpot(s, L);
    depth = cam.dist * 0.82;
    const v = app.v, tt = bModeT;
    let x = app.x, y = app.y, ahead = false;
    if (v === 1) {
      ahead = tt > 1.5 && tt < 3.3;
      if (tt > 1.5) { x += app.dx; y += app.dy; }
      if (ahead) { BPm.om = 7.5; BPm.ze = 0.55; BPm.vmax = 7; BPm.faceVel = 0.85; } else { BPm.om = 3.6; BPm.ze = 0.95; BPm.vmax = 2.4; }
    } else if (v === 2) {
      x += Math.sin(tt * 0.9) * 0.35 * L; y += Math.sin(tt * 1.8) * 0.12 * L; BPm.om = 3.4;
    }
    unproject(x, y + bob * L * 0.4, depth, TG);
    if (ahead) unproject(x + app.dx * 1.5, y + app.dy * 1.5, depth, LK);
    else if (v !== 1 && (tt % 3.4) > 2.0) { cpy(LK, TG); addCam(LK, 1.2); addU(LK, 0.08); }      // a look at the visitor
    else { const sy = window.scrollY || 0; unproject((s.al + s.ar) * 0.5, (s.at + s.ab) * 0.5 - sy, depth, LK); }   // the heading
    guard(TG, 0.5 * L, 0.36 * L);
  } else if (m === 'tap') {
    // summoned: it gathers where it was called, on the open side of the spot, and looks at the pointer (a mouse is
    // followed as it moves; a finger is where it touched)
    depth = cam.dist * 0.78;
    const side = app.x < cssW * 0.5 ? 1 : -1;
    // the place chosen at the summon (clear of the words), while the page has not moved far since
    const held = app.placed && Math.abs((window.scrollY || 0) - app.sy0) < 24;
    const ox = held ? app.ox : app.x + side * (app.touch ? 0.26 : 0.36) * L, oy = held ? app.oy : app.y - (app.touch ? 0.44 : 0.12) * L;
    unproject(ox, oy + bob * L * 0.4, depth, TG);
    let lx = app.x, ly = app.y;
    if (!app.touch && ptr.has && ptr.inside) { lx = ptr.x; ly = ptr.y; }
    if (Math.hypot(lx - ox, ly - oy) < 0.22 * L) { lx = ox - side * L; ly = oy + 0.1 * L; }
    unproject(lx, ly, depth, LK);
    bStagA = 0.8; bStagD = 0.6; bDur = 0.42;
    guard(TG, 0.42 * L, 0.3 * L, held);
  }
  bird.sT = L / (1.04 * ppuAt(depth));
  if (app.on && app.kind === 'feature' && m !== 'hero' && bModeT < 0.45 && !bWant) want = 0;   // the formation starts to flow first
  setWant(want, shareFor(L));
}
/* ---- flight: a spring toward the target with limits on acceleration and speed - under-damped for darts, so they
   overshoot, critically damped for hovering ---- */
function birdPhysics(dt) {
  const k = 1 - Math.exp(-dt * 3);
  bird.om = lerp(bird.om, BPm.om, k); bird.ze = lerp(bird.ze, BPm.ze, k); bird.vmax = lerp(bird.vmax, BPm.vmax, k);
  const sc = cam.dist / 5.5, om = bird.om, ze = bird.ze, vmax = bird.vmax * sc, amax = 30 * sc;
  const n = Math.min(12, Math.max(1, Math.ceil(dt * 120))), h = dt / n;
  const tx = TG[0], ty = TG[1], tz = TG[2];
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < n; i++) {
    ax = om * om * (tx - bird.x) - 2 * ze * om * bird.vx; ay = om * om * (ty - bird.y) - 2 * ze * om * bird.vy; az = om * om * (tz - bird.z) - 2 * ze * om * bird.vz;
    const al = Math.hypot(ax, ay, az); if (al > amax) { const f = amax / al; ax *= f; ay *= f; az *= f; }
    bird.vx += ax * h; bird.vy += ay * h; bird.vz += az * h;
    const vl = Math.hypot(bird.vx, bird.vy, bird.vz); if (vl > vmax) { const f = vmax / vl; bird.vx *= f; bird.vy *= f; bird.vz *= f; }
    bird.x += bird.vx * h; bird.y += bird.vy * h; bird.z += bird.vz * h;
  }
  const ka = 1 - Math.exp(-dt * 10); bird.ax = lerp(bird.ax, ax, ka); bird.ay = lerp(bird.ay, ay, ka); bird.az = lerp(bird.az, az, ka);
  if (!(Math.abs(bird.x) + Math.abs(bird.y) + Math.abs(bird.z) + Math.abs(bird.vx) < 1e4)) { bird.x = TG[0]; bird.y = TG[1]; bird.z = TG[2]; bird.vx = bird.vy = bird.vz = 0; }
}
/* ---- attitude: facing, pitch, bank, tail, wingbeat ----
   The bird turns in the camera's frame (screen right, screen up, toward the viewer), not the world's: wherever the
   camera looks from, high over the nest or level with the stroke, it is seen in a three-quarter profile. Positions and
   flight stay in the world. */
const LV3 = new Float32Array(3);
function toLocal(x, y, z, o) { o[0] = x * cam.rx + y * cam.ry + z * cam.rz; o[1] = x * cam.ux + y * cam.uy + z * cam.uz; o[2] = -(x * cam.fx + y * cam.fy + z * cam.fz); return o; }
function faceToward(dx, dz) {   // a direction in the camera's horizontal plane, turned a little toward the viewer
  dz += 0.3;
  return Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) : bird.yaw;
}
function birdOrient(dt) {
  const sc = cam.dist / 5.5, spd = Math.hypot(bird.vx, bird.vy, bird.vz) / sc;
  toLocal(LK[0] - bird.x, LK[1] - bird.y, LK[2] - bird.z, LV3);
  const lx = LV3[0], ly = LV3[1], lz = LV3[2], lh = Math.hypot(lx, lz), ll = Math.hypot(lh, ly) || 1;
  toLocal(bird.vx, bird.vy, bird.vz, LV3);
  const vx = LV3[0], vy = LV3[1], vz = LV3[2];
  let dx = lh > 1e-4 ? lx / lh : Math.sin(bird.yaw), dz = lh > 1e-4 ? lz / lh : Math.cos(bird.yaw);
  const vh = Math.hypot(vx, vz), wv = vh > 1e-4 ? BPm.faceVel * smooth((spd - 0.35) / 1.4) : 0;
  if (wv > 0) { dx = lerp(dx, vx / vh, wv); dz = lerp(dz, vz / vh, wv); }
  let d = faceToward(dx, dz) - bird.yaw; d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const st = clamp(d, -9 * dt, 9 * dt);
  bird.yaw += st; bird.yawV = lerp(bird.yawV, dt > 0 ? st / dt : 0, 1 - Math.exp(-dt * 8));
  const fx = Math.sin(bird.yaw), fz = Math.cos(bird.yaw), fwd = (vx * fx + vz * fz) / sc;
  // upright when hovering (as a hummingbird hangs at a flower), level in fast flight, more upright still when flying
  // backwards. It looks up or down mostly with its head, so a bird sipping below it stays upright and bows the needle.
  const look = clamp(ly / ll, -0.75, 0.75) * (1 - wv);
  const pT = 0.76 - 0.58 * smooth((fwd - 0.6) / 2.6) + 0.16 * smooth((-fwd - 0.2) / 1.2) + look * 0.12 + clamp(vy / sc, -2, 2) * 0.05;
  bird.pitch = lerp(bird.pitch, pT, 1 - Math.exp(-dt * 6));
  bird.head = lerp(bird.head, -look * 0.62, 1 - Math.exp(-dt * 5));
  toLocal(bird.ax, bird.ay, bird.az, LV3);
  const alat = (-LV3[0] * fz + LV3[2] * fx) / sc;   // acceleration toward its right: bank into the turn
  bird.roll = lerp(bird.roll, clamp(-alat * 0.03 + bird.yawV * 0.035, -0.85, 0.85), 1 - Math.exp(-dt * 7));
  const brake = smooth((-(bird.ax * bird.vx + bird.ay * bird.vy + bird.az * bird.vz) / (sc * sc) - 3) / 18);
  bird.spread = lerp(bird.spread, 0.7 + 0.5 * brake + 0.12 * (1 - Math.min(spd, 1)), 1 - Math.exp(-dt * 6));
  bird.tail = 0.06 + 0.15 * Math.sin(bT * 2.6 + Math.sin(bT * 0.9)) * (1 - Math.min(spd / 2, 1)) + 0.3 * (bird.pitch - 0.4);
  const amag = Math.hypot(bird.ax, bird.ay, bird.az) / (30 * sc);
  bird.psi += TAU * (11.5 + 4.5 * Math.min(amag, 1)) * BPm.beat * dt;
  if (bird.psi > 1e4) bird.psi -= TAU * 1000;
}
/* ---- pose: the 128 vertices in the world ---- */
let AFx = 0, AFy = 0, AFz = 0, AUx = 0, AUy = 0, AUz = 0, ARx = 0, ARy = 0, ARz = 0;
// a vector in the camera's frame (right, up, toward the viewer), into the world
function fromLocal(a, b, c, o, k) { o[k] = a * cam.rx + b * cam.ux - c * cam.fx; o[k + 1] = a * cam.ry + b * cam.uy - c * cam.fy; o[k + 2] = a * cam.rz + b * cam.uz - c * cam.fz; }
function birdAxes(s) {
  const fx = Math.sin(bird.yaw), fz = Math.cos(bird.yaw), rx = -fz, rz = fx;
  const cp = Math.cos(bird.pitch), sp = Math.sin(bird.pitch), cr = Math.cos(bird.roll), sr = Math.sin(bird.roll);
  const Ux = -fx * sp, Uy = cp, Uz = -fz * sp;
  const Rx = rx * cr + Ux * sr, Ry = Uy * sr, Rz = rz * cr + Uz * sr;
  const U2x = Ux * cr - rx * sr, U2y = Uy * cr, U2z = Uz * cr - rz * sr;
  fromLocal(fx * cp, sp, fz * cp, BAX, 0); fromLocal(U2x, U2y, U2z, BAX, 3); fromLocal(Rx, Ry, Rz, BAX, 6);
  AFx = BAX[0] * s; AFy = BAX[1] * s; AFz = BAX[2] * s; AUx = BAX[3] * s; AUy = BAX[4] * s; AUz = BAX[5] * s; ARx = BAX[6] * s; ARy = BAX[7] * s; ARz = BAX[8] * s;
}
function bput(i, x, y, z) {
  const o = i * 3;
  BVW[o] = bird.x + x * AFx + y * AUx + z * ARx; BVW[o + 1] = bird.y + x * AFy + y * AUy + z * ARy; BVW[o + 2] = bird.z + x * AFz + y * AUz + z * ARz;
}
// the head bends at the neck so the needle stays near level while the body hangs upright in a hover
function headPut(i, v, cb, sb) {
  if (v[0] <= 0.1) { bput(i, v[0], v[1], v[2]); return; }
  const dx = v[0] - 0.1, dy = v[1] - 0.03;
  bput(i, 0.1 + dx * cb + dy * sb, 0.03 - dx * sb + dy * cb, v[2]);
}
function birdPose() {
  birdAxes(bird.s);
  const nb = clamp(clamp(bird.pitch - 0.12, 0, 0.8) * 0.66 + bird.head, -0.3, 1.05), cb = Math.cos(nb), sb = Math.sin(nb);
  for (let i = 0; i < B_T0; i++) headPut(i, BV0[i], cb, sb);
  // the tail pumps and fans (it spreads when braking)
  const ta = bird.tail, ct = Math.cos(ta), st = Math.sin(ta), sp = bird.spread, rx = TAILV[0][0], ry = TAILV[0][1];
  for (let i = 0; i < TAILV.length; i++) { const v = TAILV[i], dx = v[0] - rx, dy = v[1] - ry; bput(B_T0 + i, rx + dx * ct - dy * st, ry + dx * st + dy * ct, v[2] * sp); }
  // the wings: stroke forward and back in a plane kept level, the tip rising and falling twice a beat (a figure-eight),
  // the wing turning over between strokes. Ghosts are the same wing a little earlier in the beat.
  const pb = bird.pitch * 0.85, snx = Math.sin(pb), sny = Math.cos(pb);
  for (let g = 0; g < G_N; g++) {
    const ps = bird.psi - g * G_SP;
    const phi = 1.02 * Math.cos(ps) - 0.2, el = 0.1 + 0.22 * Math.sin(2 * ps + 0.4), al = 0.18 + 0.85 * Math.sin(ps);
    const ca = Math.cos(al), sa = Math.sin(al), ce = Math.cos(el), se = Math.sin(el), cph = Math.cos(phi), sph = Math.sin(phi);
    const b0 = B_W0 + g * 18;
    for (let i = 0; i < 9; i++) {
      const v = WINGV[i];
      const x2 = v[0] * ca - v[1] * sa, y1 = v[0] * sa + v[1] * ca, z1 = v[2];
      const y2 = y1 * ce + z1 * se, z2 = z1 * ce - y1 * se;
      const kd = snx * x2 + sny * y2;
      const x3 = x2 * cph + sny * z2 * sph + snx * kd * (1 - cph);
      const y3 = y2 * cph - snx * z2 * sph + sny * kd * (1 - cph);
      const z3 = z2 * cph + (snx * y2 - sny * x2) * sph;
      bput(b0 + i, x3 + SHOULDER[0], y3 + SHOULDER[1], z3 + SHOULDER[2]);
      bput(b0 + 9 + i, x3 + SHOULDER[0], y3 + SHOULDER[1], -z3 - SHOULDER[2]);
    }
  }
  for (let i = B_E0; i < NBV; i++) headPut(i, BV0[i], cb, sb);
}
function birdPlaceNow() {
  bird.x = TG[0]; bird.y = TG[1]; bird.z = TG[2]; bird.vx = bird.vy = bird.vz = 0; bird.ax = bird.ay = bird.az = 0;
  bird.s = bird.sT;
  toLocal(LK[0] - TG[0], LK[1] - TG[1], LK[2] - TG[2], LV3);
  const h = Math.hypot(LV3[0], LV3[2]) || 1;
  bird.yaw = faceToward(LV3[0] / h, LV3[2] / h); bird.yawV = 0; bird.roll = 0; bird.pitch = 0.72; bird.head = 0;
}
function updateBird(dt) {
  // clocks that only ever need to reach a few seconds are held there (the shader reads bClk as a 32-bit float)
  bT += dt; bClk = Math.min(bClk + dt, 600);
  if (revealed) bSince = bSince < 0 ? 0 : bSince + dt;
  bLevel = clamp(bLevel + (bWant ? dt / (bStagA + bDur) : -dt / (bStagD + bDur * 1.6)), 0, 1);
  birdDirect(dt);
  if (bPlace) { bPlace = false; birdPlaceNow(); }
  bird.s = lerp(bird.s, bird.sT, 1 - Math.exp(-dt * 3));
  birdPhysics(dt);
  birdOrient(dt);
  birdPose();
  playStep(dt);
  const n = Math.max(24, bShare * active);
  bLen = 2.35 * Math.sqrt(B_AEFF * bird.s * bird.s / n) / lenBase;
  const B = DBG.bird; B.mode = bMode; B.kind = app.on ? app.kind : ''; B.on = app.on; B.phase = hero.phase; B.want = bWant; B.share = Math.round(bShare * 1000) / 1000; B.level = Math.round(bLevel * 100) / 100; B.n = Math.round(n);
  B.next = Math.round((nextAuto - bT) * 10) / 10;
  if (orb.tagF !== orb.fly || orb.tagN !== orb.bumps || orb.tagL !== orb.live) { orb.tagF = orb.fly; orb.tagN = orb.bumps; orb.tagL = orb.live; B.orb = orb.live ? (orb.fly ? 'fly' : 'rest') + ':' + orb.bumps : ''; }   // a new string only when it changes
  project(bird.x, bird.y, bird.z, P3); B.sx = Math.round(P3[0]); B.sy = Math.round(P3[1]); B.px = Math.round(1.04 * bird.s * ppuAt(P3[2]));
}
// reduced motion: the bird (where a section has one, or where it was summoned) formed and still, in a calm pose, the
// ghosts of the beat left out. Nothing turns up on its own.
function birdStill() {
  const f = FEATURE[targetKey] || '', tapOn = stillTap.until > performance.now();
  appSec = activeIdx; pendFeat = ''; app.on = false; lastB = '';
  orbReset();
  if (tapOn) { startApp('tap', 'tap'); app.x = stillTap.x; app.y = stillTap.y; app.touch = stillTap.touch; }
  else if (f) startApp('feature', f);
  bModeT = 1.6; bSince = 1;
  const keep = revealed; revealed = true; const ih = introHold; introHold = false;
  try { birdDirect(0); bModeT = 1.6; birdDirect(0); } finally { revealed = keep; introHold = ih; }
  bPlace = false; birdPlaceNow();
  bird.psi = 2.15; bird.tail = 0.14; bird.spread = 0.85; bird.pitch = 0.72;
  birdPose();
  bLen = 2.35 * Math.sqrt(B_AEFF * bird.s * bird.s / Math.max(24, bShare * active)) / lenBase;
  bLevel = bWant ? 1 : 0;   // the formation dims behind a bird that is there, and only then
  bGhost = 0; bSnap = true;
  DBG.bird.mode = bMode; DBG.bird.kind = app.on ? app.kind : ''; DBG.bird.level = bLevel;
}
// leaving the still frames (reduced motion switched off, or a restored context): the beat's ghosts come back, and the
// section's own scene starts again in its own time
function liveBird() { bGhost = 1; bSnap = false; app.on = false; lastB = ''; stillTap.until = 0; appSec = -2; hero.phase = 'wait'; }
/* ---- input: a tap or a click on an empty part of the page summons Flux there ----
   Not on a control (links, buttons, form fields, the header, the menus), not on a line of words, not while text is
   selected, and only a short press that has not moved: a finger that drags is scrolling. All listeners are passive. */
const NOTAP = 'a,button,input,textarea,select,label,summary,[role="button"],[contenteditable],.hdr,.menu,.v-rail,.skip';
const TEXTY = 'p,h1,h2,h3,li,address,em,span';
const TRG = doc.createRange();
function onWords(t, x, y) {
  const el = t && t.closest ? t.closest(TEXTY) : null;
  if (!el) return false;
  try { TRG.selectNodeContents(el); const rs = TRG.getClientRects(); for (let i = 0; i < rs.length; i++) { const q = rs[i]; if (x >= q.left - 4 && x <= q.right + 4 && y >= q.top - 4 && y <= q.bottom + 4) return true; } } catch (e) {}
  return false;
}
function tapOK(t, x, y) {
  if (t && t.closest && t.closest(NOTAP)) return false;
  if (t && t.closest && t.closest('.flux-hint')) return true;   // the line that says how to call it calls it too
  if (onWords(t, x, y)) return false;
  try { const sel = window.getSelection(); if (sel && !sel.isCollapsed && String(sel).trim()) return false; } catch (e) {}
  return true;
}
let tpX = 0, tpY = 0, tpT = 0, tpE = 0, tpOK = false;
// how long a press lasted, from the events' own timestamps: a busy main thread (a slow GPU frame) must not turn a quick
// tap into a long press. Falls back to the handler's clock where an event has no usable timestamp.
const evT = e => (e && e.timeStamp > 0 ? e.timeStamp : performance.now());
DBG.summon = (x, y, touch) => summon(x, y, touch);
DBG.autoIn = sec => { nextAuto = bT + sec; };
DBG.sched = () => ({ pendFeat, pendAt: Math.round(pendAt * 10) / 10, bT: Math.round(bT * 10) / 10, appSec, activeIdx, sinceScroll: Math.round(performance.now() - lastScrollAt), on: app.on, b: app.b, blending, calm: calm() });
DBG.bs = () => ({ bWant, bShare, bSnap, bGhost, bLen, bMode, hero: hero.phase, app: Object.assign({}, app), x: bird.x, y: bird.y, z: bird.z, s: bird.s, sT: bird.sT, tg: [TG[0], TG[1], TG[2]], orb: { x: orb.x, y: orb.y, R: orb.R, fly: orb.fly, bumps: orb.bumps } });
// a touch that lands while the page is still gliding is stopping a fling, not asking for a bird
let lastScrollAt = -1e9;
window.addEventListener('scroll', () => { lastScrollAt = performance.now(); }, { passive: true });
function tapStart(x, y, target, e) { tpX = x; tpY = y; tpT = performance.now(); tpE = evT(e); tpOK = tpT - lastScrollAt > 140 && tapOK(target, x, y); }
window.addEventListener('touchstart', e => { const t = e.touches[0]; if (!t || e.touches.length > 1) { tpOK = false; return; } tapStart(t.clientX, t.clientY, e.target, e); }, { passive: true });
window.addEventListener('touchmove', e => { const t = e.touches[0]; if (t && Math.hypot(t.clientX - tpX, t.clientY - tpY) > 12) tpOK = false; }, { passive: true });
window.addEventListener('touchend', e => { if (tpOK && evT(e) - tpE < 500) summon(tpX, tpY, true); tpOK = false; }, { passive: true });
window.addEventListener('touchcancel', () => { tpOK = false; }, { passive: true });
window.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch' && e.button === 0) tapStart(e.clientX, e.clientY, e.target, e); }, { passive: true });
window.addEventListener('pointerup', e => { if (e.pointerType === 'touch') return; if (tpOK && evT(e) - tpE < 500 && Math.hypot(e.clientX - tpX, e.clientY - tpY) < 6) summon(e.clientX, e.clientY, false); tpOK = false; }, { passive: true });

/* ================= 8. GL =================
   UPDATE_VS: one vertex per feather, rasteriser off, results captured with transform feedback.
   form(kind) returns the target frame for this feather in one formation; main() blends, springs, ruffles, orients. */
const UPDATE_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec4 aP;
layout(location=1) in vec4 aV;
layout(location=2) in vec4 aF;
layout(location=3) in vec4 aN;
layout(location=4) in vec4 aT;
layout(location=5) in vec4 aB;
layout(location=6) in vec4 aS0;
layout(location=7) in vec4 aS1;
out vec4 oP;
out vec4 oV;
out vec4 oF;
out vec4 oN;
out vec4 oT;
out vec4 oB;
uniform float uT;
uniform float uDt;
uniform int uKA;
uniform int uKB;
uniform vec4 uPA;
uniform vec4 uPB;
uniform float uMixT;
uniform float uStag;
uniform float uDur;
uniform float uN;
uniform float uFlut;
uniform vec3 uRO;
uniform vec3 uRD;
uniform vec3 uPV;
uniform mat4 uVP;
uniform vec4 uSeg;
uniform float uAsp;
uniform float uPR;
uniform float uPS;
uniform float uPulse;
uniform float uBloom;
uniform float uSnap;
uniform float uK;
uniform highp sampler2D uPath;
uniform vec3 uBV[128];   // the bird, posed: world-space vertices
uniform vec4 uBO;        // its origin, its scale
uniform vec3 uBF;        // its forward, up and right (unit)
uniform vec3 uBU;
uniform vec3 uBX;
uniform vec4 uBM;        // wanted (0/1), share, seconds since either changed, snap
uniform vec4 uBT;        // assembly stagger, dissolve stagger, flight seconds, feather length on the bird
uniform float uBGh;      // presence of the wing's ghosts (0 in still frames)
uniform vec4 uOrb;       // the game's orb: centre, radius
uniform float uOrbF;     // its flash (1 at a touch)
uniform vec3 uTr[20];    // its last positions, newest first
uniform vec4 uRip;       // the pool's ripple: centre x, z, seconds since, strength
const float TAU=6.28318530718;
const float PI=3.14159265359;
uint hu(uint x){x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;x^=x>>16u;return x;}
float hf(uint x){return float(hu(x)>>8u)*(1.0/16777216.0);}
float gI;   // this feather's index as a fraction of the active count (for phyllotaxis); set in main()

/* ---- the target frame a formation hands each feather ---- */
struct F{vec3 p;vec3 t;vec3 n;float a;float s;float g;};
F mk(vec3 p,vec3 t,vec3 n,float a,float s,float g){F o;o.p=p;o.t=t;o.n=n;o.a=a;o.s=s;o.g=g;return o;}
vec3 rotA(vec3 v,vec3 k,float a){float c=cos(a),s=sin(a);return v*c+cross(k,v)*s+k*dot(k,v)*(1.0-c);}
void rotF(inout F o,vec3 k,float a){o.p=rotA(o.p,k,a);o.t=rotA(o.t,k,a);o.n=rotA(o.n,k,a);}
// a cheap divergence-free stir (curl of a trigonometric potential)
vec3 flow(vec3 p,float t){
  float ay=1.7*cos(1.7*p.y+0.3+t*0.11),az=1.45*cos(2.9*p.z+1.1-t*0.07),bz=1.9*cos(1.9*p.z+2.1+t*0.05);
  float bx=1.55*cos(3.1*p.x+0.4),cx=1.6*cos(1.6*p.x+0.7-t*0.09),cy=1.35*cos(2.7*p.y+2.5);
  return vec3(cy-bz,az-cx,bx-ay)*0.6;
}
// a closed curve from the path atlas, s in [0,1)
vec3 path(int row,float s){
  float x=fract(s)*512.0;int i=int(x);float f=x-float(i);
  return mix(texelFetch(uPath,ivec2(i,row),0).xyz,texelFetch(uPath,ivec2((i+1)&511,row),0).xyz,f);
}

/* WING - the wingpath figure-eight as a feathered ribbon that flows along the stroke.
   P: x ribbon width, y flow (path fraction per second), z halo spread, w twist. uBloom scales the width (loader). */
F fWing(vec4 q,vec4 r,vec4 P,float t){
  float s=q.x+t*P.y;
  vec3 c=path(0,s);
  vec3 T=normalize(path(0,s+0.003)-path(0,s-0.003));
  vec3 sd=normalize(cross(vec3(0.0,0.0,1.0),T));
  vec3 up=cross(T,sd);
  float tw=P.w*sin(s*TAU*2.0+t*0.3);
  vec3 sd2=sd*cos(tw)+up*sin(tw);
  vec3 n=up*cos(tw)-sd*sin(tw);
  float lane=q.y-0.5;
  bool halo=r.w>0.88;
  vec3 off=sd2*(lane*P.x)+n*((q.z-0.5)*P.x*0.14);
  if(halo){float rr=P.x*(0.58+P.z*r.z*r.z);float an=q.z*TAU;off=(sd2*cos(an)+n*sin(an)*0.5)*rr;}
  vec3 tt=normalize(T+sd2*(lane*0.75));  // a soft chevron: feathers lean out from the stroke like barbs from a shaft
  return mk(c+off*uBloom,tt,n,1.0,halo?0.8:1.0,0.0);
}

/* APPS - a web window and a phone, drawn by feathers travelling their outlines and lines of content.
   P: y current along the outlines. */
F fApps(vec4 q,vec4 r,vec4 P,float t){
  bool ph=q.x>=0.5;
  float lx=ph?(q.x-0.5)*2.0:q.x*2.0;
  vec3 p;vec3 T;float a=1.0,sz=1.0,g=0.0;
  if(lx<0.6){
    int row=ph?2:1;
    float s=lx/0.6+t*P.y*(ph?-1.3:1.0);
    vec3 c=path(row,s);
    T=normalize(path(row,s+0.004)-c);
    vec3 o=normalize(cross(vec3(0.0,0.0,1.0),T));
    p=c+o*(q.y-0.5)*0.045+vec3(0.0,0.0,(q.z-0.5)*0.03);
  }else{
    float k=(lx-0.6)/0.4;
    float bi=floor(k*5.0),u=fract(k*5.0);
    vec3 L;   // a line of content: y, start x, length (card units)
    if(!ph) L=bi<1.0?vec3(0.46,-0.88,1.76):bi<2.0?vec3(0.2,-0.84,0.92):bi<3.0?vec3(0.0,-0.84,1.3):bi<4.0?vec3(-0.2,-0.84,1.06):vec3(-0.4,-0.84,0.6);
    else L=bi<1.0?vec3(0.5,-0.24,0.48):bi<2.0?vec3(0.3,-0.24,0.34):bi<3.0?vec3(0.12,-0.24,0.42):bi<4.0?vec3(-0.06,-0.24,0.28):vec3(-0.5,-0.15,0.3);
    float s=fract(u+t*P.y*2.2);
    p=vec3(L.y+s*L.z,L.x+(q.y-0.5)*(bi<1.0&&!ph?0.02:0.035),(q.z-0.5)*0.02);
    T=vec3(1.0,0.0,0.0);
    a=smoothstep(0.0,0.08,s)*(1.0-smoothstep(0.9,1.0,s));
    sz=0.9;
  }
  if(!ph)p*=0.84;
  F o=mk(p,T,vec3(0.0,0.0,1.0),a,sz,g);
  rotF(o,vec3(0.0,1.0,0.0),ph?-0.3:0.34);
  rotF(o,vec3(1.0,0.0,0.0),-0.06);
  o.p+=ph?vec3(0.98,-0.24+0.035*sin(t*0.55+1.7),0.45):vec3(-0.3,0.14+0.03*sin(t*0.55),0.02);
  return o;
}

/* PLAY - Games: Flux keeps a small orb of feathers up. The orb (uOrb: centre, radius; uOrbF: the flash of a touch) and
   the feathers streaming behind it along its last 20 positions (uTr, newest first, 1/30 s apart) are played on the CPU;
   below them a shallow round pool of feathers swells slowly and ripples out from under each touch (uRip: centre x, z,
   seconds since, strength). P: x pool radius, y pool height. */
F fPlay(vec4 q,vec4 r,vec4 P,float t){
  if(r.w<0.07){
    float z=1.0-2.0*q.y,rr=sqrt(max(0.0,1.0-z*z)),an=q.z*TAU;
    vec3 d=vec3(rr*cos(an),z,rr*sin(an));
    vec3 ax=normalize(vec3(sin(t*0.6),1.4,cos(t*0.45)));
    vec3 tg=cross(ax,d);float tl=length(tg);tg=tl>1e-3?tg/tl:normalize(cross(d,vec3(1.0,0.0,0.0)));
    float R=uOrb.w*(0.84+0.16*r.z)*(1.0+0.12*uOrbF);
    return mk(uOrb.xyz+d*R,normalize(tg-d*0.25),d,1.0,0.5,0.3+0.65*uOrbF);
  }
  if(r.w<0.19){
    float k=(r.w-0.07)/0.12;
    float x=k*18.0;int i=int(x);float f=x-float(i);
    vec3 c=mix(uTr[i],uTr[i+1],f);
    vec3 dv=uTr[i+1]-uTr[i];float dl=length(dv);   // toward the older end: the shafts stream back
    vec3 rd=normalize(vec3(q.y,q.z,r.z)-0.5+vec3(1e-3,0.0,0.0));
    vec3 T=dl>1e-4?normalize(dv/dl+rd*0.35):normalize(cross(rd,vec3(0.0,1.0,0.0))+vec3(1e-3));
    return mk(c+rd*uOrb.w*(0.62-0.4*k),T,rd,pow(1.0-k,1.6),0.62-0.22*k,(0.22+0.5*uOrbF)*(1.0-k));   // a comet's tail: it tapers, never puffs into a second orb
  }
  if(r.w<0.5){
    // a faint mist of loose feathers lifting off the pool, turning slowly, fading as they rise
    float h=fract(q.y+t*0.04*(0.7+0.6*r.z));
    float th=q.x*TAU+t*0.07+h*1.4,rad=P.x*(0.3+0.85*sqrt(q.z));
    vec3 c=vec3(cos(th)*rad,P.y+0.04+h*0.42,sin(th)*rad);
    float a=smoothstep(0.0,0.25,h)*(1.0-smoothstep(0.4,1.0,h))*0.8;
    return mk(c,normalize(vec3(-sin(th),0.45,cos(th))),normalize(vec3(cos(th),0.5,sin(th))),a,0.72,0.05);
  }
  float rho=P.x*sqrt(gI),an=gI*uN*2.39996323;
  vec3 rd=vec3(cos(an),0.0,sin(an));
  float e=rho/P.x;
  vec3 c=vec3(rd.x*rho,P.y+0.022*sin(rho*9.0-t*0.9)+0.05*e*e,rd.z*rho);
  float dr=length(c.xz-uRip.xy)-uRip.z*0.8;
  float w=exp(-dr*dr/0.01)*uRip.w*exp(-uRip.z*1.3);
  c.y+=w*0.06;
  vec3 n=normalize(vec3(0.0,1.0,0.0)-rd*0.12*e+rd*w*0.6);
  vec3 T=normalize(vec3(-rd.z,0.0,rd.x)*0.9+rd*0.4);
  return mk(c,T,n,1.0-0.7*smoothstep(0.55,1.0,e),0.85,0.03+0.85*w);
}

/* ORB - a feathered sphere whose feathers follow a slowly changing current over its surface, so whorls form and
   dissolve; a smaller shell inside turns the other way. P: x radius, y turn speed. */
F fOrb(vec4 q,vec4 r,vec4 P,float t){
  float z=1.0-2.0*q.x,rr=sqrt(max(0.0,1.0-z*z)),an=q.y*TAU;
  vec3 d=vec3(rr*cos(an),z,rr*sin(an));
  bool inner=r.w>0.86;
  float R=P.x*(inner?0.58:1.0);
  float br=1.0+0.035*sin(dot(d,vec3(2.1,3.3,1.7))*2.0-t*1.1);
  vec3 p=d*(R*br+(q.z-0.5)*0.05);
  vec3 fl=flow(d*1.7+vec3(0.0,t*0.06,0.0),t*0.5);
  vec3 tg=fl-d*dot(fl,d);float tl=length(tg);
  tg=tl>1e-3?tg/tl:normalize(cross(d,vec3(0.0,1.0,0.0))+vec3(1e-3));
  F o=mk(p,tg,d,1.0,inner?0.8:1.0,inner?0.12:0.0);
  rotF(o,vec3(0.0,1.0,0.0),t*P.y*(inner?-1.8:1.0));
  return o;
}

/* box surface for slabs: mostly the top, then the long sides, a few on the ends; shafts along the long axis */
F slabPt(vec3 hs,vec4 q,float lq){
  vec3 p;vec3 n;vec3 T;
  if(lq<0.5){p=vec3((q.y*2.0-1.0)*hs.x,hs.y,(q.z*2.0-1.0)*hs.z);n=vec3(0,1,0);T=vec3(1,0,0);}
  else if(lq<0.86){float sg=lq<0.68?1.0:-1.0;p=vec3((q.y*2.0-1.0)*hs.x,(q.z*2.0-1.0)*hs.y,sg*hs.z);n=vec3(0,0,sg);T=vec3(1,0,0);}
  else{float sg=lq<0.93?1.0:-1.0;p=vec3(sg*hs.x,(q.z*2.0-1.0)*hs.y,(q.y*2.0-1.0)*hs.z);n=vec3(sg,0,0);T=vec3(0,0,1);}
  // feathers near a face's edge catch the light: a gilt line around every block
  vec2 e=abs(vec2(q.y,q.z)*2.0-1.0);
  float ed=smoothstep(0.86,0.99,max(e.x,e.y));
  return mk(p,T,n,1.0,1.0-0.12*ed,0.3*ed);
}

/* TOWER - Toppleton: slabs cross-stacked into a balanced tower that sways about its foot. P: x slabs, y sway. */
F fTower(vec4 q,vec4 r,vec4 P,float t){
  float n=P.x,k=floor(q.x*n),lq=fract(q.x*n);
  float hy=0.066,st=2.0*hy+0.05,base=-0.5*n*st;
  F o=slabPt(vec3(0.6-0.025*k+0.04*sin(k*1.7),hy,0.19),q,lq);
  o.g+=0.04*mod(k,2.0);
  o.t=normalize(o.t+cross(o.n,o.t)*(r.x-0.5)*0.3);
  rotF(o,vec3(0.0,1.0,0.0),(mod(k,2.0)<0.5?0.0:1.5708)+0.12*sin(k*2.17+0.4));
  o.p+=vec3(0.07*sin(k*2.3+0.7),hy+k*st,0.06*cos(k*1.9));
  float sw=P.y*sin(t*0.7-k*0.12);
  rotF(o,vec3(0.0,0.0,1.0),sw);rotF(o,vec3(1.0,0.0,0.0),sw*0.5);
  o.p.y+=base;
  return o;
}

/* NEST - Where we started: a warm woven bowl turning slowly, and an updraft of loose feathers. P: y turn speed. */
F fNest(vec4 q,vec4 r,vec4 P,float t){
  if(r.w<0.76){
    float rho=mix(0.5,1.12,q.y);
    float th=q.x*TAU+t*P.y*(0.7+0.6*q.z);
    float lay=floor(q.z*7.0);
    float e=(rho-0.5)/0.62;
    vec3 c=vec3(cos(th)*rho,-0.42+0.5*pow(e,1.6)+0.05*sin(th*5.0+lay*2.1)+(q.z-0.5)*0.12,sin(th)*rho);
    vec3 tg=vec3(-sin(th),0.0,cos(th)),rd=vec3(cos(th),0.0,sin(th));
    vec3 nr=normalize(vec3(0.0,1.0,0.0)-rd*0.8*pow(max(e,0.0),0.6));
    float wv=(mod(lay,2.0)<0.5?1.0:-1.0)*0.55;
    return mk(c,normalize(tg+nr*wv*0.6+rd*wv*0.4),nr,1.0,1.0,0.04);
  }
  float h=fract(q.y+t*0.035*(0.7+0.6*r.z));
  float th=q.x*TAU+t*0.22+h*3.0,rad=0.25+0.62*h;
  vec3 c=vec3(cos(th)*rad,-0.25+h*1.7,sin(th)*rad);
  float a=smoothstep(0.0,0.15,h)*(1.0-smoothstep(0.7,1.0,h));
  return mk(c,normalize(vec3(-sin(th),0.35,cos(th))),normalize(vec3(cos(th),0.6,sin(th))),a,0.9,0.08);
}

/* FOUR - the values teaser: four feather rosettes, the first the boldest and the last the smallest. */
F fFour(vec4 q,vec4 r,vec4 P,float t){
  float i=floor(q.x*4.0),lq=fract(q.x*4.0);
  float sc=i<1.0?1.12:i<2.0?0.78:i<3.0?0.92:0.6;
  float rho=pow(lq,0.55);
  float an=q.y*TAU+t*0.12*(mod(i,2.0)<0.5?1.0:-1.0)+rho*1.2;
  vec3 rd=vec3(cos(an),sin(an),0.0);
  // petals overlap like scales on a low dome, each facing a little outward, so the light draws a crescent across it
  vec3 p=rd*rho*0.46*sc+vec3(0.0,0.0,(1.0-rho*rho)*0.14*sc+(q.z-0.5)*0.02);
  vec3 T=normalize(rd+vec3(-sin(an),cos(an),0.0)*0.18+vec3(0.0,0.0,-0.2*rho));
  vec3 n=normalize(vec3(0.0,0.0,1.0)+rd*0.75*rho);
  F o=mk(p,T,n,1.0,0.85+0.25*sc,0.0);
  rotF(o,vec3(1.0,0.0,0.0),-0.35);rotF(o,vec3(0.0,1.0,0.0),0.3*sin(i*1.3+t*0.2));
  vec2 at=i<1.0?vec2(-0.5,0.4):i<2.0?vec2(0.48,0.52):i<3.0?vec2(-0.36,-0.5):vec2(0.52,-0.36);
  o.p+=vec3(at.x,at.y+0.05*sin(t*0.4+i*1.7),0.2*cos(i*2.3+0.2));
  return o;
}

/* SETTLE - Contact: feathers come to rest one by one on a low heap, laid along a golden spiral, while a slow glint
   travels over them; a few are still drifting down, rocking. P: x radius, y heap height. */
F fSettle(vec4 q,vec4 r,vec4 P,float t){
  if(r.w<0.87){
    float k=gI;
    float rho=P.x*sqrt(clamp(k,0.0,1.0)),an=gI*uN*2.39996323;   // phyllotaxis: index times the golden angle
    float e=rho/P.x;
    float y=-0.6+P.y*pow(max(1.0-e*e,0.0),0.85)+0.018*sin(rho*9.0-t*0.5);
    vec3 rd=vec3(cos(an),0.0,sin(an)),tg=vec3(-sin(an),0.0,cos(an));
    vec3 c=vec3(rd.x*rho,y,rd.z*rho);
    float sl=1.7*P.y*e*pow(max(1.0-e*e,0.001),-0.15)/P.x;              // slope of the heap here
    vec3 n=normalize(vec3(0.0,1.0,0.0)+rd*sl);
    vec3 T=normalize(rd*0.42+tg*0.9-n*0.1);                              // laid around the spiral, tips outward
    return mk(c,T,n,1.0,1.0,0.0);
  }
  float h=fract(q.y+t*0.03*(0.6+0.8*r.z));
  float rock=sin(t*1.1+r.x*TAU);
  float ra=0.15+0.85*sqrt(fract(q.z*3.7)),aa=q.x*TAU+t*0.05;
  vec3 c=vec3(cos(aa)*ra*P.x+rock*0.14,1.2-h*1.5,sin(aa)*ra*P.x*0.8);
  float a=smoothstep(0.0,0.12,h)*(1.0-smoothstep(0.78,1.0,h));
  return mk(c,normalize(vec3(cos(r.x*TAU),rock*0.35,sin(r.x*TAU))),normalize(vec3(rock*0.5,1.0,0.0)),a,1.0,0.05);
}

/* SWEEP - Be bold: one broad band of feathers rushing forward, widening and banking as it goes.
   P: x width, y speed. Feathers fade at both ends and re-enter at the back while invisible. */
vec3 sweepC(float s){return vec3(mix(-1.75,1.25,s),-0.7+1.1*s*s-0.1*sin(s*PI),0.8*sin(s*PI)-0.45*s);}
F fSweep(vec4 q,vec4 r,vec4 P,float t){
  float s=fract(q.x+t*P.y*(0.9+0.2*r.z));
  vec3 c=sweepC(s);vec3 T=normalize(sweepC(s+0.004)-c);
  vec3 sd=normalize(cross(vec3(0.0,0.25,1.0),T));vec3 n=normalize(cross(T,sd));
  float w=P.x*(0.12+0.88*pow(s,1.25)),lane=q.y-0.5,bk=0.6*s;
  vec3 sd2=sd*cos(bk)+n*sin(bk),n2=n*cos(bk)-sd*sin(bk);
  float a=smoothstep(0.0,0.07,s)*(1.0-smoothstep(0.88,1.0,s));
  return mk(c+sd2*lane*w*2.0+n2*(q.z-0.5)*0.06,normalize(T-sd2*lane*0.9),n2,a,1.0+0.3*s,0.06*s);
}

/* TINKER - twenty small clusters, each trying a new shape every few seconds (ring, square, helix, bars, shell,
   triangle), each on its own clock, flashing briefly as it changes. P: x cluster size, y seconds per shape. */
vec3 tShape(int k,float u,float v,out vec3 T){
  if(k==0){float a=u*TAU;T=vec3(-sin(a),cos(a),0.0);return vec3(cos(a),sin(a),(v-0.5)*0.15);}
  if(k==1){float e=floor(u*4.0),s=fract(u*4.0)*2.0-1.0;
    T=e<1.0?vec3(1,0,0):e<2.0?vec3(0,1,0):e<3.0?vec3(-1,0,0):vec3(0,-1,0);
    return (e<1.0?vec3(s,-1,0):e<2.0?vec3(1,s,0):e<3.0?vec3(-s,1,0):vec3(-1,-s,0))*0.8;}
  if(k==2){float a=u*TAU*2.0;T=normalize(vec3(-sin(a)*0.7,0.25,cos(a)*0.7));return vec3(cos(a)*0.7,u*2.0-1.0,sin(a)*0.7);}
  if(k==3){float b=floor(u*3.0),s=fract(u*3.0)*2.0-1.0;T=vec3(1,0,0);return vec3(s*(1.0-b*0.22),(b-1.0)*0.55,(v-0.5)*0.2);}
  if(k==4){float a=u*TAU,b=acos(1.0-2.0*v);T=normalize(vec3(-sin(a),0.0,cos(a)));return vec3(sin(b)*cos(a),cos(b),sin(b)*sin(a))*0.85;}
  float e=floor(u*3.0),s=fract(u*3.0);
  vec3 A=vec3(0,1,0),B=vec3(0.87,-0.5,0),Cc=vec3(-0.87,-0.5,0);
  vec3 p0=e<1.0?A:e<2.0?B:Cc,p1=e<1.0?B:e<2.0?Cc:A;
  T=normalize(p1-p0);return mix(p0,p1,s);
}
F fTinker(vec4 q,vec4 r,vec4 P,float t){
  float c=floor(q.x*20.0),u=fract(q.x*20.0);
  float gx=mod(c,5.0),gy=floor(c/5.0);
  vec3 ctr=vec3((gx-2.0)*0.5+0.09*sin(c*3.1),(gy-1.5)*0.47+0.07*cos(c*2.3),0.3*sin(c*1.7+0.5));
  float ph=t/P.y+c*0.37,i0=floor(ph),f=smoothstep(0.62,1.0,fract(ph));
  vec3 Ta;vec3 Tb;
  vec3 pa=tShape(int(mod(i0+c,6.0)),u,q.y,Ta),pb=tShape(int(mod(i0+c+1.0,6.0)),u,q.y,Tb);
  vec3 T=normalize(mix(Ta,Tb,f)+vec3(1e-4));
  vec3 n=vec3(0.0,0.0,1.0);n=n-T*dot(n,T);n=length(n)>1e-3?normalize(n):vec3(0.0,1.0,0.0);
  F o=mk(mix(pa,pb,f)*P.x,T,n,1.0,0.85,0.16*sin(PI*f));
  rotF(o,normalize(vec3(sin(c),1.0,cos(c*1.3))),t*0.35*(mod(c,2.0)<0.5?1.0:-1.0)+c);
  o.p+=ctr;
  return o;
}

/* COLLAPSE - Fail fast. Learn faster: a stack wobbles, topples (top slab first), lies scattered, then re-forms bottom
   first with a flash. Each slab turns a full 2 pi over the cycle, so the loop has no seam. P: x slabs, y cycle seconds. */
F fCollapse(vec4 q,vec4 r,vec4 P,float t){
  float n=P.x,k=floor(q.x*n),lq=fract(q.x*n);
  float hy=0.075,st=2.0*hy+0.02,base=-0.62;
  F o=slabPt(vec3(0.5-0.02*k,hy,0.18),q,lq);
  rotF(o,vec3(0.0,1.0,0.0),(mod(k,2.0)<0.5?0.0:1.5708)+0.1*sin(k*2.1));
  float tc=mod(t,P.y);
  float dir=mod(k*7.0+1.0,2.0)<0.5?1.0:-1.0;
  float fall=clamp((tc-2.7-(n-1.0-k)*0.07)/0.75,0.0,1.0);
  float back=smoothstep(0.0,1.0,clamp((tc-4.9-k*0.16)/0.9,0.0,1.0));
  rotF(o,vec3(0.0,0.0,1.0),dir*PI*(smoothstep(0.0,1.0,fall)+back));
  vec3 cs=vec3(0.05*sin(k*2.3),base+hy+k*st,0.0);
  vec3 gr=vec3(dir*(0.42+0.1*k),-1.02+hy+0.025*k,0.32*sin(k*3.7));
  vec3 pos=mix(mix(cs,gr,fall*fall),cs,back)+vec3(0.0,sin(PI*fall)*0.12*(1.0-back)+sin(PI*back)*0.38,0.0);
  // the wobble before it goes
  float wb=0.05*smoothstep(1.7,2.7,tc)*(1.0-fall)*sin(tc*11.0)*(k/n);
  pos.x+=wb*(pos.y-base);
  o.p+=pos;o.g+=0.14*sin(PI*back);
  return o;
}

/* MACRO - Sweat the small stuff: one large feather built from small ones - a rachis, barbs that leave it toward the
   tip (with a couple of natural splits), and a downy afterfeather at the base. Seen close. */
vec3 rach(float s){return vec3(-0.1+0.3*s+0.12*sin(s*PI*0.9),-1.7+3.4*s,0.12*sin(s*PI));}
F fMacro(vec4 q,vec4 r,vec4 P,float t){
  F o;
  if(q.x<0.1){
    float s=q.x/0.1;
    vec3 c=rach(s),T=normalize(rach(s+0.01)-c),sd=normalize(cross(vec3(0.0,0.0,1.0),T));
    o=mk(c+sd*(q.y-0.5)*0.05*(1.0-0.8*s)+vec3(0.0,0.0,(q.z-0.5)*0.02),T,vec3(0.0,0.0,1.0),1.0,1.1,0.06);
  }else if(q.x<0.93){
    float k=(q.x-0.1)/0.83;
    float side=q.y<0.5?-1.0:1.0;
    float nb=floor(clamp(uN/190.0,30.0,110.0));
    float bi=floor(k*nb),a=fract(k*nb);
    float s0=0.06+0.92*(bi+0.5)/nb;
    vec3 c0=rach(s0),T0=normalize(rach(s0+0.01)-c0),sd=normalize(cross(vec3(0.0,0.0,1.0),T0))*side;
    float L=(side<0.0?0.42:0.62)*pow(sin(PI*pow(s0,0.72)),0.75)*(1.0-0.25*s0);
    float sp=side>0.0?smoothstep(0.022,0.0,abs(s0-0.47))*0.1+smoothstep(0.016,0.0,abs(s0-0.71))*0.08:smoothstep(0.02,0.0,abs(s0-0.58))*0.1;
    vec3 dir=normalize(sd+T0*(0.55+0.25*s0));
    float bend=0.18+sp*2.0;
    vec3 p=c0+dir*(a*L)+T0*(a*a*L*bend);
    p.z+=-0.12*a*a*L+0.04*sin(s0*9.0-t*0.9)*a;
    vec3 n=normalize(vec3(0.0,0.0,1.0)+sd*0.25*a);
    o=mk(p+n*(q.z-0.5)*0.008,normalize(dir+T0*(2.0*a*bend)),n,1.0,0.78+0.32*(1.0-a),0.0);
  }else{
    float s=0.02+0.12*q.y,an=q.z*TAU;
    vec3 d=vec3(cos(an),sin(an)*0.6+0.3,sin(an)*0.4);
    vec3 p=rach(s)+d*(0.12+0.25*r.z)*sqrt(r.y)+vec3(0.0,0.05*sin(t*1.2+r.x*6.0),0.0);
    vec3 T=normalize(d+vec3(0.0,0.4,0.0)+0.3*vec3(sin(t+r.x*9.0),0.0,cos(t*0.8+r.y*7.0)));
    o=mk(p,T,normalize(cross(T,vec3(0.0,0.0,1.0))+vec3(0.0,0.0,0.6)),0.85,0.8,0.03);
  }
  rotF(o,vec3(0.0,0.0,1.0),-0.62);
  rotF(o,vec3(0.0,1.0,0.0),0.18*sin(t*0.25));
  return o;
}

/* BIRD - this feather's own spot on the posed bird: a fixed point of one triangle, lying along the facet (so each facet
   catches the light as one), shaft toward the tail - toward the wingtip and trailing edge on a wing, along the needle on
   the beak. The wing's ghosts (parts 7-9) are the same wing a little earlier in the beat, drawn fainter: the blur. */
F birdF(int part,vec4 r){
  vec3 A=uBV[int(aS0.x)],B=uBV[int(aS0.y)],Cc=uBV[int(aS0.z)];
  vec3 p=A*aS1.x+B*aS1.y+Cc*(1.0-aS1.x-aS1.y);
  vec3 n=cross(B-A,Cc-A);float nl=length(n);
  n=nl>1e-12?n/nl:uBU;
  vec3 o=uBO.xyz;float s=uBO.w;
  bool wing=part>=6&&part<=9;
  if(wing||part==5){if(dot(n,uBU)<0.0)n=-n;}
  else{vec3 ax=o+uBF*dot(p-o,uBF);if(dot(n,p-ax)<0.0)n=-n;}
  vec3 fl=-uBF;
  if(part==4)fl=uBF;
  else if(wing){
    float sd=dot(p-o,uBX)>0.0?1.0:-1.0;
    vec3 d=p-(o+(uBF*0.06+uBU*0.054+uBX*(0.034*sd))*s);float dl=length(d);
    fl=(dl>1e-6?d/dl:uBX*sd)*0.8-uBF*0.6;
  }
  vec3 tt=fl-n*dot(fl,n);float tl=length(tt);
  tt=tl>1e-4?tt/tl:normalize(cross(n,uBX)+vec3(1e-4,0.0,0.0));
  tt=normalize(tt+cross(n,tt)*(r.x-0.5)*(part==4?0.04:0.3));
  float a=part==6?0.9:part==7?0.58:part==8?0.42:part==9?0.28:1.0;
  if(part>6&&part<=9)a*=uBGh;
  float sz=uBT.w*(part==4?0.8:part==10?0.62:part==11?0.42:wing?1.25:part==5?1.35:1.0);
  p+=n*s*(0.003+0.007*r.z);
  return mk(p,tt,n,a,sz,0.0);
}

F form(int k,vec4 q,vec4 r,vec4 P,float t){
  if(k==0)return fWing(q,r,P,t);
  if(k==1)return fApps(q,r,P,t);
  if(k==2)return fPlay(q,r,P,t);
  if(k==3)return fOrb(q,r,P,t);
  if(k==4)return fTower(q,r,P,t);
  if(k==5)return fNest(q,r,P,t);
  if(k==6)return fFour(q,r,P,t);
  if(k==7)return fSettle(q,r,P,t);
  if(k==8)return fSweep(q,r,P,t);
  if(k==9)return fTinker(q,r,P,t);
  if(k==10)return fCollapse(q,r,P,t);
  return fMacro(q,r,P,t);
}

void main(){
  uint id=uint(gl_VertexID);
  float fi=float(gl_VertexID);
  vec4 r=vec4(hf(id*4u+1u),hf(id*4u+2u),hf(id*4u+3u),hf(id*4u+4u));
  // q.x: a golden-ratio sequence, so any prefix of the buffer (tiers draw prefixes) covers every curve evenly;
  // q.y, q.z: plain hashes across it (a 2D/3D lattice shows as rows once a shape stretches it 20:1)
  vec4 q=vec4(fract(0.5+fi*0.6180339887),hf(id*9u+7u),hf(id*9u+8u),r.x);
  float t=uT;
  gI=(fi+0.5)/uN;

  /* ---- target: the joining formation, blended from the leaving one on this feather's own clock ---- */
  F fo=form(uKB,q,r,uPB,t);
  float m=1.0;
  if(uMixT<uStag+uDur){
    float key=clamp(fo.p.x*0.28+0.5,0.0,1.0);
    m=clamp((uMixT-uStag*(0.6*key+0.4*r.y))/uDur,0.0,1.0);
    m=m*m*(3.0-2.0*m);
    if(m<1.0){
      F fa=form(uKA,q,r,uPA,t);
      fo.p=mix(fa.p,fo.p,m);fo.t=mix(fa.t,fo.t,m);fo.n=mix(fa.n,fo.n,m);
      fo.a=mix(fa.a,fo.a,m);fo.s=mix(fa.s,fo.s,m);fo.g=mix(fa.g,fo.g,m);
    }
  }
  float fl=(m>0.0&&m<1.0)?sin(PI*m):0.0;            // in flight between formations
  if(r.w>0.982){                                     // a few loose feathers always drift around the scene
    float th=r.x*TAU+t*0.03*(r.y-0.5)*2.0,ph=acos(1.0-2.0*r.y),R=1.9+1.1*r.z;
    vec3 d=vec3(sin(ph)*cos(th),cos(ph)*0.7,sin(ph)*sin(th));
    vec3 dp=d*R+flow(d*2.0,t*0.3)*0.12;
    fo.p=mix(fo.p,dp,smoothstep(0.3,1.0,uBloom));
    fo.t=normalize(flow(dp,t)+vec3(1e-3));fo.n=d;fo.a=0.75;fo.s=0.8;fo.g=0.0;
  }

  /* ---- the bird: is this feather wanted on it, and how far along is it ----
     Wanted when the bird is and its turn (sel) is inside the share. It answers on its own clock: the assembly runs
     beak to tail, the dissolve tail to beak, each with a little randomness. Its progress is kept, so a change of mind
     halfway through simply turns it around. */
  int part=int(aS0.w+0.5);
  float key=aS1.w;
  float goal=aB.y,wg=(uBM.x>0.5&&aS1.z<uBM.y)?1.0:0.0;
  if(abs(wg-goal)>0.5){
    float dl=wg>0.5?uBT.x*(0.82*key+0.18*r.y):uBT.y*(0.82*(1.0-key)+0.18*r.y);
    if(uBM.z>=dl)goal=wg;
  }
  float mb=aB.x,stp=uDt/max(uBT.z*(goal>mb?1.0:1.6),0.05);   // a quick flight in, a softer one out
  mb=clamp(mb+clamp(goal-mb,-stp,stp),0.0,1.0);
  if(uBM.w>0.5||uSnap>0.5){goal=wg;mb=wg;}
  float me=mb*mb*mb*(mb*(mb*6.0-15.0)+10.0);
  float flb=0.0;
  if(mb>0.0){
    F fb=birdF(part,r);
    fo.p=mix(fo.p,fb.p,me);fo.t=mix(fo.t,fb.t,me);fo.n=mix(fo.n,fb.n,me);
    fo.a=mix(fo.a,fb.a,me);fo.s=mix(fo.s,fb.s,me);fo.g=mix(fo.g,fb.g,me);
    flb=mb<1.0?sin(PI*me):0.0;
    fo.g=max(fo.g,0.9*flb);   // a feather in flight to or from the bird glows, and docks still glowing: a ripple of light
  }
  vec3 Tg=fo.p;
  Tg+=flow(Tg*1.3+vec3(0.0,t*0.07,0.0),t)*uFlut*0.02*(1.0-me);
  Tg+=(flow(Tg*0.7+vec3(r.z*3.0),t)*fl*0.32+vec3(0.0,0.28,0.18)*fl)*(1.0-me);   // arc and stir while flying
  // gathering into the bird (or leaving it): a loose spiral around its body axis, stirred
  if(flb>0.0){vec3 d=Tg-uBO.xyz;Tg+=(cross(uBF,d)*0.55+flow(Tg*0.9+vec3(r.x*5.0),t)*0.2*uBO.w)*flb;}

  /* ---- follow on a spring, feeding forward the target's own motion ---- */
  vec3 p=aP.xyz,v=aV.xyz;
  vec3 Tv=(uSnap>0.5||aT.w<=0.0)?vec3(0.0):(Tg-aT.xyz)/max(uDt,1e-3);
  float tvl=length(Tv);if(tvl>3.0)Tv*=3.0/tvl;
  float K=uK*(0.75+0.5*r.z)*mix(1.0,0.38,fl*(1.0-me))*(1.0+2.2*me*me);
  float Cd=2.0*sqrt(K)*0.86;
  v+=((Tg-p)*K-(v-Tv)*Cd)*uDt;

  /* ---- ruffle: lift, drift with the motion, swirl a little, spin, then settle ---- */
  float rf=aP.w*exp(-uDt*(0.85+2.2*me));   // feathers on the bird settle back faster
  float spin=aV.w*exp(-uDt*1.5);
  // distance on screen to the pointer's path since the last frame: a continuous wake at any frame rate, and a
  // finger-sized radius whatever the depth
  float fall=0.0;
  vec4 cp=uVP*vec4(p,1.0);
  if(uPS>0.001&&cp.w>0.05){
    vec2 sp=cp.xy/cp.w;sp.x*=uAsp;
    vec2 ab=uSeg.zw-uSeg.xy;float l2=dot(ab,ab);
    float h=l2>1e-8?clamp(dot(sp-uSeg.xy,ab)/l2,0.0,1.0):0.0;
    vec2 dv=sp-uSeg.xy-ab*h;
    fall=exp(-dot(dv,dv)/(uPR*uPR));
  }
  if(fall>0.004){
    vec3 w=p-uRO;vec3 rr=w-uRD*dot(w,uRD);
    float d=length(rr)+0.02,k=min(1.0,uDt*8.0)*fall;
    v+=uPV*k*0.8;
    v+=cross(uRD,rr)/d*length(uPV)*0.3*k;
    vec3 nf=aN.xyz*(dot(aN.xyz,uRD)>0.0?-1.0:1.0);
    v+=nf*fall*uPS*uDt*7.0;
    v+=rr/d*uPulse*fall;
    rf=max(rf,fall*uPS);
    spin+=uDt*fall*uPS*(4.0+5.0*r.x)*(r.y<0.5?-1.0:1.0);
  }

  /* ---- orientation: lie along the formation; while flying or pushed, turn into the motion ---- */
  vec3 ft=normalize(fo.t+vec3(1e-5));
  float fly=smoothstep(0.35,1.6,length(v-Tv));
  float vl=length(v);
  if(fly>0.0&&vl>1e-3)ft=normalize(mix(ft,v/vl,fly*0.7)+vec3(1e-5));
  vec3 f=mix(aF.xyz,ft,1.0-exp(-uDt*7.0))+aN.xyz*1e-3;
  f=length(f)>1e-4?normalize(f):ft;
  vec3 n=mix(aN.xyz,fo.n,1.0-exp(-uDt*5.0));
  float vis=mix(aF.w,fo.a,1.0-exp(-uDt*4.0));
  float sz=mix(aT.w>0.0?aT.w:fo.s,fo.s,1.0-exp(-uDt*3.0));
  float gw=mix(aN.w,fo.g,1.0-exp(-uDt*(fo.g>aN.w?12.0:3.0)));
  // arrived on the bird: locked to its spot (it beats with the wing); a ruffle loosens the lock for a moment
  float lock=smoothstep(0.78,1.0,mb)*(1.0-0.85*clamp(rf*1.6,0.0,1.0));
  if(lock>0.0){f=normalize(mix(f,ft,lock)+vec3(1e-5));n=mix(n,fo.n,lock);vis=mix(vis,fo.a,lock);sz=mix(sz,fo.s,lock);}
  if(fo.a<0.02&&vis<0.05){p=Tg;v=Tv;}                // invisible feathers step straight to their next place
  if(uSnap>0.5){p=Tg;v=vec3(0.0);f=ft;n=fo.n;vis=fo.a;sz=fo.s;gw=fo.g;rf=0.0;spin=0.0;}
  n-=f*dot(n,f);
  n=length(n)>1e-3?normalize(n):normalize(cross(f,vec3(0.31,0.83,0.46)));
  float sp=length(v);if(sp>6.0)v*=6.0/sp;
  p+=v*uDt;
  if(lock>0.0){p=mix(p,Tg,lock);v=mix(v,Tv,lock);}
  // the game's orb and its trail move fast: their feathers hold on to their places (never a smear)
  if(uKB==2&&m>=1.0&&r.w<0.19&&r.w<=0.982){float lt=(1.0-me)*(1.0-exp(-uDt*40.0));p=mix(p,Tg,lt);v=mix(v,Tv,lt);}
  if(!(dot(p,p)<1e4)||!(dot(v,v)<1e4)){p=Tg;v=vec3(0.0);}   // never let a bad step escape
  if(!(dot(f,f)<2.0)){f=ft;}
  oP=vec4(p,rf);oV=vec4(v,spin);oF=vec4(f,vis);oN=vec4(n,gw);oT=vec4(Tg,max(sz,0.05));oB=vec4(mb,goal,me,lock);
}`;
const UPDATE_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main(){o=vec4(0.0);}`;

/* DRAW: one instanced quad per feather (4 vertices: x across, y from quill to tip); outline, shaft, bow and the curl
   of the vanes are all drawn in the fragment shader, which keeps the vertex work small. Material = Gorget: dark warm bronze and graphite at rest, flashing gold, copper, rose and pink
   where the half-vector meets the vane; ruffled feathers turn their faces to the light. */
const DRAW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aC;
layout(location=1) in vec4 aP;
layout(location=2) in vec4 aV;
layout(location=3) in vec4 aF;
layout(location=4) in vec4 aN;
layout(location=5) in vec4 aT;
layout(location=6) in vec4 aB;
layout(location=7) in vec4 aS0;
uniform mat4 uVP;
uniform vec3 uCam;
uniform float uPxK;
uniform float uLen;
uniform float uMinW;
uniform float uMinL;
uniform float uFocus;
uniform float uT;
out vec2 vUV;
out vec3 vN;
out vec3 vS;
out vec3 vF;
out vec3 vW;
out float vA;
out float vHeat;
out float vSeed;
out float vGlint;
out float vDim;
out float vFog;
out float vBow;
out float vBird;
flat out float vPart;
uint hu(uint x){x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;x^=x>>16u;return x;}
float hf(uint x){return float(hu(x)>>8u)*(1.0/16777216.0);}
void main(){
  uint id=uint(gl_InstanceID);
  float bd=aB.z,lk=aB.w,pt=aS0.w;
  vBird=bd;vPart=pt;
  float h1=hf(id*7u+3u),h2=hf(id*7u+5u),h3=hf(id*7u+6u);
  vec3 p=aP.xyz,f=aF.xyz,n=aN.xyz;
  float rf=aP.w,spin=aV.w,vis=aF.w,sz=aT.w;
  vUV=aC;vN=n;vS=n;vF=f;vW=p;vA=0.0;vHeat=0.0;vSeed=h1;vGlint=0.0;vDim=1.0;vFog=0.0;vBow=0.0;
  if(vis<0.01){gl_Position=vec4(2.0,2.0,2.0,1.0);return;}
  vec3 s=normalize(cross(n,f));
  float sp=length(aV.xyz);
  // ruffle: the feather lifts off its surface, tilts and rolls; at rest it keeps a calm idle flutter
  float lift=rf*0.95+min(sp*0.06,0.22)*(1.0-lk);
  vec3 f2=f*cos(lift)+n*sin(lift);
  vec3 n2=n*cos(lift)-f*sin(lift);
  float roll=spin+0.2*sin(uT*(1.2+h2)+h1*6.2832)*(0.25+rf)*(1.0-0.8*lk);
  vec3 s2=s*cos(roll)+n2*sin(roll);
  vec3 n3=n2*cos(roll)-s*sin(roll);
  vec3 V=normalize(uCam-p);
  vec3 sg=s2-V*dot(s2,V)*0.55;           // never quite edge-on: bias the width toward the screen plane
  float len=uLen*sz*(0.78+0.44*h1)*(1.0+0.3*rf);
  float wid=len*(0.36+0.08*h2)*(pt>3.5&&pt<4.5?mix(1.0,0.55,bd):1.0);   // the needle's feathers are slender
  vec4 cc=uVP*vec4(p,1.0);
  float wc=max(cc.w,0.05);
  float ppu=uPxK/wc;                      // device pixels per world unit at this depth
  float dim=1.0;
  float lpx=len*ppu;
  // a feather knocked right up to the lens never becomes a screen-sized quad (overdraw on a phone GPU)
  float mxl=uMinL*30.0;
  if(lpx>mxl){float k=mxl/lpx;len*=k;wid*=k;lpx=mxl;}
  if(lpx<uMinL){float k=uMinL/lpx;len*=k;dim/=k;}
  float wpx=wid*ppu*max(length(sg),0.3);
  if(wpx<uMinW){float k=uMinW/max(wpx,1e-3);wid*=k;dim*=mix(1.0,1.0/k,0.6);}
  // a slight sideways sweep of the shaft, drawn in the fragment shader: widen the quad to hold it
  float bow=(h3-0.5)*0.9*(1.0-0.7*bd);
  float y=aC.y,x=aC.x*(1.0+abs(bow));
  vec3 P=p+f2*((y-0.45)*len)+sg*(x*wid*0.5);
  gl_Position=uVP*vec4(P,1.0);
  vUV=vec2(x,y);vBow=bow;vN=n3;vS=s2;vF=f2;vW=P;
  float dz=wc-uFocus;
  vFog=smoothstep(0.25,2.4,dz)*0.78+smoothstep(-0.8,-2.8,dz)*0.45;   // soft depth: far feathers sink into the night
  vA=vis;vDim=dim;vHeat=rf;vGlint=aN.w+min(sp*0.035,0.1)*(1.0-lk);
}`;
const DRAW_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vN;
in vec3 vS;
in vec3 vF;
in vec3 vW;
in float vA;
in float vHeat;
in float vSeed;
in float vGlint;
in float vDim;
in float vFog;
in float vBow;
in float vBird;
flat in float vPart;
uniform vec3 uCam;
uniform vec3 uL;
uniform vec3 uBg;
uniform float uExpo;
uniform float uWarm;
uniform float uIntro;
uniform float uAT;
uniform float uDimF;
uniform vec3 uRest[4];   // the tokens: feathers at rest - shade, lit, sheen, and the alt tone
uniform vec3 uRamp[4];   // the structural-colour flash, low to high
uniform vec3 uBird[9];   // the bird: back, gorget, belly, wing, beak, tail, rim, eye, catchlight
uniform vec3 uThm;       // glow (1 on dark: the flash is light; 0 on light: the flash is pigment), alt share, quill lift
out vec4 o;
const float PI=3.14159265359;
vec3 ramp(float k){
  vec3 c=mix(uRest[1],uRamp[0],smoothstep(0.1,0.3,k));
  c=mix(c,uRamp[1],smoothstep(0.3,0.46,k));
  c=mix(c,uRamp[2],smoothstep(0.46,0.66,k));
  return mix(c,uRamp[3],smoothstep(0.7,0.95,k));
}
// how bright a flash of strength g is drawn: on the night it glows past its colour; on paper it is a deep, saturated ink
float flashK(float g){return mix(0.9+0.12*min(g,1.0),0.75+0.55*min(g,1.2),uThm.x);}
void main(){
  float v=vUV.y,u=vUV.x-vBow*v*v,au=abs(u);   // the shaft bows a little sideways toward the tip
  // outline: bare quill at the base, widest past the middle, a rounded tip; the inner vane a touch narrower
  float hw=pow(sin(PI*pow(clamp(v,0.0,1.0),0.72)),0.7)*(u<0.0?0.82:1.0)*smoothstep(0.06,0.2,v);
  float fw=fwidth(u)*1.1;
  float body=1.0-smoothstep(hw-fw,hw+fw,au);
  float shaft=(1.0-smoothstep(0.0,fw*1.2+0.04,au))*step(v,0.93);
  float cov=max(body,shaft*0.9)*vA;
  if(cov<uAT)discard;
  vec3 V=normalize(uCam-vW);
  vec3 nn=normalize(vN+(vS*(u*0.5)+vF*(0.32*v-0.1))*(1.0-0.65*vBird));   // vanes curve away from the shaft, the tip curls
  if(dot(nn,V)<0.0)nn=-nn;
  vec3 H=normalize(uL+V);
  nn=normalize(mix(nn,H,0.6*vHeat));      // a ruffled feather turns its face to the light, as a throat does
  float ndh=max(dot(nn,H),0.0),ndv=max(dot(nn,V),0.0),ndl=dot(nn,uL);
  // at rest: the tokens' shade to its lit tone, with a broad sheen (a share of feathers wear the alt tone)
  bool alt=vSeed>1.0-uThm.y;
  vec3 r0=alt?mix(uRest[0],uRest[3],0.55):uRest[0],r1=alt?uRest[3]:uRest[1];
  float dif=0.5+0.5*ndl;
  vec3 c=mix(r0,r1*(1.0+uWarm*0.06),dif*dif);
  c+=uRest[2]*pow(ndh,5.0)*0.16;
  // the flash: a narrow lobe; its strength picks the hue on the throat ramp
  float g=pow(ndh,22.0)*(0.75+0.5*vSeed)+vHeat*0.6+vGlint+uIntro;
  float hue=clamp(0.27+0.55*g+0.12*(1.0-ndv)+(vSeed-0.5)*0.16-uWarm*0.14,0.0,1.0);
  c=mix(c,ramp(hue)*flashK(g),smoothstep(0.03,0.55,g));
  /* on the bird, each feather takes the colour of its part, lit by its facet (so the facets read as facets): the back
     and crown, the gorget near black until it meets the light and flashes, a pale breast, a dark needle, smoky wings, an
     eye with a catchlight, and a rim that keeps the silhouette (pale on the night, ink on paper) */
  if(vBird>0.004){
    int pt=int(vPart+0.5);
    vec3 fn=normalize(vN);if(dot(fn,V)<0.0)fn=-fn;
    vec3 bn=normalize(mix(fn,nn,0.3));
    float bdh=max(dot(bn,H),0.0),bdv=max(dot(bn,V),0.0),bdl=dot(bn,uL);
    float lit=0.34+0.66*max(bdl,0.0)+0.24*(0.5+0.5*bn.y)+0.16*bdv;
    vec3 b;
    if(pt==3)b=uBird[2]*lit;
    else if(pt==4)b=uBird[4]*lit+uBird[8]*0.62*pow(bdh,10.0);
    else if(pt>=6&&pt<=9)b=uBird[3]*lit+uRest[2]*0.35*pow(bdh,5.0);
    else if(pt==10)b=uBird[7];
    else if(pt==11)b=uBird[8];
    else if(pt==2)b=uBird[1]*lit;
    else if(pt==5)b=uBird[5]*lit+uRest[2]*0.35*pow(bdh,6.0);
    else{b=uBird[0]*lit;b+=uRest[2]*0.45*pow(bdh,6.0);}
    if(pt==2||pt==1){
      float gg=pow(bdh,2.5)*1.5+0.32*(1.0-bdv)*(1.0-bdv);
      vec3 rc=ramp(clamp(0.46+0.4*gg+0.1*(1.0-bdv)+(vSeed-0.5)*0.1,0.0,1.0))*mix(0.95+0.1*min(gg,1.0),0.8+0.6*min(gg,1.2),uThm.x);
      b=mix(b,rc,smoothstep(0.04,0.5,gg)*(pt==2?1.0:0.5));
    }
    if(pt<10)b=mix(b,uBird[6],pow(1.0-bdv,2.2)*(pt>=6&&pt<=9?0.2:0.34+0.1*uThm.x));
    b=mix(b,ramp(clamp(0.5+0.35*vHeat,0.0,1.0))*flashK(0.4+0.5*vHeat),smoothstep(0.08,0.7,vHeat)*0.7);   // a ruffle flashes it
    b=mix(b,ramp(clamp(0.6+0.3*vGlint+(vSeed-0.5)*0.12,0.0,1.0))*flashK(0.5+0.45*vGlint),smoothstep(0.06,0.7,vGlint)*0.8);   // the docking glow
    c=mix(c,b*(1.0+(vSeed-0.5)*0.32),vBird);
  }
  c=mix(uBg,c,mix(uDimF,1.0,vBird));   // while the bird is here, the formation steps back toward the page
  // the feather itself: a lighter quill, vanes darkening toward their edge (more on the bird: its feathers read as
  // overlapping scales), faint barbs
  float edge=clamp(au/max(hw,0.05),0.0,1.0);
  float ed=mix(0.78,0.5,vBird);
  c*=ed+(1.0-ed)*(1.0-edge*edge);
  c*=0.9+0.1*(0.5+0.5*cos(6.2832*(v*14.0-au*3.5)));
  c+=vec3(0.07,0.06,0.045)*uThm.z*shaft*(0.6+g);
  c=mix(uBg,c*uExpo,vDim);
  // depth haze: far feathers sink into the night; on paper a heavy haze reads as washed out, so it is much lighter
  c=mix(c,uBg,vFog*mix(0.4,0.82,uThm.x));
  o=vec4(c,cov);
}`;
/* full-screen passes: a faint lift of the ground behind the form (before), then vignette and grain (after) */
const POST_VS = `#version 300 es
out vec2 vUv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUv=p;gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`;
const POST_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;
uniform vec2 uC;
uniform float uT;
uniform vec3 uBg;
uniform vec3 uLift;
uniform float uMode;
uniform float uWarm;
float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 a=vec2(uRes.x/uRes.y,1.0);
  float d=length((vUv-uC)*a);
  if(uMode<0.5){
    float g=exp(-d*d*2.6);
    o=vec4(mix(uBg,uLift,g*(0.5+0.2*uWarm)),1.0);
  }else{
    float v=smoothstep(0.35,1.3,d)*0.62;
    float gr=(h(mod(gl_FragCoord.xy,512.0)+uT*91.7)-0.5)*0.04;
    o=vec4(uBg,clamp(v+gr,0.0,1.0));
  }
}`;

let mode = 'init', gl = null, G = null;
let cap = 0, active = 0, minActive = 0, dpr = 1, W = 1, H = 1, simT = 0, frameNo = 0;
let dprLock = false;   // set once the downgrade (or a software renderer) has chosen the pixel ratio
let raf = 0, lastNow = 0, ema = 16.7, slowRun = 0, winMs = 0, winN = 0, winBusy = 0, canvasVisible = true, lockTier = false;
let bloom = 0, expoC = 1, warmC = 0, flutC = 0.5, lightAz = 0, lightEl = 0.62, lightPh = 0, lenBase = 0.045;
const dprCap = isPhone ? 1.25 : 1.75;
const LV = new Float32Array(3);
const BG = SV.bg;   // the page colour, live (it eases with a change of theme)

// Shaders compile without asking for status straight away; with KHR_parallel_shader_compile the driver works off the
// main thread while the loader draws, and status is read once it says it is done.
function program(vs, fs, varyings) {
  const p = gl.createProgram(), v = gl.createShader(gl.VERTEX_SHADER), f = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(v, vs); gl.compileShader(v); gl.shaderSource(f, fs); gl.compileShader(f);
  gl.attachShader(p, v); gl.attachShader(p, f);
  if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(p);
  return { p, v, f };
}
function linked(o) {
  let log = '';
  [o.v, o.f].forEach(sh => { if (!log && !gl.getShaderParameter(sh, gl.COMPILE_STATUS)) log = 'shader: ' + (gl.getShaderInfoLog(sh) || ''); });
  if (!log && !gl.getProgramParameter(o.p, gl.LINK_STATUS)) log = 'link: ' + (gl.getProgramInfoLog(o.p) || '');
  gl.deleteShader(o.v); gl.deleteShader(o.f);
  if (log) { gl.deleteProgram(o.p); o.p = null; throw new Error(log); }
  const p = o.p; o.p = null; return p;
}
function locs(p, names) { const o = {}; names.forEach(n => { o[n] = gl.getUniformLocation(p, n); }); return o; }

function initGL(cb) {
  const fin = e => { DBG.tGL1 = Math.round(performance.now() - t0); try { cb(e); } catch (x) { logErr('init: ' + (x && x.message)); } };
  DBG.tGL0 = Math.round(performance.now() - t0);
  try {
    gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 unavailable');
    if (gl.isContextLost && gl.isContextLost()) throw new Error('context lost');
    // An opaque context shows black until its first frame: paint it night now, in case the shaders take a while
    // (the loader lifts at 2.5 s whatever happens).
    gl.clearColor(BG[0], BG[1], BG[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const g = G = {};
    const par = gl.getExtension('KHR_parallel_shader_compile');
    g.pending = [program(UPDATE_VS, UPDATE_FS, ['oP', 'oV', 'oF', 'oN', 'oT', 'oB']), program(DRAW_VS, DRAW_FS), program(POST_VS, POST_FS)];
    const t1 = performance.now();
    const poll = () => {
      if (G !== g) return;
      let done = true;
      if (par) { try { done = g.pending.every(o => gl.getProgramParameter(o.p, par.COMPLETION_STATUS_KHR)) || performance.now() - t1 > 10000; } catch (e) { done = true; } }
      if (!done) { setTimeout(poll, 30); return; }
      try { finishGL(g); } catch (e) { fin(e); return; }
      fin(null);
    };
    if (par) setTimeout(poll, 0); else poll();
  } catch (e) { fin(e); }
}
function finishGL(g) {
  g.pU = linked(g.pending[0]); g.pD = linked(g.pending[1]); g.pO = linked(g.pending[2]); g.pending = null;
  g.uU = locs(g.pU, ['uT', 'uDt', 'uKA', 'uKB', 'uPA', 'uPB', 'uMixT', 'uStag', 'uDur', 'uN', 'uFlut', 'uRO', 'uRD', 'uPV', 'uVP', 'uSeg', 'uAsp', 'uPR', 'uPS', 'uPulse', 'uBloom', 'uSnap', 'uK', 'uPath', 'uBV', 'uBO', 'uBF', 'uBU', 'uBX', 'uBM', 'uBT', 'uBGh', 'uOrb', 'uOrbF', 'uTr', 'uRip']);
  g.uD = locs(g.pD, ['uVP', 'uCam', 'uPxK', 'uLen', 'uMinW', 'uMinL', 'uFocus', 'uT', 'uL', 'uBg', 'uExpo', 'uWarm', 'uIntro', 'uAT', 'uDimF', 'uRest', 'uRamp', 'uBird', 'uThm']);
  g.uO = locs(g.pO, ['uRes', 'uC', 'uT', 'uBg', 'uLift', 'uMode', 'uWarm']);
  let rend = '';
  try { rend = String(gl.getParameter(gl.RENDERER) || ''); if (/^webkit webgl$/i.test(rend) || !rend) { const ext = gl.getExtension('WEBGL_debug_renderer_info'); if (ext) rend = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''); } } catch (e) {}
  const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(rend);
  const cores = navigator.hardwareConcurrency || 4;
  // Feather counts by tier: desktop high ~20k, mid ~10k, phone ~4k (software renderers start at the mid count;
  // tablets and other touch-first screens start at mid, and the frame-time downgrade takes it from there).
  let tier = FORCE || (isPhone ? 'phone' : software ? 'software' : coarse ? 'mid' : cores >= 8 ? 'high' : 'mid');
  const TIERS = { high: [24576, 20480, 8192], mid: [12288, 10240, 4096], phone: [5120, 4096, 2048], software: [12288, 8192, 3072] };
  [cap, active, minActive] = TIERS[tier];
  lockTier = !!FORCE;
  DBG.tier = tier;
  // the same look at every count: fewer feathers are drawn a little larger
  lenBase = 0.045 * Math.pow(20480 / active, 0.25);
  const stride = 24;   // floats per feather
  const data = new Float32Array(cap * stride);
  let s = 1234567;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < cap; i++) {
    const o = i * stride, u = rnd() * TAU, z = rnd() * 2 - 1, rr = 1.4 * Math.cbrt(rnd()), q = Math.sqrt(1 - z * z);
    data[o] = q * Math.cos(u) * rr; data[o + 1] = q * Math.sin(u) * rr; data[o + 2] = z * rr;
    data[o + 8] = 1; data[o + 13] = 1;   // a valid shaft and normal before the first step
  }
  G.buf = [gl.createBuffer(), gl.createBuffer()];
  for (let i = 0; i < 2; i++) { gl.bindBuffer(gl.ARRAY_BUFFER, G.buf[i]); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY); }
  // each feather's fixed place on the bird (computed once; never changes)
  G.bird = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, G.bird); gl.bufferData(gl.ARRAY_BUFFER, birdAttrs(cap), gl.STATIC_DRAW);
  // the feather quad, shared by every instance
  const strip = new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]);
  G.strip = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, G.strip); gl.bufferData(gl.ARRAY_BUFFER, strip, gl.STATIC_DRAW);
  G.vaoU = []; G.vaoD = [];
  for (let i = 0; i < 2; i++) {
    const vu = gl.createVertexArray(); gl.bindVertexArray(vu);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.buf[i]);
    for (let a = 0; a < 6; a++) { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 4, gl.FLOAT, false, stride * 4, a * 16); }
    gl.bindBuffer(gl.ARRAY_BUFFER, G.bird);
    for (let a = 0; a < 2; a++) { gl.enableVertexAttribArray(6 + a); gl.vertexAttribPointer(6 + a, 4, gl.FLOAT, false, 32, a * 16); }
    G.vaoU.push(vu);
    const vd = gl.createVertexArray(); gl.bindVertexArray(vd);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.strip); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.buf[i]);
    for (let a = 0; a < 6; a++) { gl.enableVertexAttribArray(a + 1); gl.vertexAttribPointer(a + 1, 4, gl.FLOAT, false, stride * 4, a * 16); gl.vertexAttribDivisor(a + 1, 1); }
    gl.bindBuffer(gl.ARRAY_BUFFER, G.bird);
    gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(7, 1);
    G.vaoD.push(vd);
  }
  G.path = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, G.path);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, PATH_N, PATH_ROWS, 0, gl.RGBA, gl.FLOAT, PATHS);
  gl.bindTexture(gl.TEXTURE_2D, null);
  G.vaoO = gl.createVertexArray();
  gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
  G.src = 0;
  G.fq = [null, null]; G.fqAt = [0, 0]; G.fi = 0;   // GPU fences for the last two frames (see gpuBusy)
  // multisampled edges: alpha-to-coverage gives soft, order-independent feather edges with correct occlusion
  G.msaa = (gl.getParameter(gl.SAMPLES) || 0) > 0;
  dpr = software && !FORCE ? 1 : Math.min(window.devicePixelRatio || 1, dprCap); dprLock = software && !FORCE;
  resizeGL(true);
  const err = gl.getError();
  if (err !== gl.NO_ERROR && err !== gl.CONTEXT_LOST_WEBGL) throw new Error('GL error ' + err);
  mode = 'gl'; DBG.mode = 'gl'; DBG.active = active; DBG.msaa = G.msaa;
  glCanvas.hidden = false; posterCanvas.hidden = true;
}
function teardownGL() {
  if (gl && G && !(gl.isContextLost && gl.isContextLost())) {
    try {
      (G.buf || []).forEach(b => gl.deleteBuffer(b)); if (G.strip) gl.deleteBuffer(G.strip); if (G.bird) gl.deleteBuffer(G.bird);
      (G.vaoU || []).concat(G.vaoD || []).forEach(v => gl.deleteVertexArray(v)); if (G.vaoO) gl.deleteVertexArray(G.vaoO);
      ['pU', 'pD', 'pO'].forEach(k => { if (G[k]) gl.deleteProgram(G[k]); }); if (G.path) gl.deleteTexture(G.path);
      (G.pending || []).forEach(o => { if (o.p) gl.deleteProgram(o.p); gl.deleteShader(o.v); gl.deleteShader(o.f); });
      (G.fq || []).forEach(f => { if (f) gl.deleteSync(f); });
    } catch (e) {}
  }
  G = null;
}
function resizeGL(force) {
  cssW = window.innerWidth; cssH = glCanvas.clientHeight || window.innerHeight;
  const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
  if (force || w !== W || h !== H) { W = w; H = h; glCanvas.width = W; glCanvas.height = H; }
}
function stepSim(dt, snap) {
  const A = FORMATIONS[curA], B = FORMATIONS[curB], u = G.uU;
  gl.useProgram(G.pU);
  gl.uniform1f(u.uT, simT); gl.uniform1f(u.uDt, dt);
  gl.uniform1i(u.uKA, A.kind); gl.uniform1i(u.uKB, B.kind);
  gl.uniform4fv(u.uPA, A.pf); gl.uniform4fv(u.uPB, B.pf);
  gl.uniform1f(u.uMixT, blending ? mixT : 99); gl.uniform1f(u.uStag, STAG); gl.uniform1f(u.uDur, DUR);
  gl.uniform1f(u.uN, active); gl.uniform1f(u.uFlut, flutC);
  gl.uniform3f(u.uRO, ray.ox, ray.oy, ray.oz); gl.uniform3f(u.uRD, ray.dx, ray.dy, ray.dz);
  gl.uniform3f(u.uPV, pv[0], pv[1], pv[2]);
  gl.uniformMatrix4fv(u.uVP, false, VPm);
  gl.uniform4f(u.uSeg, seg[0], seg[1], seg[2], seg[3]); gl.uniform1f(u.uAsp, cssW / cssH);
  gl.uniform1f(u.uPR, ptr.touching || performance.now() < ptr.touchUntil ? 0.13 : 0.095);   // in screen heights (NDC y)
  gl.uniform1f(u.uPS, reduce ? 0 : ruffleS);
  gl.uniform1f(u.uPulse, pulse * 0.5);
  gl.uniform1f(u.uBloom, bloom); gl.uniform1f(u.uSnap, snap ? 1 : 0); gl.uniform1f(u.uK, 34);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, G.path); gl.uniform1i(u.uPath, 0);
  gl.uniform3fv(u.uBV, BVW);
  gl.uniform4f(u.uBO, bird.x, bird.y, bird.z, bird.s);
  gl.uniform3f(u.uBF, BAX[0], BAX[1], BAX[2]); gl.uniform3f(u.uBU, BAX[3], BAX[4], BAX[5]); gl.uniform3f(u.uBX, BAX[6], BAX[7], BAX[8]);
  gl.uniform4f(u.uBM, bWant, bShare, bClk, bSnap ? 1 : 0);
  gl.uniform4f(u.uBT, bStagA, bStagD, bDur, bLen);
  gl.uniform1f(u.uBGh, bGhost);
  gl.uniform4f(u.uOrb, orb.x, orb.y, orb.z, orb.R); gl.uniform1f(u.uOrbF, orb.flash); gl.uniform3fv(u.uTr, TRV); gl.uniform4fv(u.uRip, orb.rip);
  const dst = 1 - G.src;
  gl.bindVertexArray(G.vaoU[G.src]);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, G.buf[dst]);
  gl.enable(gl.RASTERIZER_DISCARD);
  gl.beginTransformFeedback(gl.POINTS);
  gl.drawArrays(gl.POINTS, 0, active);
  gl.endTransformFeedback();
  gl.disable(gl.RASTERIZER_DISCARD);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
  gl.bindVertexArray(null);
  G.src = dst; frameNo++;
}
// the key light lives in camera space (upper left, in front) and wanders slowly, so glints travel across the form
function updateLight(dt) {
  lightPh += dt * FORMATIONS[curB].light[1];
  const az = lightAz + Math.sin(lightPh * TAU * 0.5) * 0.45 - 1.0, el = lightEl;   // off to the left: only feathers tilted toward it flash
  const lx = Math.sin(az) * Math.cos(el), ly = Math.sin(el), lz = Math.cos(az) * Math.cos(el);
  let x = cam.rx * lx + cam.ux * ly - cam.fx * lz, y = cam.ry * lx + cam.uy * ly - cam.fy * lz, z = cam.rz * lx + cam.uz * ly - cam.fz * lz;
  const l = Math.hypot(x, y, z) || 1; LV[0] = x / l; LV[1] = y / l; LV[2] = z / l;
}
function renderGL(intro) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.clearColor(BG[0], BG[1], BG[2], 1); gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  project(C.tx, C.ty, C.tz, P3);
  const cx = P3[0] / cssW, cy = 1 - P3[1] / cssH;
  // background lift
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  gl.useProgram(G.pO);
  gl.uniform2f(G.uO.uRes, W, H); gl.uniform2f(G.uO.uC, cx, cy); gl.uniform1f(G.uO.uT, 0);
  gl.uniform3f(G.uO.uBg, BG[0], BG[1], BG[2]); gl.uniform3fv(G.uO.uLift, SV.lift); gl.uniform1f(G.uO.uMode, 0); gl.uniform1f(G.uO.uWarm, warmC);
  gl.bindVertexArray(G.vaoO); gl.drawArrays(gl.TRIANGLES, 0, 3);
  // feathers
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
  if (G.msaa) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.useProgram(G.pD);
  const u = G.uD;
  gl.uniformMatrix4fv(u.uVP, false, VPm);
  gl.uniform3f(u.uCam, cam.px, cam.py, cam.pz);
  gl.uniform1f(u.uPxK, cam.B * H * 0.5);
  gl.uniform1f(u.uLen, lenBase);
  gl.uniform1f(u.uMinW, 1.15 * Math.max(1, dpr * 0.85));
  gl.uniform1f(u.uMinL, 3.2 * Math.max(1, dpr * 0.85));
  gl.uniform1f(u.uFocus, cam.dist);
  gl.uniform1f(u.uT, simT);
  gl.uniform3f(u.uL, LV[0], LV[1], LV[2]);
  gl.uniform3f(u.uBg, BG[0], BG[1], BG[2]);
  gl.uniform1f(u.uExpo, expoC); gl.uniform1f(u.uWarm, warmC); gl.uniform1f(u.uIntro, intro);
  gl.uniform1f(u.uAT, G.msaa ? 0.02 : 0.45);
  gl.uniform1f(u.uDimF, 1 - bDimK * smooth(bLevel) * lerp(0.5, 1, SV.thm[0]));   // on paper the form steps back less: it would wash out
  gl.uniform3fv(u.uRest, SV.rest); gl.uniform3fv(u.uRamp, SV.ramp); gl.uniform3fv(u.uBird, SV.bird); gl.uniform3fv(u.uThm, SV.thm);
  gl.bindVertexArray(G.vaoD[G.src]);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, active);
  if (G.msaa) gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.disable(gl.DEPTH_TEST);
  // vignette + grain
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(G.pO);
  gl.uniform1f(G.uO.uMode, 1); gl.uniform1f(G.uO.uT, (frameNo * 0.6180339887) % 1);
  gl.bindVertexArray(G.vaoO); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.BLEND); gl.bindVertexArray(null);
}
function downgrade() {
  if (lockTier) return;
  // fewer feathers are drawn a little larger, as at boot, so the form keeps its density
  if (active > minActive) { active = Math.max(minActive, Math.round(active * 0.7 / 256) * 256); lenBase = 0.045 * Math.pow(20480 / active, 0.25); }
  else if (dpr > 1) { dpr = 1; dprLock = true; resizeGL(true); }
  else if (dpr > 0.7) { dpr = 0.7; dprLock = true; resizeGL(true); }
  DBG.active = active; DBG.dpr = dpr;
}
// colour, light and flutter ease toward the joining formation
function updateLook(dt) {
  const f = FORMATIONS[curB], k = 1 - Math.exp(-dt * 1.3);
  expoC = lerp(expoC, f.expo, k); warmC = lerp(warmC, f.warm, k); flutC = lerp(flutC, f.flut, k);
  lightAz = lerp(lightAz, f.light[0], k); lightEl = lerp(lightEl, f.light[2], k);
}
function updateCamera(dt) {
  if (introHold) { introPose(C); for (let i = 0; i < CKEYS.length; i++) CV[CKEYS[i]] = 0; }
  else {
    camTarget(targetKey, sideKey, secProg, simT, T);
    // critically damped spring per channel: a section change starts gently, glides, and settles (~1.8 s to 95 %)
    const w = 2.5, w2 = w * w, dmp = 2 * w;
    for (let i = 0; i < CKEYS.length; i++) { const key = CKEYS[i]; const v = CV[key] + ((T[key] - C[key]) * w2 - dmp * CV[key]) * dt; CV[key] = v; C[key] += v * dt; }
    if (mqFine.matches && ptr.has && ptr.inside) { const k = 1 - Math.exp(-dt * 1.6); ptrSX = lerp(ptrSX, ptr.x / cssW * 2 - 1, k); ptrSY = lerp(ptrSY, 1 - ptr.y / cssH * 2, k); }
  }
  buildCamera(C, cssW, cssH);
}
function shouldRun() { return mode === 'gl' && !doc.hidden && canvasVisible && !menuOpen && !DBG.hold; }
// QA: hold the live loop (so DBG.ff alone moves the scene), and let it go again
DBG.pause = () => { DBG.hold = true; syncLoop(); };
DBG.run = () => { DBG.hold = false; syncLoop(); };
// QA: step the scene in small slices until the bird state matches (e.g. 'b.level>=0.5'), at most max seconds
DBG.ffUntil = (f, max) => {
  let t = 0;
  while (t < (max || 12)) { DBG.ff(0.1, true); t += 0.1; if (f(DBG.bird)) break; }
  DBG.ff(0);
  return Math.round(t * 10) / 10;
};
function syncLoop() {
  if (shouldRun()) {
    if (!raf) {
      // resuming (tab shown, menu closed, context restored): drop pointer travel and frame timing gathered while paused
      lastNow = performance.now(); ptr.dx = 0; ptr.dy = 0; segFresh = true; winMs = 0; winN = 0; winBusy = 0; slowRun = 0;
      raf = requestAnimationFrame(loop);
    }
  }
  else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (!raf) finishSwitch();   // a loop that stops mid-switch finishes the switch first
}
// GPU back-pressure: at most two frames in flight. A new frame is not submitted while the one from two frames ago is
// still being drawn. Without this a slow GPU lets the browser queue many frames, then stalls the page (timers, the
// reveal, scrolling) while they drain. Two (not one) so a fence whose status reaches the page a frame late never
// halves the frame rate of a GPU that is keeping up.
function fencePending(i) {
  const f = G.fq[i];
  if (!f) return false;
  let st = 0; try { st = gl.getSyncParameter(f, gl.SYNC_STATUS); } catch (e) { st = gl.SIGNALED; }
  if (st !== gl.SIGNALED && performance.now() - G.fqAt[i] < 1500) return true;
  try { gl.deleteSync(f); } catch (e) {}
  G.fq[i] = null; return false;
}
function gpuBusy() {
  if (!G || !G.fq) return false;
  // Until the reveal only one frame may be in flight, so the loader's deadline never waits behind a queue.
  if (!revealed && fencePending(G.fi ^ 1)) return true;
  return fencePending(G.fi);
}
function fence() {
  if (!G || !G.fq) return;
  try {
    if (G.fq[G.fi]) gl.deleteSync(G.fq[G.fi]);
    G.fq[G.fi] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); G.fqAt[G.fi] = performance.now(); G.fi ^= 1;
    gl.flush();
  } catch (e) { G.fq[G.fi] = null; }
}
// Frame-time downgrade, judged over 1.5 s windows. A browser that caps animation frames at 30 fps (iOS Low Power Mode,
// Safari's throttled cross-origin frames) is not a slow GPU, so 30 fps alone never costs feathers: a window downgrades
// when frames average under ~24 fps, or when the GPU could not keep up (back-pressure skips) and frames are under ~42 fps.
function perfWindow(dtMs) {
  winMs += dtMs; winN++;
  if (winMs < 1500) return;
  const avg = winMs / winN, busy = winBusy / (winN + winBusy);
  winMs = 0; winN = 0; winBusy = 0;
  if (avg > 42 || (busy > 0.3 && avg > 24)) downgrade();
}
function loop(now) {
  raf = 0;
  if (!shouldRun()) return;
  raf = requestAnimationFrame(loop);
  if (gpuBusy()) { if (revealed) winBusy++; else revealCheck(); return; }
  let dtMs = now - lastNow; lastNow = now;
  if (!(dtMs > 0)) dtMs = 16.7;
  if (dtMs > 1000) dtMs = 1000;
  ema = ema * 0.9 + dtMs * 0.1;
  sceneTick(now);   // a change of theme eases in
  // A slow frame is caught up with several short spring steps (each <= 1/30 s, which keeps the spring stable),
  // so a slow GPU shows the same motion at a lower frame rate instead of slow motion.
  const dt = Math.min(dtMs / 1000, 0.25), subs = Math.min(8, Math.ceil(dt * 30 - 1e-6)), sdt = dt / subs;
  revealCheck();   // the reveal deadline holds even if timers are starved
  // the bloom: feathers leave the stroke over ~1.5 s, starting as the loader lifts
  if (revealAt >= 0 && bloom < 1) bloom = easeInOut((now - revealAt - 120) / 1500);
  const intro = revealAt < 0 ? 1 : clamp(1 - (now - revealAt) / 1300, 0, 1);
  if (revealed && !lockTier) {
    // frame-time auto-downgrade: a burst of very slow frames at once, otherwise a slow 1.5 s window (see perfWindow)
    if (dtMs > 110 && dtMs < 1000) { if (++slowRun >= 3) { slowRun = 0; downgrade(); downgrade(); winMs = 0; winN = 0; winBusy = 0; } } else slowRun = 0;
    perfWindow(dtMs);
  }
  if (simT > 28800) simT = 60;   // eight hours on one section: rebase the 32-bit shader clock (see setTarget)
  updateActive();
  advanceFlow(dt);
  updateLook(dt);
  updateCamera(dt);
  updatePointer(dt, now);
  updateLight(dt);
  updateBird(dt);
  try { for (let i = 0; i < subs; i++) { simT += sdt; stepSim(sdt, false); } renderGL(intro * 0.45); fence(); } catch (e) { logErr('frame: ' + (e && e.message)); fallBack(); return; }
  DBG.ema = Math.round(ema * 10) / 10; DBG.frame = frameNo; DBG.active = active; DBG.dpr = dpr; DBG.bloom = Math.round(bloom * 100) / 100;
}
function warmup(done) {
  // Behind the loader: place every feather on the stroke, step twice so the first frame is already alive, draw once.
  // (Kept short on purpose: a slow GPU would otherwise have a queue of work to get through before the reveal.)
  requestAnimationFrame(() => {
    if (mode !== 'gl') { done(); return; }
    try {
      updateActive(); introPose(C); buildCamera(C, cssW, cssH); pointerRay(); updateLight(0); birdPose();
      stepSim(1 / 60, true); simT += 1 / 60; stepSim(1 / 60, false); simT += 1 / 60; stepSim(1 / 60, false);
      renderGL(0.45); fence();
    } catch (e) { logErr('warmup: ' + (e && e.message)); fallBack(); done(); return; }
    DBG.tWarm = Math.round(performance.now() - t0);
    done();
  });
}
// QA: time the simulation step and the draw separately (gl.finish), n frames each
DBG.bench = n => {
  if (!G) return null; n = n || 10;
  let a = performance.now(); for (let i = 0; i < n; i++) stepSim(1 / 60, false); gl.finish(); const s = (performance.now() - a) / n;
  a = performance.now(); for (let i = 0; i < n; i++) renderGL(0); gl.finish(); const r = (performance.now() - a) / n;
  return { step: Math.round(s * 10) / 10, draw: Math.round(r * 10) / 10, active, W, H, msaa: G.msaa };
};
// QA: advance the whole scene by `sec` seconds at once (flow, look, camera, springs), then draw one frame
DBG.ff = (sec, quiet) => {
  if (mode !== 'gl' || !G) return false;
  sceneTick(performance.now() + 1e6);
  updateActive();
  const n = Math.round(sec * 30), dt = 1 / 30;
  for (let i = 0; i < n; i++) { simT += dt; advanceFlow(dt); updateLook(dt); updateCamera(dt); updatePointer(dt, performance.now()); updateLight(dt); updateBird(dt); stepSim(dt, false); }
  if (revealAt >= 0) bloom = 1;
  if (!quiet) { renderGL(0); fence(); } else gl.flush();
  return true;
};
function fallBack() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  teardownGL();
  enterPoster();
}
if (glCanvas) glCanvas.addEventListener('webglcontextlost', e => { e.preventDefault(); logErr('context lost'); if (raf) { cancelAnimationFrame(raf); raf = 0; } G = null; enterPoster(); }, false);
if (glCanvas) glCanvas.addEventListener('webglcontextrestored', () => {
  if (NOGL) return;
  initGL(err => {
    if (err) { logErr('restore: ' + (err && err.message)); teardownGL(); if (mode !== 'poster') enterPoster(); return; }
    bloom = 1; introHold = false; curA = curB = targetKey; blending = false;
    if (reduce) { mode = 'still'; DBG.mode = 'still'; drawStill(); return; }
    liveBird(); root.classList.remove('static'); root.classList.add('live', 'can-summon'); chipSync(); DBG.restored = (DBG.restored || 0) + 1;
    camTarget(targetKey, sideKey, secProg, simT, T); camSnap(); buildCamera(C, cssW, cssH); updateLight(0); stepSim(1 / 60, true); syncLoop();
  });
}, false);
if (glCanvas && 'IntersectionObserver' in window) { new IntersectionObserver(es => { canvasVisible = es[es.length - 1].isIntersecting || mode !== 'gl'; syncLoop(); }).observe(glCanvas); }
doc.addEventListener('visibilitychange', syncLoop);

/* ================= 9a. reduced motion: calm GL still frames =================
   The same feathers, snapped onto the current section's formation and drawn once. No flow, no ruffle, no glide. */
let stillTm = 0;
function scheduleStill() { clearTimeout(stillTm); stillTm = setTimeout(drawStill, 60); }
function drawStill() {
  if (mode !== 'still' || !G) return;
  finishSwitch();
  root.classList.add('static', 'can-summon'); root.classList.remove('live'); chipSync();
  try {
    resizeGL(false);
    curA = curB = targetKey; blending = false; bloom = 1; introHold = false;
    const f = FORMATIONS[targetKey];
    expoC = f.expo; warmC = f.warm; flutC = 0; lightAz = f.light[0]; lightEl = f.light[2]; lightPh = 0.35;
    simT = 2.2;
    camTarget(targetKey, sideKey, 0.5, 0, T); T.az = f.cam[0]; camSnap(); buildCamera(C, cssW, cssH);
    ray.ox = 0; ray.oy = 0; ray.oz = 50; ray.dx = 0; ray.dy = 0; ray.dz = 1; pv[0] = pv[1] = pv[2] = 0; ruffleS = 0; pulse = 0;
    updateLight(0);
    if (activeIdx < 0) updateActive();
    birdStill();
    stepSim(1 / 60, true); stepSim(1 / 60, true);
    bSnap = false;
    renderGL(0);
    DBG.still = targetKey;
  } catch (e) { logErr('still: ' + (e && e.message)); teardownGL(); enterPoster(); }
}

/* ================= 9b. no WebGL: a Canvas 2D still of the feathered wingpath, drawn once (and on resize) ================= */
let posterTm = 0, posterJob = 0;
function enterPoster() {
  DBG.tP0 = Math.round(performance.now() - t0);
  finishSwitch();
  mode = 'poster'; DBG.mode = 'poster'; root.classList.add('static'); root.classList.remove('live', 'can-summon'); chipSync();
  if (glCanvas) glCanvas.hidden = true;
  if (posterCanvas) { posterCanvas.hidden = false; drawPoster(); }
}
// the shader's flash ramp and flash brightness, on the CPU (the poster), from the same tokens
function rampJS(k, out) {
  const st = SV.ramp, li = SV.lit;
  const mixIn = (src, o, f) => { for (let j = 0; j < 3; j++) out[j] = lerp(out[j], src[o + j], f); };
  for (let j = 0; j < 3; j++) out[j] = li[j];
  mixIn(st, 0, smooth((k - 0.1) / 0.2)); mixIn(st, 3, smooth((k - 0.3) / 0.16)); mixIn(st, 6, smooth((k - 0.46) / 0.2)); mixIn(st, 9, smooth((k - 0.7) / 0.25));
  return out;
}
const flashJS = g => lerp(0.9 + 0.12 * Math.min(g, 1), 0.75 + 0.55 * Math.min(g, 1.2), SV.thm[0]);
const rgbCss = (c, k) => 'rgb(' + Math.round(clamp(c[0] * k, 0, 1) * 255) + ',' + Math.round(clamp(c[1] * k, 0, 1) * 255) + ',' + Math.round(clamp(c[2] * k, 0, 1) * 255) + ')';
/* The text pages' backdrop has the head of the page for its frame. On a wide screen it keeps the hero's framing (the
   stroke up and to the right of the title); on a narrow one the stroke is centred in the open band between the header
   and the words, as large as that band allows. */
function backdropFrame(out, vw, vh) {
  const f1 = 1 / Math.tan(34 * Math.PI / 360), y0 = hdrPx() + 16;   // the stroke is 2.9 x ~2.06 world units
  let ppu, cx = 0, cy;
  if (vw >= 900) {
    const free = Math.max(160, vh - y0 - 40);
    ppu = Math.min(0.33 * vw / 2.9, 0.55 * free / 2.06); cx = 0.45; cy = y0 + free * 0.46;
  } else {
    const h = $('.page-head', posterCanvas.parentNode) || $('h1', posterCanvas.parentNode);
    let top = vh * 0.6;
    try { if (h) top = h.getBoundingClientRect().top - posterCanvas.getBoundingClientRect().top; } catch (e) {}
    const free = Math.max(80, top - y0);
    ppu = Math.min(0.8 * vw / 2.9, 0.74 * free / 2.06); cy = y0 + free * 0.5;
  }
  out.az = FORMATIONS.wing.cam[0]; out.fov = 34; out.dist = f1 * vh / (2 * ppu);
  out.sx = cx; out.sy = 1 - 2 * cy / vh;
}
function drawPoster() {
  if (mode !== 'poster' || !posterCanvas) return;
  const job = ++posterJob;
  // the whole window behind home and values; the head of the page on the text pages
  const vw = posterCanvas.clientWidth || window.innerWidth, vh = posterCanvas.clientHeight || window.innerHeight;
  const pd = Math.min(window.devicePixelRatio || 1, 2);
  let ctx = null; try { ctx = posterCanvas.getContext('2d'); } catch (e) {}
  if (!ctx) return;
  // the hero camera, frozen (the text pages' backdrop has its own frame: the canvas, not the window)
  cssW = vw; cssH = vh;
  camTarget('wing', 'hero', 0.5, 0, T);
  if (!ENGINE) backdropFrame(T, vw, vh);
  camSnap(); buildCamera(C, vw, vh);
  const P = FORMATIONS.wing.p, N = isPhone ? 3600 : 7600, items = [];
  let s0 = 777;
  const rnd = () => { s0 = (s0 * 1664525 + 1013904223) >>> 0; return s0 / 4294967296; };
  const at = (s, o) => { const x = ((s % 1) + 1) % 1 * PATH_N, i = Math.floor(x), f = x - i, a = i * 4, b = ((i + 1) % PATH_N) * 4; for (let k = 0; k < 3; k++) o[k] = lerp(PATHS[a + k], PATHS[b + k], f); return o; };
  const c = [0, 0, 0], c2 = [0, 0, 0], c1 = [0, 0, 0], tip = new Float32Array(3);
  // the same ribbon as the WING shader: lanes across the stroke, a light twist, a few feathers in a loose halo
  for (let i = 0; i < N; i++) {
    const sx0 = (0.5 + i * 0.6180339887) % 1, lane = rnd() - 0.5, halo = rnd() > 0.88, rz = rnd(), rs = rnd();
    at(sx0, c); at(sx0 + 0.003, c2); at(sx0 - 0.003, c1);
    let tx = c2[0] - c1[0], ty = c2[1] - c1[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx, tw = P[3] * Math.sin(sx0 * TAU * 2);
    let off = lane * P[0] * Math.cos(tw), oz = lane * P[0] * Math.sin(tw);
    if (halo) { const an = rnd() * TAU, rr = P[0] * (0.58 + P[2] * rz * rz); off = Math.cos(an) * rr; oz = Math.sin(an) * rr * 0.5; }
    const x = c[0] + nx * off, y = c[1] + ny * off, z = c[2] + oz;
    project(x, y, z, P3); const X = P3[0], Y = P3[1], Wd = P3[2];
    const dx = tx + nx * lane * 0.75, dy = ty + ny * lane * 0.75;
    project(x + dx * 0.05, y + dy * 0.05, z, tip);
    // a stand-in for the shader's light: shading across the twist, narrow glint bands travelling along the stroke
    const lit = 0.5 + 0.5 * Math.cos(tw * 2.2 + sx0 * TAU * 1.0 + lane * 1.4 - 0.6);
    const g = Math.pow(Math.max(0, Math.cos(sx0 * TAU * 3.0 - 0.35 + lane * 1.1)), 20) * (0.75 + 0.5 * rs) + (halo ? 0.04 : 0);
    items.push([Wd, X, Y, Math.atan2(tip[1] - Y, tip[0] - X), lit, g, halo ? 0.82 : 1, rs]);
  }
  items.sort((a, b) => b[0] - a[0]);
  const ppu0 = cam.B * vh * 0.5, col = [0, 0, 0];
  const qc = SV.thm[0] > 0.5 ? SV.catch : SV.shade, quill = 'rgba(' + Math.round(qc[0] * 255) + ',' + Math.round(qc[1] * 255) + ',' + Math.round(qc[2] * 255) + ',';
  let i = 0;
  const paintGround = () => {
    posterCanvas.width = Math.round(vw * pd); posterCanvas.height = Math.round(vh * pd);
    ctx.setTransform(pd, 0, 0, pd, 0, 0);
    project(0, 0, 0, P3);
    const g = ctx.createRadialGradient(P3[0], P3[1], 0, P3[0], P3[1], Math.max(vw, vh) * 0.7);
    const lc = [lerp(BG[0], SV.lift[0], 0.55), lerp(BG[1], SV.lift[1], 0.55), lerp(BG[2], SV.lift[2], 0.55)];
    g.addColorStop(0, rgbCss(lc, 1)); g.addColorStop(1, rgbCss(BG, 1));
    ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
  };
  // drawn in slices so a slow device never sees one long task
  const slice = () => {
    if (job !== posterJob || mode !== 'poster') return;
    if (i === 0) paintGround();
    const end = performance.now() + 12;
    for (; i < items.length && performance.now() < end; i++) {
      const it = items[i], L = Math.max(5, 0.048 * it[6] * ppu0 / it[0] * (isPhone ? 1.35 : 1)), Wf = L * 0.2;
      const alt = it[7] > 1 - SV.thm[1], r0 = alt ? SV.alt : SV.shade, r1 = alt ? SV.alt : SV.lit;
      const rest = [lerp(r0[0], r1[0], it[4] * it[4]), lerp(r0[1], r1[1], it[4] * it[4]), lerp(r0[2], r1[2], it[4] * it[4])];
      rampJS(clamp(0.27 + 0.55 * it[5] + (it[7] - 0.5) * 0.16, 0, 1), col);
      const k = smooth((it[5] - 0.03) / 0.52), b = flashJS(it[5]);
      const fog = clamp((it[0] - cam.dist - 0.25) / 2.2, 0, 1) * 0.78 * lerp(0.4, 0.82, SV.thm[0]);
      const rgb = [0, 1, 2].map(j => clamp(lerp(lerp(rest[j], col[j] * b, k), BG[j], fog), 0, 1) * 255);
      ctx.save(); ctx.translate(it[1], it[2]); ctx.rotate(it[3]);
      ctx.beginPath(); ctx.moveTo(-L * 0.45, 0);
      ctx.bezierCurveTo(-L * 0.2, -Wf * 1.1, L * 0.3, -Wf * 1.05, L * 0.55, 0);
      ctx.bezierCurveTo(L * 0.3, Wf * 0.9, -L * 0.2, Wf * 0.85, -L * 0.45, 0);
      ctx.fillStyle = 'rgb(' + (rgb[0] | 0) + ',' + (rgb[1] | 0) + ',' + (rgb[2] | 0) + ')';
      ctx.fill();
      ctx.strokeStyle = quill + (0.07 + 0.2 * k).toFixed(3) + ')'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(-L * 0.42, 0); ctx.lineTo(L * 0.45, 0); ctx.stroke();
      ctx.restore();
    }
    if (i < items.length) setTimeout(slice, 0); else { DBG.poster = N; DBG.tP8 = Math.round(performance.now() - t0); if (ENGINE) posterBird(ctx, job); }
  };
  slice();
}
/* the poster's bird: the same mesh and the same per-feather spots as the live one, posed once where the hero's bird
   gathers (just in front of the stroke), each feather drawn small, coloured by its part and lit by its facet */
function posterBird(ctx, job) {
  if (job !== posterJob || mode !== 'poster') return;
  try {
    const L = cssW >= 900 ? 230 : 150;
    heroPt(0.53, TG); heroPt(0.57, LK);
    project(TG[0], TG[1], TG[2], P3); guard(TG, 0.45 * L, 0.3 * L); project(TG[0], TG[1], TG[2], P3);
    bird.sT = L / (1.04 * ppuAt(P3[2])); birdPlaceNow();
    bird.psi = 2.15; bird.tail = 0.14; bird.spread = 0.85; bird.pitch = 0.72; bird.roll = 0; bird.head = 0;
    birdPose();
    const n = cssW >= 900 ? 2400 : 1300, A = birdAttrs(Math.ceil(n / 0.62) + 64), out = [];
    // light from the upper left, in front (camera space), as the live key light sits
    const lx = -0.55, ly = 0.62, lz = 0.56, Lw = [0, 0, 0];
    fromLocal(lx, ly, lz, Lw, 0); const ll = Math.hypot(Lw[0], Lw[1], Lw[2]); Lw[0] /= ll; Lw[1] /= ll; Lw[2] /= ll;
    const col = [0, 0, 0], tip = new Float32Array(3);
    const lenW = 2.35 * Math.sqrt(B_AEFF * bird.s * bird.s / n);
    for (let i = 0; out.length < n && i * 8 < A.length; i++) {
      const o = i * 8, part = A[o + 3]; if (A[o + 6] >= 0.62 || (part > 6 && part <= 9)) continue;   // the wing's ghosts are left out of a still
      const a = A[o] * 3, b = A[o + 1] * 3, c = A[o + 2] * 3, b0 = A[o + 4], b1 = A[o + 5], b2 = 1 - b0 - b1;
      const px = BVW[a] * b0 + BVW[b] * b1 + BVW[c] * b2, py = BVW[a + 1] * b0 + BVW[b + 1] * b1 + BVW[c + 1] * b2, pz = BVW[a + 2] * b0 + BVW[b + 2] * b1 + BVW[c + 2] * b2;
      const ux = BVW[b] - BVW[a], uy = BVW[b + 1] - BVW[a + 1], uz = BVW[b + 2] - BVW[a + 2], vx = BVW[c] - BVW[a], vy = BVW[c + 1] - BVW[a + 1], vz = BVW[c + 2] - BVW[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      if (nx * (cam.px - px) + ny * (cam.py - py) + nz * (cam.pz - pz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
      // shaft toward the tail (along the needle on the beak), in the facet
      let fx = part === BP_BEAK ? BAX[0] : -BAX[0], fy = part === BP_BEAK ? BAX[1] : -BAX[1], fz = part === BP_BEAK ? BAX[2] : -BAX[2];
      if (part === BP_WING) { fx = fx * 0.6 + (px - bird.x) * 2; fy = fy * 0.6 + (py - bird.y) * 2; fz = fz * 0.6 + (pz - bird.z) * 2; }
      const d = fx * nx + fy * ny + fz * nz; fx -= nx * d; fy -= ny * d; fz -= nz * d;
      const fl = Math.hypot(fx, fy, fz) || 1;
      const k = part === BP_BEAK ? 0.8 : part === BP_EYE ? 0.62 : part === BP_GLINT ? 0.42 : part === BP_WING ? 1.25 : part === BP_TAIL ? 1.35 : 1;
      project(px, py, pz, P3); const X = P3[0], Y = P3[1], W = P3[2];
      project(px + fx / fl * lenW * k, py + fy / fl * lenW * k, pz + fz / fl * lenW * k, tip);
      const ndl = Math.max(0, nx * Lw[0] + ny * Lw[1] + nz * Lw[2]);
      let vxv = cam.px - px, vyv = cam.py - py, vzv = cam.pz - pz; const vl = Math.hypot(vxv, vyv, vzv) || 1; vxv /= vl; vyv /= vl; vzv /= vl;
      let hx = Lw[0] + vxv, hy = Lw[1] + vyv, hz = Lw[2] + vzv; const hl = Math.hypot(hx, hy, hz) || 1;
      const ndh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), ndv = Math.max(0, nx * vxv + ny * vyv + nz * vzv);
      const lit = 0.34 + 0.66 * ndl + 0.24 * (0.5 + 0.5 * ny) + 0.16 * ndv, rs = hj(i * 7 + 5);
      const sh = SV.sheen, pc = part === BP_BELLY ? SV.belly : part === BP_BEAK ? SV.beak : part === BP_WING ? SV.wing : part === BP_GORGET ? SV.gorget : part === BP_TAIL ? SV.tail : SV.back;
      const shn = part === BP_BEAK ? 0 : part === BP_WING ? 0.35 * Math.pow(ndh, 5) : part === BP_TAIL ? 0.35 * Math.pow(ndh, 6) : part === BP_GORGET || part === BP_BELLY ? 0 : 0.45 * Math.pow(ndh, 6);
      for (let j = 0; j < 3; j++) col[j] = pc[j] * lit + sh[j] * shn + (part === BP_BEAK ? SV.catch[j] * 0.62 * Math.pow(ndh, 10) : 0);
      if (part === BP_EYE) { col[0] = SV.eye[0]; col[1] = SV.eye[1]; col[2] = SV.eye[2]; }
      else if (part === BP_GLINT) { col[0] = SV.catch[0]; col[1] = SV.catch[1]; col[2] = SV.catch[2]; }
      if (part === BP_GORGET || part === BP_CROWN) {
        const gg = Math.pow(ndh, 2.5) * 1.5 + 0.32 * (1 - ndv) * (1 - ndv) + 0.25, RC = rampJS(clamp(0.46 + 0.4 * gg + 0.1 * (1 - ndv) + (rs - 0.5) * 0.1, 0, 1), [0, 0, 0]);
        const w = smooth((gg - 0.04) / 0.46) * (part === BP_GORGET ? 1 : 0.5), br = lerp(0.95 + 0.1 * Math.min(gg, 1), 0.8 + 0.6 * Math.min(gg, 1.2), SV.thm[0]);
        for (let j = 0; j < 3; j++) col[j] = lerp(col[j], RC[j] * br, w);
      }
      if (part < BP_EYE) { const rim = Math.pow(1 - ndv, 2.2) * (part === BP_WING ? 0.2 : 0.34); for (let j = 0; j < 3; j++) col[j] = lerp(col[j], SV.rim[j], rim); }
      const jit = 1 + (rs - 0.5) * 0.32;
      out.push([W, X, Y, Math.atan2(tip[1] - Y, tip[0] - X), Math.max(3.5, Math.hypot(tip[0] - X, tip[1] - Y)), clamp(col[0] * jit, 0, 1) * 255 | 0, clamp(col[1] * jit, 0, 1) * 255 | 0, clamp(col[2] * jit, 0, 1) * 255 | 0, part]);
    }
    out.sort((a, b) => b[0] - a[0]);
    // drawn in slices, like the stroke, so a slow device never sees one long task
    let q = 0;
    const slice = () => { try {
    if (job !== posterJob || mode !== 'poster') return;
    const end = performance.now() + 12;
    for (; q < out.length && performance.now() < end; q++) {
      const it = out[q], Lf = it[4], Wf = Lf * (it[8] === BP_BEAK ? 0.13 : 0.2);
      ctx.save(); ctx.translate(it[1], it[2]); ctx.rotate(it[3]);
      ctx.beginPath(); ctx.moveTo(-Lf * 0.45, 0);
      ctx.bezierCurveTo(-Lf * 0.2, -Wf * 1.1, Lf * 0.3, -Wf * 1.05, Lf * 0.55, 0);
      ctx.bezierCurveTo(Lf * 0.3, Wf * 0.9, -Lf * 0.2, Wf * 0.85, -Lf * 0.45, 0);
      ctx.fillStyle = 'rgb(' + it[5] + ',' + it[6] + ',' + it[7] + ')'; ctx.fill();
      ctx.strokeStyle = SV.thm[0] > 0.5 ? 'rgba(4,8,6,0.35)' : 'rgba(4,8,6,0.22)'; ctx.lineWidth = 0.5; ctx.stroke();
      ctx.restore();
    }
    if (q < out.length) setTimeout(slice, 0); else { DBG.posterBird = out.length; DBG.tPB = Math.round(performance.now() - t0); }
    } catch (e) { logErr('poster bird: ' + (e && e.message)); } };
    setTimeout(slice, 0);
  } catch (e) { logErr('poster bird: ' + (e && e.message)); }
}

/* ================= resize ================= */
let rzT = 0, lastW = window.innerWidth, lastH = window.innerHeight;
window.addEventListener('resize', () => {
  clearTimeout(rzT);
  rzT = setTimeout(() => {
    const w = window.innerWidth, h = window.innerHeight;
    const big = w !== lastW || Math.abs(h - lastH) > 120 || !('ontouchstart' in window);
    lastW = w; lastH = h;
    markW = 0;
    measure(); updateActive();
    if (!big) return;
    // browser zoom or a move to another screen changes the pixel ratio: follow it unless the downgrade has chosen one
    if ((mode === 'gl' || mode === 'still') && !dprLock) dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    if (mode === 'gl') resizeGL(false); else if (mode === 'still') drawStill(); else if (mode === 'poster') { clearTimeout(posterTm); posterTm = setTimeout(drawPoster, 60); }
  }, 140);
});
// When the frame loop is not running (still frames, poster, paused) sections are still tracked on scroll.
let scrollQ = false;
window.addEventListener('scroll', () => { if (raf || scrollQ) return; scrollQ = true; requestAnimationFrame(() => { scrollQ = false; updateActive(); }); }, { passive: true });
onMQ(mqReduce, e => {
  reduce = e.matches;
  if (reduce && mode === 'gl') { if (raf) { cancelAnimationFrame(raf); raf = 0; } finishSwitch(); mode = 'still'; DBG.mode = 'still'; drawStill(); }
  else if (!reduce && mode === 'still') { mode = 'gl'; DBG.mode = 'gl'; liveBird(); root.classList.remove('static'); root.classList.add('live'); camTarget(targetKey, sideKey, secProg, simT, T); camSnap(); syncLoop(); }
});

// Back or Forward from the page cache: the scene picks up where it was, in the theme chosen meanwhile
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  try { const st = localStorage.getItem('hb-theme'); if ((st === 'light' || st === 'dark') && st !== theme) { themeStored = true; applyTheme(st); } } catch (x) {}
  measure(); updateActive(); syncLoop();
});

/* ================= 10. boot ================= */
measure();
updateActive();
if (!ENGINE) {
  // the text pages: no loader, no live scene, no Flux; the wingpath drawn once, still, behind the page's head
  revealed = true; DBG.revealed = true; introHold = false;
  if (posterCanvas) requestAnimationFrame(() => enterPoster()); else { mode = 'none'; DBG.mode = 'none'; }
} else {
introPose(C); buildCamera(C, cssW, cssH); pointerRay();
requestAnimationFrame(() => setTimeout(() => {
  if (NOGL) { enterPoster(); revealSoon(1250); return; }
  initGL(err => {
    if (err) { logErr(String(err && err.message || err)); teardownGL(); enterPoster(); revealSoon(1250); return; }
    if (reduce) { mode = 'still'; DBG.mode = 'still'; introHold = false; bloom = 1; drawStill(); revealSoon(300); return; }
    warmup(() => { revealSoon(1250); if (mode === 'gl') { root.classList.add('live', 'can-summon'); chipSync(); } syncLoop(); });
  });
}, 30));
}
})();
