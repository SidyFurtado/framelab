/**
 * As marcas das ferramentas.
 *
 * ── Por que são CHEIAS, e não de traço ─────────────────────────────
 * O UXP desenha SVG por um caminho próprio, e nele `fill="none"` não
 * vale: toda forma nasce preenchida, e de PRETO quando ninguém disse
 * o contrário. Um ícone de traço — `fill="none" stroke="currentColor"`
 * — chega ao painel como um borrão escuro no lugar do desenho. Foi
 * isso que aconteceu, e foi por isso que remendar o `fill` elemento a
 * elemento não resolveu: a propriedade que o remendo usava é
 * justamente a que o host ignora.
 *
 * Então o vocabulário inverte. Nada de contorno: cada marca é uma
 * SILHUETA, desenhada com o preenchimento — que é o único modo de
 * pintar que o UXP garante — e o vazio vira parte do desenho, aberto
 * com `fill-rule="evenodd"` quando é preciso um buraco.
 *
 * Toda forma leva `fill="currentColor"` escrito no próprio elemento.
 * Herdar do <svg> não basta pelo mesmo motivo, e a cor precisa seguir
 * o estado do item no navegador — apagada quando em repouso, no
 * acento quando ativa.
 *
 * Grade de 14×14, cantos retos, peso visual constante entre as marcas.
 */
const PATHS: Record<string, string> = {
  /* Zoom: quatro cantos abrindo o quadro, como o maximizar da prévia. */
  zoom:
    '<path d="M1.2 1.2h4.6v1.6h-3v3H1.2z"/>' +
    '<path d="M8.2 1.2h4.6v4.6h-1.6v-3h-3z"/>' +
    '<path d="M1.2 8.2h1.6v3h3v1.6H1.2z"/>' +
    '<path d="M11.2 8.2h1.6v4.6H8.2v-1.6h3z"/>',

  /* Curvas: dois keyframes diamante conectados pela rampa de uma aceleração (easing S-curve). */
  curve:
    '<path d="M2.5 9.2L4.5 11.2L2.5 13.2L0.5 11.2Z"/>' +
    '<path d="M11.5 0.8L13.5 2.8L11.5 4.8L9.5 2.8Z"/>' +
    '<path d="M4.1 10.4c1.2-.2 1.5-1 2-2.6l.7-2.1c.6-2 1.5-3.1 3.1-3.5l.4 1.5c-1 .3-1.4 1-1.9 2.5l-.7 2.1c-.7 2.2-1.6 3.4-3.3 3.7z"/>',

  /*
   * Corte: dois blocos e o vão entre eles.
   *
   * A primeira versão era uma barra vertical entre dois traços
   * horizontais — que a 13px lê como um sinal de MAIS, ou seja, o
   * oposto do que a ferramenta faz. O que diz "corte" é o vão: dois
   * pedaços de clipe separados, com a lâmina fina no meio.
   */
  cut:
    '<path d="M1 3.8h4.3v6.4H1z"/><path d="M8.7 3.8H13v6.4H8.7z"/>' +
    '<path d="M6.6 2.4h0.8v9.2h-0.8z"/>',

  /* Quadro: a marca de reserva, e a base do Zoom sem o recorte. */
  frame: '<path fill-rule="evenodd" d="M1 2.2h12v9.6H1V2.2Zm1.5 1.5v6.6h9V3.7h-9Z"/>',

  /* Onda: a forma de um som. */
  wave:
    '<path d="M1 6.4h1.2v1.2H1z"/><path d="M3.4 4.2h1.2v5.6H3.4z"/>' +
    '<path d="M5.8 2.2h1.2v9.6H5.8z"/><path d="M8.2 4.8h1.2v4.4H8.2z"/>' +
    '<path d="M10.6 6.1h1.2v1.8h-1.2z"/>',

  /* Medidor: quatro colunas sobre a linha de base. */
  meter:
    '<path d="M1.6 10.4h10.8v1.4H1.6z"/><path d="M2.6 6.8h1.6v2.9H2.6z"/>' +
    '<path d="M5.4 4.4h1.6v5.3H5.4z"/><path d="M8.2 5.8h1.6v3.9H8.2z"/>' +
    '<path d="M11 7.6h1.4v2.1H11z"/>',

  /* Legenda: a tarja, com as duas linhas abertas nela. */
  caption:
    '<path fill-rule="evenodd" d="M1 2.6h12v8.8H1V2.6Zm2.2 2.6v1.4h4.2V5.2H3.2Zm0 3v1.4h7.6V8.2H3.2Z"/>',

  /* Pasta: a aba e o corpo, numa silhueta só. */
  folder: '<path d="M1.2 2.6h4.3l1.1 1.5h6.2v7.3H1.2V2.6Z"/>',

  /* Texto: o T da letra — a marca de traduzir. */
  text: '<path d="M2.2 2.6h9.6v1.9H8.1v7H5.9v-7H2.2z"/>',

  /* Baixar: a seta e o chão onde ela pousa. */
  download:
    '<path d="M5.9 1.8h2.2v4.1h2.6L7 9.9 3.3 5.9h2.6z"/>' +
    '<path d="M2.2 10.8h9.6v1.5H2.2z"/>',

  /*
   * Muletas: o balão de fala, com as reticências abertas nele.
   *
   * O rabicho é o que o separa da tarja de Legendas — sem ele, as
   * duas marcas viram o mesmo retângulo com linhas dentro. Por isso
   * ele é largo e desce fundo, em vez de ser um detalhe no canto.
   */
  speech:
    '<path fill-rule="evenodd" d="M1 2h12v7.2H7.9L4.3 12.4V9.2H1V2Z' +
    'm2.7 2.9v1.4h1.3V4.9H3.7Zm2.65 0v1.4h1.3V4.9H6.35Zm2.65 0v1.4h1.3V4.9H9Z"/>',
};

/**
 * A marca, pronta para ir ao innerHTML.
 *
 * `fill="currentColor"` entra em CADA forma e não só no <svg>: no UXP
 * o preenchimento não desce do pai, e uma marca sem ele sai preta —
 * legível no tema claro por acidente, invisível no escuro.
 */
export function glyph(name: string): string {
  const shapes = (PATHS[name] ?? PATHS.frame).replace(
    /<path /g,
    '<path fill="currentColor" '
  );
  return (
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">' +
    shapes +
    "</svg>"
  );
}
