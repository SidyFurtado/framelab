/**
 * De palavras soltas para legenda que dá para ler.
 *
 * ── Por que existe ─────────────────────────────────────────────────
 * A API do Premiere não permite criar faixa de legenda: `CaptionTrack`
 * só se lê. Então o caminho para a timeline é o SRT — importado no
 * projeto e arrastado para a sequência, que é como legenda entra em
 * qualquer lugar.
 *
 * Mas despejar a transcrição num SRT não dá legenda: dá texto correndo
 * na tela. As regras abaixo são as do ofício, e cada uma tem uma razão
 * que se sente ao assistir:
 *
 *   • Linha curta — o olho lê a linha inteira sem varrer a tela.
 *   • Poucas linhas — três já tapam a imagem.
 *   • Quebra na pontuação antes de quebrar por tamanho — cortar uma
 *     frase no meio da vírgula é pior que uma linha curta.
 *   • Quebra na pausa longa — se a pessoa parou de falar, a legenda
 *     para junto; senão o texto atravessa o corte de sentido.
 *   • Tempo de leitura — a legenda fica na tela pelo tempo de LER, não
 *     pelo tempo de FALAR. Fala rápida com legenda rápida é ilegível.
 *   • Nos quadros da sequência — legenda que entra no meio de um
 *     quadro pisca um quadro cedo ou tarde.
 *
 * ── Quem manda nos números ─────────────────────────────────────────
 * O editor. Todos os limites daqui são `SrtOptions`, escolhidos no
 * painel: é a mesma régua que o Premiere expõe em "Criar legendas"
 * (caracteres, linhas, duração mínima, intervalo em quadros), mais o
 * que ele não expõe e faz falta — teto de duração, velocidade de
 * leitura e a pausa que quebra a legenda.
 *
 * Tudo função pura sobre a transcrição: dá para provar sem host.
 */
import type { AdobeTranscript } from "./toAdobe";

export interface SrtOptions {
  /** Caracteres por linha. 42 é a medida de broadcast. */
  maxLineChars: number;
  /** Quantas linhas a legenda pode ter. */
  maxLines: number;
  /** Pausa NA FALA que encerra uma legenda, em segundos. */
  gapSeconds: number;
  /** Nada some da tela antes disso. */
  minCueSeconds: number;
  /** Nem acumula fala além disso, mesmo sem pausa. */
  maxCueSeconds: number;
  /**
   * Velocidade de leitura, em caracteres por segundo.
   *
   * A legenda fica na tela pelo menos `caracteres / readingCps`, ainda
   * que a fala tenha sido mais rápida — é o que separa legenda de
   * transcrição carimbada. 17 é a régua de streaming para adulto, 20 é
   * o teto usual; abaixo de 12 a legenda começa a atropelar o corte.
   * 0 desliga a regra.
   */
  readingCps: number;
  /**
   * Buraco entre uma legenda e a seguinte, em QUADROS.
   *
   * Em quadros e não em segundos porque é assim que o Premiere pede, e
   * porque um buraco menor que um quadro não existe na timeline.
   */
  gapFrames: number;
}

/**
 * A régua de broadcast — a que serve para quase tudo.
 */
export const SRT_DEFAULTS: SrtOptions = {
  maxLineChars: 42,
  maxLines: 2,
  gapSeconds: 0.7,
  minCueSeconds: 1.0,
  maxCueSeconds: 6.0,
  readingCps: 17,
  gapFrames: 2,
};

export interface SrtPreset {
  id: string;
  name: string;
  /** O que este conjunto assume, em uma frase. */
  note: string;
  options: SrtOptions;
}

/**
 * Três réguas, num eixo só: quanto texto fica na tela de cada vez.
 *
 * Na ordem em que aparecem — Vertical, Padrão, Cinema — a barra é uma
 * escala, do mais curto ao mais longo, e não três gostos soltos.
 *
 * Foram medidos contra transcrição real antes de virarem preset:
 * "Cinema" e "Padrão" começaram idênticos no resultado (mesmas 11
 * legendas, mesma linha máxima), o que é o mesmo que ter uma pastilha
 * a mais sem função. O que os separa agora é a medida da linha, que é
 * o que de fato muda a contagem de legendas.
 *
 * Mexer num controle sai do preset e vira "Personalizado" — o preset é
 * ponto de partida, não gaiola.
 */
export const SRT_PRESETS: readonly SrtPreset[] = [
  {
    id: "vertical",
    name: "Vertical",
    note:
      "Uma linha curta de cada vez, trocando rápido — Reels, TikTok e " +
      "Shorts, onde a legenda divide a tela com tudo.",
    options: {
      maxLineChars: 26,
      maxLines: 1,
      gapSeconds: 0.4,
      minCueSeconds: 0.7,
      maxCueSeconds: 3.0,
      readingCps: 20,
      gapFrames: 1,
    },
  },
  {
    id: "broadcast",
    name: "Padrão",
    note:
      "42 caracteres, 2 linhas, 17 car/s — a medida de TV e YouTube. " +
      "Serve para quase tudo.",
    options: { ...SRT_DEFAULTS },
  },
  {
    id: "cinema",
    name: "Cinema",
    note:
      "Linha mais longa e mais tempo na tela: entrevista e documentário, " +
      "onde legenda trocando o tempo todo cansa mais que texto denso.",
    options: {
      maxLineChars: 50,
      maxLines: 2,
      gapSeconds: 1.2,
      minCueSeconds: 0.85,
      maxCueSeconds: 7.0,
      readingCps: 20,
      gapFrames: 2,
    },
  },
];

