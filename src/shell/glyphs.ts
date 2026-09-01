/**
 * Tool marks. Geometric, 1px stroke, drawn in a square slot — the
 * site's flat vocabulary rather than icons inside rounded tiles.
 */
const PATHS: Record<string, string> = {
  zoom: '<circle cx="6.2" cy="6.2" r="3.8"/><path d="M9.2 9.2 12 12"/><path d="M4.7 6.2h3M6.2 4.7v3"/>',
  curve: '<path d="M2 11c3.4 0 3.4-8 5-8s2.6 4.5 5 4.5"/>',
  cut: '<path d="M2 7h10"/><path d="M4.5 3v8M9.5 3v8"/>',
  frame: '<rect x="2" y="3.5" width="10" height="7"/><rect x="4.6" y="5.6" width="4.8" height="2.8"/>',
  wave: '<path d="M2 7h1.6M4.4 4.4v5.2M6.4 2.6v8.8M8.4 5v4M10.4 6.2v1.6M12 7h.4"/>',
  meter: '<path d="M2.4 10.6h9.2"/><path d="M3.8 10.6V7.4M6.2 10.6V4.6M8.6 10.6V6M11 10.6V8.2"/>',
  caption: '<rect x="2" y="3.6" width="10" height="6.8"/><path d="M4.2 6.4h3.2M4.2 8.2h5.6"/>',
  folder: '<path d="M2 4.2h3.6l1 1.4H12v5.2H2z"/>',
  text: '<path d="M2.6 3.6h8.8M7 3.6v7.2M4.8 10.8h4.4"/>',
  download: '<path d="M7 2.4v6.4"/><path d="M4.2 6.2 7 9l2.8-2.8"/><path d="M2.6 11.4h8.8"/>',
};

export function glyph(name: string): string {
  const path = PATHS[name] ?? PATHS.frame;
  return (
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.1" stroke-linecap="square">' +
    path +
    "</svg>"
  );
}
