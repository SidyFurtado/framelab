/**
 * Ícones do navegador de ferramentas.
 *
 * A prévia do novo design usa Lucide 0.468.0. Os oito desenhos que já
 * existiam lá estão incorporados abaixo com a geometria daquela versão,
 * para o painel funcionar offline. `title` é a extensão da família: um T
 * com dois brilhos, na mesma grade de 24 px, peso e terminações.
 */
const SHAPES: Record<string, string> = {
  zoom:
    '<circle cx="11" cy="11" r="8"/>' +
    '<line x1="21" x2="16.65" y1="21" y2="16.65"/>' +
    '<line x1="11" x2="11" y1="8" y2="14"/>' +
    '<line x1="8" x2="14" y1="11" y2="11"/>',

  cut:
    '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>' +
    '<line x1="22" x2="16" y1="9" y2="15"/>' +
    '<line x1="16" x2="22" y1="9" y2="15"/>',

  speech:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
    '<path d="m14.5 7.5-5 5"/><path d="m9.5 7.5 5 5"/>',

  curve:
    '<path d="M4 18C10 18 10 6 20 6"/>' +
    '<path d="m4 16 2 2-2 2-2-2 2-2Z"/>' +
    '<path d="m20 4 2 2-2 2-2-2 2-2Z"/>',

  caption:
    '<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/>' +
    '<path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',

  text:
    '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/>' +
    '<path d="M2 5h12"/><path d="M7 2h1"/>' +
    '<path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',

  title:
    '<path d="M3 6V4h10v2"/><path d="M8 4v16"/><path d="M5.5 20h5"/>' +
    '<path d="M18 3v4M16 5h4"/>' +
    '<path d="M19.5 12.5v3M18 14h3"/>',

  download:
    '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/>' +
    '<path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>',

  /* Efeitos Sonoros: as barras de um som (Lucide audio-lines). */
  sfx:
    '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/>' +
    '<path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',

  /* SFX Automático: as mesmas barras, mais baixas, com o brilho de quatro
     pontas que marca o que a ferramenta faz sozinha. */
  "sfx-auto":
    '<path d="M3 11v4"/><path d="M7 8v10"/><path d="M11 5v16"/>' +
    '<path d="M15 12v6"/><path d="M19 15v2"/>' +
    '<path d="M18.5 2c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z"/>',

  folder:
    '<path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"/>' +
    '<path d="M2 8v11a2 2 0 0 0 2 2h14"/>',

  frame: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
};

/**
 * Cada forma recebe os atributos diretamente. Isso evita depender da
 * herança de SVG do UXP, sem mudar a aparência de traço da prévia.
 */
export function glyph(name: string): string {
  const shapes = (SHAPES[name] ?? SHAPES.frame).replace(
    /<(path|circle|line|rect) /g,
    '<$1 fill="none" stroke="currentColor" stroke-width="1.55" ' +
      'stroke-linecap="round" stroke-linejoin="round" '
  );
  return (
    '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true" ' +
    'fill="none" stroke="currentColor">' + shapes + "</svg>"
  );
}
