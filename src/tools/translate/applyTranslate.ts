/**
 * A tradução aplicada ao arquivo, sem tocar no relógio.
 *
 * ── A promessa ─────────────────────────────────────────────────────
 * Os carimbos de tempo saem idênticos aos que entraram. Não é uma
 * meta: é uma invariante checada em teste. O texto do relógio nem
 * passa por número — vai de um objeto ao outro como string.
 *
 * ── Por que reembrulhar ────────────────────────────────────────────
 * Português ocupa mais espaço que inglês. Uma linha de 40 caracteres
 * em inglês volta com 48, e uma legenda de duas linhas vira um bloco
 * de três que tapa a imagem. O texto traduzido é rearrumado na MEDIDA
 * DO PRÓPRIO ARQUIVO (ver `measureStyle`), não numa régua fixa: quem
 * trouxe uma legenda vertical de uma linha recebe uma linha de volta.
 */
import { wrap, type SrtOptions, SRT_DEFAULTS } from "../captions/srt";
import {
  measureStyle,
  parseSrt,
  serializeSrt,
  type SrtDocument,
} from "./srtFile";
import { translate, type TranslateOptions } from "./engine";
import { agruparFrases, redistribuir } from "./sentences";

export interface ApplyResult {
  ok: boolean;
  /** O arquivo pronto, para gravar. */
  content: string | null;
  /** Quantos blocos tinham texto e foram traduzidos. */
  translated: number;
  total: number;
  /** O idioma que o serviço reconheceu, quando pediram detecção. */
  detected: string | null;
  error: string | null;
}

/**
 * Junta as linhas de um bloco numa frase só para traduzir.
 *
 * A quebra de linha dentro do bloco é decisão de LAYOUT, não de
 * conteúdo — mandar "Fui à loja porque\nprecisava de leite" em duas
 * partes faria o tradutor tratar cada metade como frase independente.
 */
function juntar(lines: readonly string[]): string {
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export async function translateSrt(
  raw: string,
  options: TranslateOptions
): Promise<ApplyResult> {
  const doc = parseSrt(raw);
  if (doc.cues.length === 0) {
    return {
      ok: false,
      content: null,
      translated: 0,
      total: 0,
      detected: null,
      error: "empty",
    };
  }

  const entradas = doc.cues.map((cue) => juntar(cue.lines));

  /*
   * A unidade de tradução é a FRASE, não o bloco.
   *
   * Os blocos que formam uma frase vão juntos ao tradutor e a
   * tradução volta repartida entre eles, na proporção do que cada um
   * carregava. Os carimbos de tempo não são tocados: cada bloco fica
   * no lugar onde estava, só com o seu pedaço do texto novo.
   *
   * Ver `sentences.ts` para o lado a lado que mediu a diferença.
   */
  const grupos = agruparFrases(entradas);
  const frases = grupos.map((g) => g.map((i) => entradas[i]).join(" ").trim());

  const resultado = await translate(frases, options);
  if (!resultado.ok) {
    return {
      ok: false,
      content: null,
      translated: 0,
      total: doc.cues.length,
      detected: resultado.detected,
      error: resultado.error,
    };
  }

  const estilo = measureStyle(doc);
  const regra: SrtOptions = {
    ...SRT_DEFAULTS,
    maxLineChars: estilo.maxLineChars,
    maxLines: estilo.maxLines,
  };

  /*
   * O português ocupa mais espaço, e `wrap` nunca perde texto: com uma
   * linha permitida, uma frase de 52 caracteres vira uma linha de 52 —
   * exatamente o transbordo que a medida existe para evitar.
   *
   * Então a tradução pode ganhar UMA linha, e só quando precisa. Uma
   * legenda vertical de linha única continua de linha única sempre que
   * a tradução couber; quando não couber, duas linhas curtas leem
   * melhor que uma que sai da tela.
   */
  function embrulhar(texto: string): string[] {
    const aperto = wrap(texto, regra);
    const coube = aperto.every((linha) => linha.length <= regra.maxLineChars);
    if (coube || regra.maxLines >= 3) {
      return aperto;
    }
    return wrap(texto, { ...regra, maxLines: regra.maxLines + 1 });
  }

  // A tradução de cada frase volta para os blocos de onde ela veio.
  const porBloco = new Map<number, string>();
  grupos.forEach((grupo, g) => {
    const traduzida = resultado.texts[g] ?? frases[g];
    const pesos = grupo.map((i) => entradas[i].length || 1);
    const partes = redistribuir(traduzida, pesos);
    grupo.forEach((indice, k) => porBloco.set(indice, partes[k] ?? ""));
  });

  let traduzidos = 0;
  const saida: SrtDocument = {
    ...doc,
    cues: doc.cues.map((cue, i) => {
      const antes = entradas[i];
      const depois = porBloco.get(i) ?? antes;
      if (antes && depois.trim() !== "" && depois !== antes) traduzidos += 1;
      return {
        ...cue,
        // O relógio atravessa como string. É a invariante da ferramenta.
        timing: cue.timing,
        lines: depois.trim() === "" ? cue.lines : embrulhar(depois.trim()),
      };
    }),
  };

  return {
    ok: true,
    content: serializeSrt(saida),
    translated: traduzidos,
    total: doc.cues.length,
    detected: resultado.detected,
    error: null,
  };
}

/** Uma prévia curta: o que era e o que virou. */
export function previewPairs(
  raw: string,
  content: string,
  quantos = 3
): { antes: string; depois: string }[] {
  const a = parseSrt(raw).cues;
  const b = parseSrt(content).cues;
  const saida: { antes: string; depois: string }[] = [];
  for (let i = 0; i < Math.min(quantos, a.length, b.length); i += 1) {
    const antes = juntar(a[i].lines);
    if (!antes) continue;
    saida.push({ antes, depois: juntar(b[i].lines) });
  }
  return saida;
}
