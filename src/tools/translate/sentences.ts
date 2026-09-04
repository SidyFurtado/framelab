/**
 * A frase, não o bloco.
 *
 * ── Por que este módulo existe ─────────────────────────────────────
 * Numa legenda de verdade a frase atravessa três, quatro blocos:
 *
 *     12  I didn't know what I was
 *     13  going to do anymore, until one
 *     14  day my director wrote me a message.
 *
 * Traduzir bloco a bloco entrega cada pedaço ao tradutor sem sujeito,
 * sem verbo e sem contexto. Medido, lado a lado, no mesmo arquivo:
 *
 *     bloco a bloco →  "eu não sabia o que eu era"
 *                      "vou fazer mais, até que um"
 *     frase inteira →  "Eu não sabia mais o que iria fazer, até que
 *                       um dia meu diretor me escreveu uma mensagem."
 *
 * O primeiro não é uma tradução ruim: é outra coisa. "what I was /
 * going to do" virou "o que eu era" porque o corte caiu no meio do
 * tempo verbal.
 *
 * ── E o relógio ────────────────────────────────────────────────────
 * A promessa da ferramenta continua de pé: os carimbos não mudam. A
 * frase é traduzida junta e depois REDISTRIBUÍDA nos mesmos blocos,
 * na proporção do que cada um carregava. O bloco 12 fica com o começo
 * da frase traduzida, o 13 com o meio, o 14 com o fim — cada um no seu
 * tempo, exatamente como entrou.
 */

/** Fim de frase: o ponto pode vir seguido de aspas ou parêntese. */
const FIM_DE_FRASE = /[.!?…]["'”’)\]]?\s*$/;

/**
 * Sem pontuação, o grupo fecha aqui.
 *
 * Legenda automática às vezes vem sem ponto nenhum. Sem um teto, o
 * arquivo inteiro viraria uma "frase" só, e a redistribuição teria de
 * adivinhar cortes em trezentos blocos de uma vez.
 */
const MAX_BLOCOS_POR_FRASE = 8;

/** Índices dos blocos que formam cada frase. */
export function agruparFrases(textos: readonly string[]): number[][] {
  const grupos: number[][] = [];
  let atual: number[] = [];

  textos.forEach((texto, i) => {
    const limpo = texto.trim();
    // Bloco sem letra ("♪", "...") não entra em frase nenhuma: fica
    // sozinho e passa intacto.
    if (limpo === "" || !/\p{Letter}/u.test(limpo)) {
      if (atual.length > 0) grupos.push(atual);
      grupos.push([i]);
      atual = [];
      return;
    }
    atual.push(i);
    if (FIM_DE_FRASE.test(limpo) || atual.length >= MAX_BLOCOS_POR_FRASE) {
      grupos.push(atual);
      atual = [];
    }
  });

  if (atual.length > 0) grupos.push(atual);
  return grupos;
}

/**
 * Devolve a frase traduzida aos blocos de onde ela veio.
 *
 * Os cortes caem na proporção do que cada bloco original carregava —
 * um bloco que tinha um terço da frase recebe cerca de um terço da
 * tradução — e sempre em espaço entre palavras. Nenhum bloco fica
 * vazio enquanto houver palavra para dar: um buraco no meio da
 * legenda é pior que um corte um pouco torto.
 */
export function redistribuir(
  traduzido: string,
  pesos: readonly number[]
): string[] {
  const n = pesos.length;
  if (n <= 1) return [traduzido.trim()];

  const palavras = traduzido.trim().split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return pesos.map(() => "");

  // Menos palavras que blocos: uma para cada, na ordem, e os últimos
  // ficam vazios em vez de repetir texto.
  if (palavras.length <= n) {
    return pesos.map((_, i) => palavras[i] ?? "");
  }

  /*
   * Cada bloco recebe uma COTA de palavras, calculada antes de
   * distribuir — não um corte encontrado enquanto se anda pelo texto.
   *
   * A primeira versão fechava o bloco quando o cursor passava de uma
   * marca proporcional, com uma trava para não deixar bloco vazio. Com
   * pesos muito desiguais ([90, 5, 5]) a trava impedia o fechamento e
   * o primeiro bloco levava a frase inteira, deixando os outros dois
   * VAZIOS — dois buracos no meio da legenda. Foi o teste de pesos
   * desiguais que pegou.
   *
   * Com cota, o piso de uma palavra por bloco é aritmética, não sorte:
   * cada bloco leva no máximo o que sobra depois de reservar uma
   * palavra para cada bloco seguinte.
   */
  const somaPesos = pesos.reduce((soma, p) => soma + p, 0) || n;
  const partes: string[] = [];
  let cursor = 0;
  let restam = palavras.length;

  for (let i = 0; i < n; i += 1) {
    if (i === n - 1) {
      partes.push(palavras.slice(cursor).join(" "));
      break;
    }
    const blocosDepois = n - i - 1;
    const cota = Math.round((pesos[i] / somaPesos) * palavras.length);
    const teto = restam - blocosDepois;
    const levar = Math.max(1, Math.min(cota, teto));
    partes.push(palavras.slice(cursor, cursor + levar).join(" "));
    cursor += levar;
    restam -= levar;
  }
  return partes;
}
