/**
 * Os desenhos da ferramenta de efeitos.
 *
 * ── Por que tudo é SVG com atributo em cada forma ──────────────────
 * O triângulo de "tocar" nasceu em CSS, com bordas transparentes — o
 * truque de sempre na web. No UXP ele saiu como um bloco branco (print
 * do editor, 2026-09-22): o host não pinta borda transparente do jeito
 * que o navegador pinta. SVG é o que o painel desenha certo, desde que
 * cada forma leve o próprio `fill`/`stroke` (ver `glyphs.ts`).
 *
 * Geometria dos ícones de categoria: Lucide 0.468, a mesma família do
 * navegador de ferramentas.
 */

const STROKE =
  'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ';

function stroked(shapes: string): string {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    shapes.replace(/<(path|circle|line|rect) /g, `<$1 ${STROKE}`) +
    "</svg>"
  );
}

const CATEGORY_SHAPES: Record<string, string> = {
  assinatura: '<path d="M3 17c3-1 5-6 7-6s0 6 3 6 3-4 5-4 2 2 3 2"/><path d="M3 21h18"/>',
  pops: '<circle cx="9" cy="10" r="5"/><circle cx="17" cy="16" r="3"/><circle cx="17.5" cy="6" r="1.5"/>',
  glitch: '<path d="M4 6h9"/><path d="M8 10h12"/><path d="M3 14h8"/><path d="M13 18h8"/>',
  dinheiro: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5"/><path d="M12 6v12"/>',
  cartoon: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/>',
  pessoas: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  foley: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  ambientes: '<rect x="4" y="3" width="10" height="18" rx="1"/><path d="M14 9h6v12h-6"/><path d="M8 7h2M8 11h2M8 15h2"/>',
  natureza: '<path d="M7 16a4 4 0 1 1 1-7.9A5 5 0 0 1 18 9a3.5 3.5 0 0 1-1 6.9"/><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2"/>',
  fogo: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5.5 1-8.5z"/>',
  animais: '<circle cx="7" cy="9" r="1.8"/><circle cx="11" cy="6" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M8 17c0-3 2-5 4-5s4 2 4 5c0 1.5-1.5 2.5-4 2.5S8 18.5 8 17z"/>',
  esportes: '<circle cx="12" cy="12" r="9"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M3 12h18"/>',
  alarmes: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 18h14v3H5z"/><path d="M12 3v2M4.5 6.5l1.4 1.4M19.5 6.5l-1.4 1.4"/>',
  games: '<rect x="2" y="7" width="20" height="10" rx="4"/><path d="M7 10v4M5 12h4"/><path d="M15 11h.01M18 13h.01"/>',
  musical: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  memes: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/><path d="M9 11h.01M15 11h.01"/><path d="M9 14.5c.8.8 1.8 1.2 3 1.2s2.2-.4 3-1.2"/>',
  // wind
  whooshes:
    '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/>' +
    '<path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
  // zap
  impactos:
    '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  // trending-up
  risers: '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  // mouse-pointer-click
  interface:
    '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/>' +
    '<path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
  // clapperboard
  cinematicos:
    '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/>' +
    '<path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  // camera
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>' +
    '<circle cx="12" cy="13" r="3"/>',
  // keyboard
  computador:
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/>' +
    '<path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/>' +
    '<path d="M16 12h.01"/><path d="M7 16h10"/>',
  // sparkles
  brilhos:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>' +
    '<path d="M20 3v4"/><path d="M22 5h-4"/>',
  // shapes
  diversos:
    '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
};

/** audio-lines: para pasta nova, que ainda não tem desenho próprio. */
const FALLBACK_SHAPES =
  '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/>' +
  '<path d="M18 5v13"/><path d="M22 10v3"/>';

/** Categorias que herdam um desenho que já existe. */
const SAME_AS: Record<string, string> = { cliques: "interface", tecnologia: "computador" };

export function categoryIcon(categoryId: string): string {
  return stroked(CATEGORY_SHAPES[categoryId] ?? CATEGORY_SHAPES[SAME_AS[categoryId] ?? ""] ?? FALLBACK_SHAPES);
}

const STAR_PATH =
  "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z";

export function starIcon(on: boolean): string {
  const paint = on
    ? 'fill="currentColor" stroke="currentColor" stroke-width="1.6"'
    : 'fill="none" stroke="currentColor" stroke-width="1.8"';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${paint} stroke-linejoin="round" d="${STAR_PATH}"/></svg>`;
}

/** O triângulo, levemente à direita do centro — o centro ótico dele. */
export const PLAY_ICON =
  '<svg class="sfx-i-play" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M8.5 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7z"/>' +
  "</svg>";

/** Três barras que sobem e descem enquanto o som toca. */
export const EQ_ICON =
  '<span class="sfx-i-eq" aria-hidden="true"><span></span><span></span><span></span></span>';

/** Um arco girando enquanto o som vem do Drive. */
export const SPIN_ICON =
  '<svg class="sfx-i-spin" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M12 3a9 9 0 0 1 9 9"/>' +
  "</svg>";

/**
 * plus: pôr o som na timeline, na agulha. Não é uma seta para baixo —
 * essa lia como "baixar", e baixar é outra coisa aqui.
 */
export const INSERT_ICON = stroked('<path d="M5 12h14"/><path d="M12 5v14"/>');

export const FOLDER_ICON = stroked(
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
);

export const SEARCH_ICON = stroked('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>');

export const BACK_ICON = stroked('<path d="m15 18-6-6 6-6"/>');

export const REFRESH_ICON = stroked(
  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
);