/** O preset que estes números são, se forem algum. */
export function matchPreset(options: SrtOptions): string | null {
  const keys = Object.keys(SRT_DEFAULTS) as (keyof SrtOptions)[];
  for (const preset of SRT_PRESETS) {
    if (keys.every((key) => Math.abs(preset.options[key] - options[key]) < 0.001)) {
      return preset.id;
    }
  }
  return null;
}

/** Quando a sequência não disse o seu relógio, este é o de trabalho. */
const NOMINAL_FPS = 30;

/** Nenhuma legenda fica menos que isto na tela, custe o que custar. */
const FLOOR_SECONDS = 0.24;

interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

/** Termina frase — ponto de quebra preferido. */
const SENTENCE_END = /[.!?…]$/;
/** Pausa gramatical — quebra boa quando a legenda já está cheia. */
const CLAUSE_END = /[,;:]$/;

/** Quadros viram segundos no relógio da sequência. */
function frameSeconds(frames: number, fps: number): number {
  return frames / (fps > 0 ? fps : NOMINAL_FPS);
}

/**
 * Encosta o tempo no quadro mais próximo.
 *
 * Sem isto a legenda entra no meio de um quadro e o Premiere resolve o
 * empate arredondando — às vezes para trás, e um quadro de legenda
 * aparece antes da palavra.
 */
function snap(seconds: number, fps: number): number {
  return fps > 0 ? Math.round(seconds * fps) / fps : seconds;
}

/**
 * Agrupa as palavras em legendas.
 *
 * A decisão de fechar uma legenda vem, em ordem: fim de frase, pausa
 * longa, tempo cheio, texto cheio. A ordem importa — fechar por
 * tamanho quando havia um ponto final duas palavras adiante produz
 * legenda que termina no meio da ideia.
 *
 * `fps` é o relógio da sequência, para os quadros do intervalo e para
 * o alinhamento. 0 = desconhecido: as contas usam o relógio nominal e
 * nada é alinhado, que é melhor que alinhar na grade errada.
 */
