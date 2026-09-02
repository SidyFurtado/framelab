/**
 * O que os números viram na tela.
 *
 * Sem isto os controles são sete deslizadores sem consequência
 * visível: "42 caracteres" não diz nada até virar duas linhas de
 * texto. A prévia monta as legendas de verdade — as mesmas funções que
 * escrevem o .srt — e mostra as duas primeiras como o espectador as
 * veria, com o relógio e a contagem de caracteres ao lado.
 *
 * Antes da primeira transcrição a fonte é uma fala de demonstração,
 * para que a régua possa ser ajustada ANTES de esperar o motor. Depois
 * dela a fonte é a transcrição real, que é quando a prévia passa a
 * responder sobre o material do editor.
 */
import { escapeHtml } from "../../shell/controls";
import type { AdobeTranscript, AdobeWord } from "./toAdobe";
import type { Cue, CueStats, SrtOptions } from "./srt";

/**
 * Uma fala de demonstração com tempos plausíveis.
 *
 * A duração de cada palavra sai do seu tamanho, no ritmo de uma
 * narração normal — cerca de 2,7 palavras por segundo. Não é preciso
 * ser exato: serve para mostrar quebra de linha, fim de frase e a
 * pausa que encerra uma legenda, que é o que os controles mexem.
 */
const DEMO_SPEECH =
  "Então, olha só: o que a gente vai fazer hoje é bem simples. " +
  "Primeiro eu separo o áudio da entrevista, depois corto tudo que " +
  "não presta, e no final entra a trilha sonora. || Beleza?";

export function demoTranscript(): AdobeTranscript {
  const words: AdobeWord[] = [];
  let clock = 0.4;

  for (const token of DEMO_SPEECH.split(" ")) {
    // "||" marca a pausa longa — é o que faz a última frase virar
    // legenda própria, mostrando a regra da pausa funcionando.
    if (token === "||") {
      clock += 1.4;
      continue;
    }
    const duration = 0.09 + 0.055 * token.length;
    words.push({
      text: token,
      start: Number(clock.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      type: "word",
      confidence: 1,
      tags: [],
    });
    clock += duration + 0.045;
  }

  return { version: "1.0.0", segments: [{ start: 0, words }] };
}

/*
 * ── O corpo da prévia, medido e não chutado ────────────────────────
 *
 * Medido no navegador com o CSS de verdade e frases de legenda em
 * português (não "mmmm" nem "iiii"): Instrument Sans a 11px ocupa
 * 5,306px por caractere no pior caso, e a linha da prévia tem 234px
 * úteis. Ou seja, 11px comporta 42 caracteres — exatamente a medida de
 * fábrica, e nem um a mais.
 *
 * Por isso o preset Cinema (50 caracteres) e qualquer ajuste acima de
 * 42 apareciam truncados com reticências: a prévia mentia justamente
 * sobre o texto que o editor estava tentando ver. O corpo agora
 * encolhe para caber a linha inteira, como faria uma legenda num
 * quadro menor.
 */
const CAP_USABLE_PX = 234;
/** Largura de um caractere por pixel de corpo. 0,49 = os 5,306/11 medidos, com folga. */
const CAP_CHAR_RATIO = 0.49;

function captionFontPx(chars: number): number {
  const fits = CAP_USABLE_PX / (Math.max(1, chars) * CAP_CHAR_RATIO);
  // O piso é o ponto em que ainda se lê; o teto é o corpo de projeto.
  return Number(Math.min(11, Math.max(6.5, fits)).toFixed(2));
}

/** `2,4s` — o painel fala português, então a vírgula é decimal. */
function seconds(value: number): string {
  return `${value.toFixed(1).replace(".", ",")}s`;
}

/** `00:12,4` — relógio curto: hora completa não cabe e não importa aqui. */
function shortClock(value: number): string {
  const total = Math.max(0, value);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0").replace(".", ",")}`;
}

/**
 * As duas primeiras legendas, mais o que o conjunto todo virou.
 *
 * Duas e não uma porque o intervalo entre legendas só se vê no par; e
 * não mais que duas porque o painel tem 320px e a prévia não pode
 * empurrar os controles para fora da tela.
 */
export function previewMarkup(
  cues: readonly Cue[],
  stats: CueStats,
  options: SrtOptions,
  source: string
): string {
  if (cues.length === 0) {
    return (
      '<div class="cc-cap-preview">' +
      '<p class="cc-cap-empty">Estes limites não produzem nenhuma legenda.</p>' +
      "</div>"
    );
  }

  // A linha mais larga que a prévia precisa mostrar: o pedido do
  // editor, ou o que a regra da última linha produziu de fato — o que
  // for maior, senão a maior linha volta a ser cortada.
  const widest = Math.max(options.maxLineChars, stats.longestLine);

  const screens = cues
    .slice(0, 2)
    .map((cue) => {
      const lines = cue.lines
        .map(
          (line) =>
            '<span class="cc-cap-line">' +
            `<span class="cc-cap-text">${escapeHtml(line)}</span>` +
            `<span class="cc-cap-count">${line.length}</span>` +
            "</span>"
        )
        .join("");
      return (
        '<div class="cc-cap-screen">' +
        '<div class="cc-cap-clock">' +
        `<span>${shortClock(cue.start)}</span>` +
        `<span class="cc-cap-dur">${seconds(cue.end - cue.start)}</span>` +
        "</div>" +
        `<div class="cc-cap-lines">${lines}</div>` +
        "</div>"
      );
    })
    .join("");

  // O aviso é o único número que pede ação: legenda que sai antes de
  // dar tempo de ler é o defeito que estes controles existem para
  // evitar, e ele não se vê olhando uma legenda de cada vez.
  const warning =
    stats.rushed > 0
      ? '<p class="cc-cap-warn">' +
        `${stats.rushed} ${stats.rushed === 1 ? "legenda passa" : "legendas passam"} rápido demais ` +
        `para ${Math.round(options.readingCps)} car/s — aumente os caracteres por linha, ` +
        "ou baixe a velocidade de leitura.</p>"
      : "";

  return (
    `<div class="cc-cap-preview" style="--cc-cap-size:${captionFontPx(widest)}px">` +
    screens +
    '<div class="cc-cap-stats">' +
    `<span><b>${stats.cues}</b> ${stats.cues === 1 ? "legenda" : "legendas"}</span>` +
    `<span>linha máx <b>${stats.longestLine}</b></span>` +
    `<span>média <b>${seconds(stats.meanSeconds)}</b></span>` +
    "</div>" +
    warning +
    `<p class="cc-cap-source">${escapeHtml(source)}</p>` +
    "</div>"
  );
}
