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

import { fetchWithTimeout, isNetCancelled, NET_DEADLINE } from "../../bridge/net";

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
  /**
   * Quantas falas foram traduzidas de fato.
   *
   * Opcional para não quebrar quem só olha `ok`/`texts`.
   */
  done?: number;
  /**
   * Quantas ficaram sem tradução. `> 0` com `ok: true` é o resultado
   * PARCIAL: o texto original ficou no lugar das que faltaram, e quem
   * mostra precisa dizer isso ao editor.
   */
  pending?: number;
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
    /*
     * Um bloco que sozinho não cabe na URL vai SOZINHO, e avisado.
     *
     * A guarda de tamanho só dispara com o lote já ocupado, então um
     * texto gigante entrava num lote vazio e passava — a URL estourava
     * o limite do servidor e o lote inteiro voltava vazio, sem erro
     * que apontasse a causa. Isolá-lo não conserta o bloco, mas impede
     * que ele derrube os vizinhos: os outros seguem traduzidos.
     */
    if (montarUrl(base, [texto]).length > maxUrl) {
      if (atual.length > 0) {
        lotes.push(atual);
        atual = [];
      }
      lotes.push([texto]);
      continue;
    }
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
  const resposta = await fetchWithTimeout(
    montarUrl(base, textos),
    { headers: { "User-Agent": UA } },
    NET_DEADLINE.translate
  );
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
/**
 * O que a reserva conseguiu antes de parar.
 *
 * ── Por que não é mais `null` ─────────────────────────────────────
 * O MyMemory traduz UMA fala por requisição, e o laço devolvia `null`
 * ao primeiro tropeço — jogando fora tudo que já tinha vindo. Num .srt
 * de centenas de legendas, um 429 na fala 200 (e o MyMemory limita
 * taxa, então 429 é esperado) apagava as 199 anteriores e ainda fazia
 * `translate` descartar os lotes já fechados pelo Google.
 *
 * Agora ela sempre devolve o que tem. Quem chama decide se isso é
 * resultado parcial ou falha.
 */
interface ReservaParcial {
  /** As traduções obtidas, na ORDEM dos textos pedidos. */
  texts: string[];
  detected: string | null;
  /** Quantos textos do lote ficaram sem tradução. */
  missing: number;
  /** Por que parou. `null` quando traduziu tudo. */
  cause: string | null;
  /** true quando o editor desistiu no meio. Não é falha. */
  cancelled: boolean;
}

function parouEm(
  texts: string[],
  pedidos: number,
  cause: string | null,
  cancelled = false
): ReservaParcial {
  return {
    texts,
    detected: null,
    missing: pedidos - texts.length,
    cause,
    cancelled,
  };
}

/**
 * A reserva, uma fala por vez. Serial de propósito: o MyMemory não
 * aceita lote, e pedir em paralelo só aproxima o limite de taxa.
 */
async function pedirMyMemory(
  textos: readonly string[],
  from: string,
  to: string,
  cancelled?: () => boolean
): Promise<ReservaParcial> {
  const par = `${from === "auto" ? "autodetect" : from}|${to}`;
  const saida: string[] = [];
  for (const texto of textos) {
    // Antes de abrir a próxima requisição.
    if (cancelled?.()) {
      return parouEm(saida, textos.length, null, true);
    }
    try {
      const url =
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texto)}` +
        `&langpair=${encodeURIComponent(par)}`;
      const resposta = await fetchWithTimeout(url, undefined, NET_DEADLINE.translate);
      if (!resposta.ok) {
        // 429 é o caso esperado num arquivo grande: limite de taxa.
        return parouEm(saida, textos.length, `MyMemory respondeu ${resposta.status}`);
      }
      const dados = (await resposta.json()) as {
        responseData?: { translatedText?: string };
        responseStatus?: number;
      };
      const traduzido = dados?.responseData?.translatedText;
      if (typeof traduzido !== "string") {
        return parouEm(saida, textos.length, "MyMemory respondeu sem tradução");
      }
      saida.push(traduzido);
    } catch (cause) {
      // Desistir não é falhar, e um prazo vencido não é uma desistência.
      if (isNetCancelled(cause)) {
        return parouEm(saida, textos.length, null, true);
      }
      return parouEm(saida, textos.length, descreve(cause));
    }
    // Depois da resposta, antes de seguir para a próxima fala.
    if (cancelled?.()) {
      return parouEm(saida, textos.length, null, true);
    }
  }
  return { texts: saida, detected: null, missing: 0, cause: null, cancelled: false };
}

function descreve(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

  /** O que a reserva reclamou por último, para o diagnóstico. */
  let ultimaCausa: string | null = null;
  /** true quando o motor caiu e não vale insistir nos lotes seguintes. */
  let parou = false;

  /** O que já está traduzido, alinhado com as entradas. */
  const alinhar = (): string[] => entradas.map((t) => mapa.get(t) ?? t);
  const cancelado = (): TranslateResult => ({
    ok: false,
    texts: [],
    detected,
    error: "cancelled",
    done: mapa.size,
    pending: total - mapa.size,
  });

  for (const lote of lotes) {
    if (options.cancelled?.()) {
      return cancelado();
    }
    let resposta: { texts: string[]; detected: string | null } | null = null;
    try {
      resposta = await pedirGoogle(lote, options.from, options.to);
    } catch {
      resposta = null;
    }

    if (!resposta) {
      usouReserva = true;
      const reserva = await pedirMyMemory(
        lote,
        options.from,
        options.to,
        options.cancelled
      );
      /*
       * O que veio, FICA — mesmo que a reserva tenha parado no meio.
       * O índice é posicional e a reserva empilha em ordem, parando na
       * primeira falha, então `texts[i]` é sempre a tradução de
       * `lote[i]`: nenhuma tradução escorrega para a fala seguinte.
       */
      reserva.texts.forEach((texto, i) => mapa.set(lote[i], texto));
      feitos += reserva.texts.length;
      options.onProgress?.(feitos, total);

      if (reserva.cancelled) {
        return cancelado();
      }
      if (reserva.missing > 0) {
        /*
         * Não segue para os próximos lotes. Um 429 é limite de taxa:
         * continuar pedindo só afunda mais, e o que já veio está salvo.
         */
        ultimaCausa = reserva.cause;
        parou = true;
        break;
      }
      continue;
    }

    if (!detected) detected = resposta.detected;
    lote.forEach((original, i) => mapa.set(original, resposta!.texts[i]));
    feitos += lote.length;
    options.onProgress?.(feitos, total);
  }

  const pending = total - mapa.size;

  /*
   * Zero traduções é falha total, como sempre foi — chamar de "parcial"
   * o que não traduziu nada seria entregar o arquivo original com cara
   * de tradução.
   */
  if (parou && mapa.size === 0) {
    return {
      ok: false,
      texts: [],
      detected,
      error: usouReserva ? "both-engines-failed" : "engine-failed",
      done: 0,
      pending: total,
    };
  }

  /*
   * Com progresso útil, o que foi traduzido VOLTA. As falas que
   * faltaram ficam com o texto original — o mesmo que já acontecia com
   * as falas sem letra — e `pending` diz quantas são, para quem mostra
   * poder avisar em vez de entregar meia tradução em silêncio.
   */
  if (parou) {
    console.warn(
      `[Traduzir] parcial: ${mapa.size} de ${total} falas · ${ultimaCausa ?? "sem causa"}`
    );
  }

  return {
    ok: true,
    texts: alinhar(),
    detected,
    error: null,
    done: mapa.size,
    pending,
  };
}
