/**
 * Ler e reescrever um .srt sem estragá-lo.
 *
 * ── O que este módulo protege ──────────────────────────────────────
 * O tempo. A ferramenta de tradução tem uma promessa só: os carimbos
 * saem do jeito que entraram, e só o texto muda. Por isso o bloco é
 * guardado com o seu TEXTO CRU do relógio — a linha `00:00:01,240 -->
 * 00:00:03,120` volta para o arquivo exatamente como veio, sem passar
 * por número nenhum. Converter para segundos e de volta introduziria
 * arredondamento onde não há necessidade de aritmética alguma.
 *
 * ── Os .srt do mundo real ──────────────────────────────────────────
 * Legenda vem de todo lado — YouTube, Whisper, CapCut, um tradutor que
 * o cliente usou — e quase nenhuma segue a especificação à risca:
 *
 *   • BOM no começo (o Notepad do Windows põe, e ele vira parte do
 *     número do primeiro bloco se ninguém tirar);
 *   • CRLF, LF, ou os dois misturados no mesmo arquivo;
 *   • ponto no lugar da vírgula nos milésimos (`00:00:01.240`);
 *   • coordenadas de posição depois do relógio (`X1:040 X2:600 …`),
 *     que alguns players usam e que não podem ser jogadas fora;
 *   • numeração fora de ordem, repetida, ou ausente;
 *   • WebVTT com cabeçalho `WEBVTT` salvo como .srt.
 *
 * Nada disso é motivo para recusar o arquivo. O que não for
 * reconhecido passa intacto.
 */

export interface SrtCue {
  /** O número como veio, para reescrever igual quando nada mudou. */
  index: number;
  /** A linha do relógio INTEIRA e CRUA, incluindo o que vier depois. */
  timing: string;
  /** As linhas de texto, já sem o relógio. */
  lines: string[];
}

export interface SrtDocument {
  cues: SrtCue[];
  /** `\r\n` ou `\n` — o arquivo volta com o que trouxe. */
  eol: string;
  /** Cabeçalho `WEBVTT` e afins, preservado. */
  header: string;
}

/** A linha do relógio: dois carimbos com uma seta no meio. */
const TIMING = /^\s*(-?\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,3}:\d{2}[,.]\d{1,3})\s*-->\s*/;

/**
 * Quantas linhas de texto e que largura este arquivo usa.
 *
 * A tradução é reembrulhada no estilo do PRÓPRIO arquivo: uma legenda
 * de TikTok com uma linha de 24 caracteres não deve voltar com duas de
 * 42 só porque 42 é a medida de broadcast.
 */
export interface SrtStyle {
  maxLineChars: number;
  maxLines: number;
}

export function measureStyle(doc: SrtDocument): SrtStyle {
  let widest = 0;
  let mostLines = 1;
  for (const cue of doc.cues) {
    mostLines = Math.max(mostLines, cue.lines.length);
    for (const line of cue.lines) {
      widest = Math.max(widest, line.length);
    }
  }
  return {
    // Presos a uma faixa utilizável: um arquivo de uma linha só com
    // 120 caracteres não vira régua, e um com duas palavras também não.
    maxLineChars: Math.min(56, Math.max(24, widest || 42)),
    maxLines: Math.min(3, Math.max(1, mostLines)),
  };
}

export function parseSrt(raw: string): SrtDocument {
  // O BOM entra silenciosamente no primeiro caractere e transforma o
  // "1" do primeiro bloco em algo que não é número.
  const text = raw.replace(/^﻿/, "");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const linhas = text.split(/\r\n|\r|\n/);

  const cues: SrtCue[] = [];
  const headerLines: string[] = [];
  let i = 0;

  // Cabeçalho de WebVTT salvo como .srt, e qualquer preâmbulo antes do
  // primeiro relógio.
  while (i < linhas.length && !TIMING.test(linhas[i])) {
    const olhaFrente = linhas[i + 1] !== undefined && TIMING.test(linhas[i + 1]);
    if (olhaFrente) break;
    headerLines.push(linhas[i]);
    i += 1;
  }
  // Um preâmbulo só de linhas vazias não é cabeçalho.
  const header = headerLines.join(eol).trim() ? headerLines.join(eol) : "";
  if (!header) i = 0;

  let seq = 0;
  while (i < linhas.length) {
    // O número do bloco é opcional; o relógio é o que ancora.
    let index = 0;
    if (!TIMING.test(linhas[i]) && /^\s*\d+\s*$/.test(linhas[i])) {
      index = Number.parseInt(linhas[i].trim(), 10);
      i += 1;
    }
    if (i >= linhas.length) break;
    if (!TIMING.test(linhas[i])) {
      i += 1;
      continue;
    }

    const timing = linhas[i].trim();
    i += 1;

    const corpo: string[] = [];
    while (i < linhas.length && linhas[i].trim() !== "" && !TIMING.test(linhas[i])) {
      // Um número solto seguido de relógio é o começo do PRÓXIMO bloco
      // num arquivo sem linha em branco entre eles.
      if (/^\s*\d+\s*$/.test(linhas[i]) && linhas[i + 1] && TIMING.test(linhas[i + 1])) {
        break;
      }
      corpo.push(linhas[i]);
      i += 1;
    }
    while (i < linhas.length && linhas[i].trim() === "") i += 1;

    seq += 1;
    cues.push({ index: index || seq, timing, lines: corpo });
  }

  return { cues, eol, header };
}

/**
 * De volta a arquivo.
 *
 * Renumera do 1 em diante: um .srt com numeração furada ou repetida na
 * entrada não deve sair furado, e o número é a única coisa aqui que
 * não carrega informação do editor.
 */
export function serializeSrt(doc: SrtDocument): string {
  const partes = doc.cues.map(
    (cue, ordem) =>
      `${ordem + 1}${doc.eol}${cue.timing}${doc.eol}${cue.lines.join(doc.eol)}`
  );
  const corpo = partes.join(doc.eol + doc.eol) + doc.eol;
  const cabeca = doc.header ? doc.header.trimEnd() + doc.eol + doc.eol : "";
  return cabeca + corpo;
}
