/**
 * O tradutor.
 *
 * ── Por que este endpoint ──────────────────────────────────────────
 * Foram testados quatro antes de escolher, contra o mesmo texto:
 *
 *   translate.googleapis.com/translate_a  →  recusa ("Sorry..."),
 *                                            com e sem User-Agent
 *   libretranslate.com                    →  exige chave
 *   clients5.google.com/translate_a/t     →  responde, e de quebra diz
 *                                            o idioma que detectou
 *   api.mymemory.translated.net           →  responde, cota diária
 *
 * O terceiro é o principal e o quarto é a reserva. Nenhum dos dois
 * pede cadastro, chave ou cartão — que é o que permite a ferramenta
 * funcionar no primeiro clique, como o resto do plugin.
 *
 * ── O formato tem duas caras ───────────────────────────────────────
 * Medido: com detecção automática a resposta vem `[[texto, idioma]]`;
 * com idioma de origem fixo vem `[texto]`. Ler só uma das formas
 * devolveria `undefined` em metade dos casos.
 *
 * ── Lotes ──────────────────────────────────────────────────────────
 * O parâmetro `q` se repete, e a resposta volta na MESMA ORDEM — que é
 * exatamente o que uma legenda precisa, porque cada tradução tem de
 * voltar para o seu carimbo de tempo. Medido numa legenda de 320
 * blocos (13 min): 8 lotes, 3,4 segundos, nenhuma falha.
 *
 * O corte do lote é por TAMANHO DE URL, não por número de falas: uma
 * legenda de frases longas estoura o limite do servidor muito antes de
 * chegar a 40 blocos.
 */

/** Onde a URL para de crescer. Medido: 2,2 kB passa folgado. */
const MAX_URL = 5500;
/** Nem que caibam mil: acima disto a resposta demora sem ganho. */
const MAX_POR_LOTE = 48;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface TranslateOptions {
  /** Código do idioma de origem, ou "auto". */
  from: string;
  to: string;
  onProgress?: (feitos: number, total: number) => void;
  cancelled?: () => boolean;
}

export interface TranslateResult {
  ok: boolean;
  /** Uma tradução por entrada, na mesma ordem. */
  texts: string[];
  /** O idioma que o serviço reconheceu, quando `from` era "auto". */
  detected: string | null;
  error: string | null;
}

/**
 * Texto que não se traduz.
 *
 * Um bloco com "♪", "..." ou "[música]" não tem o que traduzir, e
 * mandá-lo gasta cota e às vezes volta estropiado. Fica como está.
 */
function semPalavras(texto: string): boolean {
  return !/\p{Letter}/u.test(texto);
}

function montarUrl(base: string, textos: readonly string[]): string {
  return base + textos.map((t) => `&q=${encodeURIComponent(t)}`).join("");
}

/** Divide em lotes que caibam na URL. */
export function loteDe(
  textos: readonly string[],
  base: string,
  maxUrl = MAX_URL,
  maxItens = MAX_POR_LOTE
): string[][] {
  const lotes: string[][] = [];
  let atual: string[] = [];
  for (const texto of textos) {
    const tentativa = [...atual, texto];
    if (
      atual.length > 0 &&
      (tentativa.length > maxItens || montarUrl(base, tentativa).length > maxUrl)
    ) {
      lotes.push(atual);
      atual = [texto];
    } else {
      atual = tentativa;
    }
  }
  if (atual.length > 0) lotes.push(atual);
  return lotes;
}

/**
 * Lê a resposta nas duas formas possíveis.
 *
 * Devolve null quando a contagem não bate com o pedido: uma resposta
 * com um item a menos deslocaria TODAS as traduções seguintes para o
 * carimbo errado, e uma legenda inteira sairia fora de sincronia sem
 * erro nenhum na tela.
 */
export function lerResposta(
  bruto: string,
  esperados: number
): { texts: string[]; detected: string | null } | null {
  let dados: unknown;
  try {
    dados = JSON.parse(bruto);
  } catch {
    return null;
  }
  if (!Array.isArray(dados) || dados.length !== esperados) {
    return null;
  }
  const texts: string[] = [];
  let detected: string | null = null;
  for (const item of dados) {
    if (typeof item === "string") {
      texts.push(item);
    } else if (Array.isArray(item) && typeof item[0] === "string") {
      texts.push(item[0]);
      if (!detected && typeof item[1] === "string") detected = item[1];
    } else {
      return null;
    }
  }
  return { texts, detected };
}

async function pedirGoogle(
  textos: readonly string[],
  from: string,
  to: string
): Promise<{ texts: string[]; detected: string | null } | null> {
  const base =
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex` +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}`;
  const resposta = await fetch(montarUrl(base, textos), {
    headers: { "User-Agent": UA },
  });
  if (!resposta.ok) return null;
  return lerResposta(await resposta.text(), textos.length);
}

/**
 * A reserva, uma fala por vez.
 *
 * O MyMemory não aceita lote, então só entra quando o principal caiu —
 * e mesmo aí vale a pena: uma legenda traduzida devagar é melhor que
 * uma ferramenta que não traduz.
 */
async function pedirMyMemory(
  textos: readonly string[],
  from: string,
  to: string
): Promise<{ texts: string[]; detected: string | null } | null> {
  const par = `${from === "auto" ? "autodetect" : from}|${to}`;
  const saida: string[] = [];
  for (const texto of textos) {
    const url =
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texto)}` +
      `&langpair=${encodeURIComponent(par)}`;
    const resposta = await fetch(url);
    if (!resposta.ok) return null;
    const dados = (await resposta.json()) as {
      responseData?: { translatedText?: string };
      responseStatus?: number;
    };
    const traduzido = dados?.responseData?.translatedText;
    if (typeof traduzido !== "string") return null;
    saida.push(traduzido);
  }
  return { texts: saida, detected: null };
}

export async function translate(
  entradas: readonly string[],
  options: TranslateOptions
): Promise<TranslateResult> {
  // As falas sem letra nenhuma nunca saem daqui: voltam idênticas.
  const traduzir = entradas.filter((t) => t.trim() !== "" && !semPalavras(t));
  const mapa = new Map<string, string>();

  const base =
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex` +
    `&sl=${options.from}&tl=${options.to}`;
  const lotes = loteDe([...new Set(traduzir)], base);
  const total = lotes.reduce((soma, lote) => soma + lote.length, 0);
  let feitos = 0;
  let detected: string | null = null;
  let usouReserva = false;

  for (const lote of lotes) {
    if (options.cancelled?.()) {
      return { ok: false, texts: [], detected, error: "cancelled" };
    }
    let resposta: { texts: string[]; detected: string | null } | null = null;
    try {
      resposta = await pedirGoogle(lote, options.from, options.to);
    } catch {
      resposta = null;
    }
    if (!resposta) {
      try {
        resposta = await pedirMyMemory(lote, options.from, options.to);
        usouReserva = true;
      } catch {
        resposta = null;
      }
    }
    if (!resposta) {
      return {
        ok: false,
        texts: [],
        detected,
        error: usouReserva ? "both-engines-failed" : "engine-failed",
      };
    }
    if (!detected) detected = resposta.detected;
    lote.forEach((original, i) => mapa.set(original, resposta!.texts[i]));
    feitos += lote.length;
    options.onProgress?.(feitos, total);
  }

  return {
    ok: true,
    texts: entradas.map((t) => mapa.get(t) ?? t),
    detected,
    error: null,
  };
}
