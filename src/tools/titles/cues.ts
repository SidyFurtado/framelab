/**
 * O `.srt` virando tempo de timeline.
 *
 * O parser de blocos é o do Traduzir Legenda — ele já sabe do BOM, do
 * cabeçalho de WebVTT salvo como .srt e do `\r\n`, e reescrevê-lo aqui
 * seria manter dois parsers divergindo na primeira correção. O que
 * falta lá é o que esta ferramenta precisa: o relógio em SEGUNDOS, que
 * é a única forma que o Premiere entende.
 */
import { parseSrt } from "../translate/srtFile";
import { SRT_DEFAULTS, wrap } from "../captions/srt";

export interface TimedCue {
  /** Segundos desde o início da sequência. */
  readonly start: number;
  readonly end: number;
  /** O texto do bloco, com as linhas já juntas por quebra. */
  readonly text: string;
}

/**
 * Um carimbo de tempo em segundos.
 *
 * Aceita as duas grafias que aparecem na vida real: `00:00:01,500` do
 * .srt e `00:00:01.500` do .vtt, com ou sem a casa das horas — um
 * arquivo gerado por ferramenta web costuma vir como `00:01.500`.
 */
export function parseTimecode(value: string): number | null {
  const match = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*$/.exec(value);
  if (!match) {
    return null;
  }
  const [, hours, minutes, seconds, fraction] = match;
  // "5" depois da vírgula é meio segundo, não cinco milésimos.
  const millis = Number(fraction.padEnd(3, "0"));
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    millis / 1000
  );
}

/**
 * As legendas do arquivo, em ordem e sem as que não servem.
 *
 * Descarta em silêncio o bloco sem texto e o de relógio ilegível: um
 * .srt de produção tem sempre um ou outro, e parar o lote inteiro por
 * causa de um bloco vazio seria trocar 40 legendas por nenhuma.
 *
 * O fim é empurrado para pelo menos um décimo depois do início porque
 * legenda de duração zero vira clipe de zero quadro, que o Premiere
 * aceita e ninguém vê.
 */
export function cuesFromSrt(raw: string): TimedCue[] {
  const document = parseSrt(raw);
  const cues: TimedCue[] = [];

  for (const block of document.cues) {
    const [from, to] = block.timing.split("-->");
    if (!from || !to) {
      continue;
    }
    const start = parseTimecode(from);
    // O relógio de fim pode trazer posicionamento depois dele
    // ("... --> 00:00:03,000 line:90%"), que não é hora nenhuma.
    const end = parseTimecode(to.split(/\s{2,}|\t| line:| align:/)[0]);
    const text = block.lines.join("\n").trim();
    if (start === null || end === null || !text) {
      continue;
    }
    cues.push({ start, end: Math.max(end, start + 0.1), text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Duas legendas não podem ocupar o mesmo instante na mesma trilha.
 *
 * Um .srt legítimo às vezes encosta um bloco no outro — ou sobrepõe,
 * quando veio de transcrição automática. Na timeline isso não é um
 * detalhe: a segunda peça entra POR CIMA da primeira e come o fim
 * dela. Encurtar a anterior é o conserto que preserva as duas.
 */
export function withoutOverlap(cues: readonly TimedCue[]): TimedCue[] {
  const out: TimedCue[] = [];
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const next = cues[index + 1];
    const end = next ? Math.min(cue.end, next.start) : cue.end;
    // Sobreposição tão grande que não sobra nada: a legenda some, em
    // vez de virar um clipe de duração negativa.
    if (end > cue.start) {
      out.push({ ...cue, end });
    }
  }
  return out;
}

/** O trecho que o lote inteiro ocupa, para achar uma trilha livre. */
export function cueSpan(cues: readonly TimedCue[]): { start: number; end: number } {
  if (cues.length === 0) {
    return { start: 0, end: 0 };
  }
  return {
    start: cues[0].start,
    end: cues.reduce((last, cue) => Math.max(last, cue.end), 0),
  };
}

/**
 * Junta legendas vizinhas em frases maiores.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * Um `.srt` de transcrição automática vem picado: 164 blocos em 122
 * segundos, um a cada 0,75s. Cada bloco vira uma peça animada na
 * timeline, e 164 peças animadas foi o que fez o Premiere não dar
 * conta — os clipes entraram e ficaram deslinkados. Juntar três
 * blocos curtos numa frase corta o trabalho por três sem mudar o que
 * o espectador lê.
 *
 * ── As três barreiras ─────────────────────────────────────────────
 * Junta enquanto a frase couber em `maxSeconds` E em `maxChars`, e
 * PARA num silêncio maior que `maxGap`. A pausa é a mais importante
 * das três: ela é onde a fala respira, e juntar por cima dela faria a
 * legenda aparecer antes da pessoa falar.
 */
export function groupCues(
  cues: readonly TimedCue[],
  maxSeconds: number,
  // Três linhas de vinte e um. Medido no .srt real de 164 blocos:
  // com 42 (duas linhas) o lote só cai para 82 peças e as frases
  // quebram no meio; com 63 cai para 60, e a linha mais longa fica em
  // 24 caracteres — cabe na caixa e ainda lê como frase.
  maxChars = 63,
  maxGap = 0.7
): TimedCue[] {
  if (maxSeconds <= 0 || cues.length === 0) {
    return [...cues];
  }
  const out: TimedCue[] = [];
  let open: { start: number; end: number; text: string } | null = null;

  for (const cue of cues) {
    if (!open) {
      open = { start: cue.start, end: cue.end, text: cue.text };
      continue;
    }
    const oneLine = (value: string): string => value.replace(/\s*\r?\n\s*/g, " ");
    const joined = `${oneLine(open.text)} ${oneLine(cue.text)}`.trim();
    const fits =
      cue.end - open.start <= maxSeconds &&
      joined.length <= maxChars &&
      cue.start - open.end <= maxGap;
    if (fits) {
      open = { start: open.start, end: cue.end, text: joined };
    } else {
      out.push({ ...open });
      open = { start: cue.start, end: cue.end, text: cue.text };
    }
  }
  if (open) {
    out.push(open);
  }
  return out;
}

/**
 * Quebra cada legenda em no máximo duas linhas.
 *
 * ── Por que não deixar o modelo quebrar ───────────────────────────
 * Ele não quebra. Uma caixa de texto de `.mogrt` desenha a frase numa
 * linha só, e ao agrupar quatro blocos numa frase o resultado passou
 * de cinquenta caracteres — que num vertical de 1080 com corpo 64 sai
 * pela borda. Então a quebra é feita ANTES, aqui.
 *
 * A medida não é a de broadcast (42 por linha): aquela vale para
 * legenda pequena em 16:9. Legenda viral em 9:16 usa corpo grande, e
 * aí caber é por volta de vinte caracteres — daí o padrão baixo, que
 * o painel pode subir quando o modelo for mais estreito.
 *
 * `wrap` é o das Legendas, com os testes dele: uma segunda quebra de
 * linha nesta base divergiria da primeira na primeira correção.
 */
export function wrapCues(
  cues: readonly TimedCue[],
  maxLineChars = 21,
  maxLines = 3
): TimedCue[] {
  return cues.map((cue) => ({
    ...cue,
    text: wrap(cue.text.replace(/\s*\r?\n\s*/g, " "), {
      ...SRT_DEFAULTS,
      maxLineChars,
      maxLines,
    }).join("\n"),
  }));
}