export function buildCues(
  transcript: AdobeTranscript,
  options: SrtOptions = SRT_DEFAULTS,
  fps = 0
): Cue[] {
  const words: Word[] = [];
  for (const segment of transcript.segments) {
    for (const word of segment.words) {
      const text = word.text.trim();
      if (text) {
        words.push({ text, start: word.start, end: word.start + word.duration });
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  if (words.length === 0) {
    return [];
  }

  const capacity = Math.max(1, options.maxLineChars * options.maxLines);
  const cues: Cue[] = [];
  let current: Word[] = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const start = current[0].start;
    const spoken = current[current.length - 1].end;
    const lines = wrap(current.map((word) => word.text).join(" "), options);
    // O tempo de LER, não o de falar: numa fala apressada a legenda
    // ainda precisa ficar de pé o suficiente para o olho terminar.
    const chars = lines.join(" ").length;
    const toRead = options.readingCps > 0 ? chars / options.readingCps : 0;

    cues.push({
      start,
      end: Math.max(spoken, start + options.minCueSeconds, start + toRead),
      lines,
    });
    current = [];
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];

    /*
     * A medida é um teto, não uma sugestão.
     *
     * A palavra é medida ANTES de entrar: se estoura, começa a próxima
     * legenda. Aceitá-la e só então perceber o estouro era o que fazia
     * "24 caracteres por linha" produzir linhas de 36 — o editor pede
     * uma medida e recebe outra, sem explicação.
     *
     * Palavra maior que a medida inteira vira legenda sozinha: não há
     * onde mais colocá-la, e quebrar palavra é pior.
     */
    if (current.length > 0) {
      const grown =
        current.map((entry) => entry.text).join(" ").length + 1 + word.text.length;
      if (grown > capacity) {
        flush();
      }
    }
    current.push(word);

    const text = current.map((entry) => entry.text).join(" ");
    const next = words[index + 1];
    const elapsed = word.end - current[0].start;

    if (SENTENCE_END.test(word.text)) {
      flush();
      continue;
    }
    if (!next) {
      continue;
    }
    if (next.start - word.end >= options.gapSeconds) {
      flush();
      continue;
    }
    if (elapsed >= options.maxCueSeconds) {
      flush();
      continue;
    }
    // Quase cheia e a oração terminou: a vírgula é o lugar certo de
    // quebrar, e esperar encher fecharia no meio da oração seguinte.
    if (text.length >= capacity * 0.8 && CLAUSE_END.test(word.text)) {
      flush();
    }
  }
  flush();

  // ── o relógio, por último ────────────────────────────────────────
  // Alinhar antes de aparar reintroduziria a sobreposição que a apara
  // acabou de tirar; com o intervalo já em quadros, aparar depois
  // deixa tudo na grade e nada encostado.
  for (const cue of cues) {
    cue.start = snap(cue.start, fps);
    cue.end = snap(cue.end, fps);
  }

  // Nenhuma legenda invade a seguinte: sobreposição faz o player
  // mostrar as duas ou piscar.
  const gap = frameSeconds(Math.max(0, options.gapFrames), fps);
  for (let index = 0; index < cues.length - 1; index += 1) {
    const limit = cues[index + 1].start - gap;
    if (cues[index].end > limit) {
      cues[index].end = Math.max(cues[index].start + FLOOR_SECONDS, limit);
    }
  }

  return cues;
}

export interface CueStats {
  cues: number;
  /** A linha mais comprida que saiu. */
  longestLine: number;
  /**
   * Legendas que ficam MENOS tempo do que a leitura pediria.
   *
   * Acontece quando a fala é densa demais para os limites escolhidos:
   * a legenda seguinte chega antes de a anterior ter tempo. É o número
   * que diz ao editor para aumentar os caracteres ou baixar a
   * velocidade de leitura — sem ele, o ajuste é no escuro.
   */
  rushed: number;
  /** O pior caso de caracteres por segundo que o espectador enfrenta. */
  peakCps: number;
  /** Média de segundos na tela. */
  meanSeconds: number;
}

export function measureCues(cues: readonly Cue[], options: SrtOptions): CueStats {
  if (cues.length === 0) {
    return { cues: 0, longestLine: 0, rushed: 0, peakCps: 0, meanSeconds: 0 };
  }
  let longestLine = 0;
  let rushed = 0;
  let peakCps = 0;
  let total = 0;

  for (const cue of cues) {
    for (const line of cue.lines) {
      longestLine = Math.max(longestLine, line.length);
    }
    const seconds = Math.max(0.001, cue.end - cue.start);
    const chars = cue.lines.join(" ").length;
    const cps = chars / seconds;
    peakCps = Math.max(peakCps, cps);
    total += seconds;
    if (options.readingCps > 0 && cps > options.readingCps + 0.5) {
      rushed += 1;
    }
  }

  return {
    cues: cues.length,
    longestLine,
    rushed,
    peakCps,
    meanSeconds: total / cues.length,
  };
}

/**
 * Quebra o texto em linhas.
 *
 * Enche a linha até o limite e passa para a próxima. A ÚLTIMA linha
 * permitida leva o resto inteiro, custe o comprimento que custar:
 * cortar palavra fora da legenda é perder fala, e legenda que perde
 * fala não é legenda.
 *
 * Isto não era verdade enquanto `maxLines` valia sempre 2. Com o
 * controle na mão do editor, `maxLines: 1` caía no `slice` do fim e
 * jogava fora tudo depois da primeira linha — o preset Vertical
 * inteiro engolia texto em silêncio. Não há mais `slice`: o que entra
 * sai.
 */
export function wrap(text: string, options: SrtOptions): string[] {
  const limit = Math.max(1, options.maxLines);
  if (text.length <= options.maxLineChars) {
    return [text];
  }
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const candidate = line ? `${line} ${word}` : word;

    if (candidate.length > options.maxLineChars && line) {
      // O resto é pego pelo ÍNDICE do laço, nunca por `indexOf`: numa
      // frase com palavra repetida ("o que… o resto"), o `indexOf`
      // achava a primeira ocorrência e a linha engolia o texto todo —
      // era o que este teste pegou.
      if (lines.length === limit - 1) {
        return [...lines, [line, ...words.slice(index)].join(" ")];
      }
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

/**
 * `00:01:23,456` — o relógio do SRT, com vírgula nos milésimos.
 *
 * A conta é feita em milésimos INTEIROS desde o começo. Arredondando a
 * parte fracionária por último, um tempo como 2,9999995 s virava
 * `00:00:02,1000` — quatro dígitos onde cabem três, e o bloco inteiro
 * é descartado por qualquer leitor de SRT. Com o alinhamento por
 * quadro, tempos assim saem de dízimas como 1/29,97 o tempo todo.
 */
export function srtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

/** O arquivo .srt inteiro. */
export function toSrt(
  transcript: AdobeTranscript,
  options: SrtOptions = SRT_DEFAULTS,
  fps = 0
): string {
  return cuesToSrt(buildCues(transcript, options, fps));
}

export function cuesToSrt(cues: readonly Cue[]): string {
  return (
    cues
      .map(
        (cue, index) =>
          `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n` +
          cue.lines.join("\n")
      )
      // Linha em branco entre blocos é o separador do formato.
      .join("\n\n") + (cues.length > 0 ? "\n" : "")
  );
}
