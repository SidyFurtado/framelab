/**
 * O `.srt` virando legenda animada na timeline.
 *
 * ── A forma do trabalho ───────────────────────────────────────────
 * Cada legenda é uma cópia própria do modelo — com o texto dela no
 * `definition.json` e um `capsuleID` só dela (ver prepare.ts). Não é
 * o modelo repetido por `overwrite` porque o texto não pode ser
 * escrito depois: no Premiere 26.5 o parâmetro simplesmente não
 * existe para o UXP. Então o modelo de origem é lido UMA vez e cada
 * peça custa um `definition.json` de alguns KB mais a cópia crua do
 * gráfico — 40 KB por legenda nos modelos BB.
 *
 * ── O respiro entre as peças ──────────────────────────────────────
 * `insertMogrtFromPath` volta na hora, mas a importação do gráfico
 * continua correndo dentro do Premiere. Medido na mão do editor: 164
 * inserções numa rajada fechada entraram todas e ficaram TODAS
 * deslinkadas — nenhum item de mídia chegou a ser criado, e o host
 * ficou a 100% de CPU até reiniciar. Uma peça por vez, com pausa,
 * linka.
 *
 * Então o laço agora: dá um passo, confere se a peça ganhou item de
 * projeto, e espera um tico antes da próxima. Três peças seguidas sem
 * item e ele DESISTE — 164 clipes quebrados é pior que 20 bons e uma
 * frase explicando.
 *
 * ── A ordem ───────────────────────────────────────────────────────
 * Cronológica, e cada peça é aparada ao fim da legenda dela ANTES da
 * próxima entrar: um modelo dura 5–10 s de fábrica, e duas peças de
 * 10 s a um segundo de distância brigariam pela mesma trilha.
 *
 * A primeira peça é a prova: se ela não entrar, o lote para ali, em
 * vez de tentar mais 39 vezes a mesma recusa.
 */
import type { premierepro, Project, VideoClipTrackItem } from "@adobe/premierepro";
import { describeError, getPremiere } from "../../bridge/premiere";
import { freeTrack, insertRefusal, resolveEditor, saveReport } from "./applyTitles";
import { cueSpan, type TimedCue } from "./cues";
import { loadTemplate, patchFor, prepareMogrt, type TextStyle } from "./prepare";
import { wait } from "../silence/workspace";

/**
 * Quanto esperar entre duas peças.
 *
 * Não é frescura: é o tempo que o Premiere usa para terminar a
 * importação que a peça anterior começou.
 */
const PACE_MS = 60;

/** A cada tantas peças, uma pausa maior — a fila do host esvazia. */
const BREATH_EVERY = 10;
const BREATH_MS = 300;

/**
 * O teto de peças por lote. Recusar é a única resposta honesta.
 *
 * ── O que aconteceu sem ele ───────────────────────────────────────
 * Com 164 legendas — uma cópia de `.mogrt` por legenda, cada uma um
 * capsule PRÓPRIO — o Premiere importou até certo ponto, pôs o resto
 * como MÍDIA OFFLINE e travou o preview. Ficou a 1% de CPU sem
 * responder: travado, não trabalhando. Com 13 e com 16 peças, as
 * mesmas rodadas deram tempos exatos e uma mídia para cada peça.
 *
 * Quarenta é medida com folga entre o que se viu funcionar (16) e o
 * que se viu matar (164) — não é um número que alguém calculou, é
 * onde eu paro de arriscar o editor de quem usa. O limite real desta
 * versão do Premiere ninguém sabe; enquanto não souber, quem decide é
 * a prudência.
 *
 * O teto SÓ existe porque a arquitetura é uma cópia por legenda, e
 * ela é assim porque o UXP do Premiere 26.5 não escreve texto num
 * mogrt que já está na timeline. Quando isso mudar (o 27 beta traz
 * `MogrtText`), o lote passa a ser um capsule só e este teto sai.
 */
export const MAX_PIECES = 40;

/*
 * ── Não existe mais verificação por peça, e isso é deliberado ─────
 * Houve três versões dela, e as três foram o ÚNICO defeito real do
 * lote: `getProjectItem()` num clipe de `.mogrt` não responde nesta
 * versão do Premiere — nem 60 ms depois de inserir, nem 1,2 s depois,
 * nem em handle recém-nascido. As três abortaram lotes que estavam
 * indo bem (3 de 60, 16 de 164, 13 de 164) enquanto a timeline tinha
 * as peças certas, com os tempos certos, e a bin do projeto tinha uma
 * mídia para cada uma.
 *
 * Medir o que não se sabe medir e agir sobre a medida é pior que não
 * medir. A conferência ficou onde ela é confiável: UMA contagem no
 * fim, relida do projeto (`countGraphicsBin`), que não depende de
 * handle nenhum e não interrompe nada.
 */

export interface CaptionRequest {
  readonly templatePath: string;
  readonly cues: readonly TimedCue[];
  /** Trilha de vídeo, base zero. -1 = a de cima que estiver livre. */
  readonly trackIndex: number;
  /** Fonte e corpo escolhidos no painel. Ausente = os do modelo. */
  readonly style?: TextStyle;
  /** Chamado a cada peça, para a barra do painel não ficar muda. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Deixa o painel desistir no meio do lote. */
  readonly cancelled?: () => boolean;
}

export interface CaptionResult {
  readonly ok: boolean;
  readonly message: string;
  /** Quantas legendas ficaram de pé na timeline. */
  readonly inserted: number;
  readonly report: string[];
}

function fail(message: string, report: string[], inserted = 0): CaptionResult {
  return { ok: false, message, inserted, report };
}

/**
 * Quantos itens existem na bin que o Premiere cria para os gráficos.
 *
 * Releitura do projeto, de propósito: é a única medida que não depende
 * de handle vivo. null quando a bin ainda não existe.
 */
async function countGraphicsBin(
  ppro: premierepro,
  project: Project
): Promise<number | null> {
  try {
    const root = await project.getRootItem();
    const items = (await root.getItems()) as unknown[];
    for (const item of items) {
      const name = (item as { name?: string }).name ?? "";
      if (!/motion graphics/i.test(name)) {
        continue;
      }
      const folder = ppro.FolderItem.cast(item as never) as unknown as {
        getItems?: () => Promise<unknown[]>;
      } | null;
      if (folder && typeof folder.getItems === "function") {
        return (await folder.getItems()).length;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function applyCaptions(request: CaptionRequest): Promise<CaptionResult> {
  const report: string[] = [];
  const result = await run(request, report);
  const path = await saveReport([
    `Framelab — Legendas Animadas · ${new Date().toISOString()}`,
    `RESULTADO: ${result.ok ? "ok" : result.message}`,
    `Legendas: ${result.inserted} de ${request.cues.length}`,
    "",
    ...report,
  ]);
  return {
    ...result,
    report: path ? [...report, "", `Relatório salvo em: ${path}`] : report,
  };
}

async function run(request: CaptionRequest, report: string[]): Promise<CaptionResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return fail("Premiere UXP indisponível neste build.", report);
  }
  if (!request.templatePath) {
    return fail("Escolha um modelo de legenda.", report);
  }
  if (request.cues.length === 0) {
    return fail("O arquivo não tem nenhuma legenda legível.", report);
  }
  if (request.cues.length > MAX_PIECES) {
    // O painel já manda em partes; esta guarda é para quem chamar a
    // função direto — e para o dia em que alguém aumentar o lote sem
    // ler o comentário de MAX_PIECES.
    return fail(
      `${request.cues.length} legendas de uma vez passa do que este caminho ` +
        `aguenta (${MAX_PIECES}): cada uma é um modelo importado, e acima disso ` +
        "o Premiere põe as mídias offline e trava o preview.",
      report
    );
  }

  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) {
      return fail("Nenhum projeto aberto.", report);
    }
    const sequence = await project.getActiveSequence();
    if (!sequence) {
      return fail("Abra uma sequência na timeline primeiro.", report);
    }
    const editor = resolveEditor(ppro, sequence);
    if (!editor || typeof editor.insertMogrtFromPath !== "function") {
      return fail("Esta versão do Premiere não insere modelo pelo painel.", report);
    }
    const trackCount = await sequence.getVideoTrackCount();
    if (!(trackCount > 0)) {
      return fail("A sequência não tem trilha de vídeo.", report);
    }

    // A medida de antes, para a de depois ter com o que comparar.
    const binBefore = await countGraphicsBin(ppro, project);
    const template = await loadTemplate(request.templatePath);
    report.push(`Modelo lido: ${template.name} (${Math.round(template.zip.length / 1024)} KB).`);

    const span = cueSpan(request.cues);
    report.push(
      `${request.cues.length} legendas, de ${span.start.toFixed(2)}s a ${span.end.toFixed(2)}s.`
    );
    // As primeiras peças com tempo e texto: é o que deixa conferir a
    // timeline contra o .srt sem abrir os dois lado a lado.
    for (const cue of request.cues.slice(0, 5)) {
      report.push(
        `  ${cue.start.toFixed(2)} → ${cue.end.toFixed(2)}  ${JSON.stringify(cue.text)}`
      );
    }

    // ── a trilha ───────────────────────────────────────────────
    let trackIndex: number;
    if (request.trackIndex >= 0) {
      trackIndex = Math.min(request.trackIndex, trackCount - 1);
      report.push(`Trilha escolhida à mão: V${trackIndex + 1}.`);
    } else {
      const free = await freeTrack(ppro, sequence, trackCount, span.start, span.end, report);
      trackIndex = free ?? trackCount;
      if (free === null) {
        report.push(`Sem trilha livre; tentando V${trackCount + 1}.`);
      }
    }

    // ── uma peça por legenda ───────────────────────────────────
    let placed = 0;
    let trimmed = 0;
    let bytes = 0;
    const failures: string[] = [];

    for (let index = 0; index < request.cues.length; index += 1) {
      if (request.cancelled?.()) {
        report.push(`Cancelado na peça ${index + 1}.`);
        break;
      }
      const cue = request.cues[index];
      const label = `${index + 1}/${request.cues.length}`;
      request.onProgress?.(index, request.cues.length);

      let prepared;
      try {
        prepared = await prepareMogrt(template, patchFor(cue.text, request.style));
      } catch (cause) {
        failures.push(`${label}: cópia falhou (${describeError(cause)})`);
        continue;
      }
      bytes += prepared.bytes;
      if (index === 0 && !prepared.textApplied) {
        return fail(
          "Esse modelo não tem controle de texto — não serve para legenda. Escolha outro.",
          report
        );
      }

      let inserted: unknown[] = [];
      let insertError = "";
      project.lockedAccess(() => {
        try {
          inserted = editor.insertMogrtFromPath(
            prepared.path,
            ppro.TickTime.createWithSeconds(cue.start),
            trackIndex,
            0
          ) as unknown[];
        } catch (cause) {
          insertError = describeError(cause);
        }
      });
      if (!Array.isArray(inserted) || inserted.length === 0) {
        const why = insertError ? ` (${insertError})` : "";
        if (index === 0) {
          report.push(`Primeira peça recusada${why}.`);
          return fail(insertRefusal(trackIndex, trackCount), report);
        }
        failures.push(`${label}: recusada${why}`);
        continue;
      }
      placed += 1;
      const clip = inserted[0] as VideoClipTrackItem;
      let ok = false;
      project.lockedAccess(() => {
        try {
          ok = project.executeTransaction((compound) => {
            compound.addAction(
              clip.createSetEndAction(ppro.TickTime.createWithSeconds(cue.end))
            );
          }, "Duração da legenda");
        } catch (cause) {
          failures.push(`${label}: duração recusada (${describeError(cause)})`);
        }
      });
      if (ok) {
        trimmed += 1;
      }

      // O respiro: é o tempo que o host usa para digerir a importação
      // que esta peça começou.
      await wait(PACE_MS);
      if ((index + 1) % BREATH_EVERY === 0) {
        await wait(BREATH_MS);
      }
    }
    request.onProgress?.(request.cues.length, request.cues.length);

    // A conferência, uma vez e no fim: relida do projeto. Se a bin não
    // tiver uma mídia por peça, é AQUI que se descobre — sem ter
    // interrompido nada por causa de um palpite.
    const inBin = await countGraphicsBin(ppro, project);
    if (inBin !== null) {
      report.push(
        `Itens na bin de Motion Graphics: ${inBin} (eram ${binBefore ?? "?"} antes).`
      );
      if (binBefore !== null && inBin - binBefore < placed) {
        report.push(
          `Atenção: entraram ${placed} peças e a bin cresceu ${inBin - binBefore}. ` +
            "As que não ganharam mídia aparecem deslinkadas na timeline."
        );
      }
    }

    report.push(
      `Peças: ${placed} inseridas, ${trimmed} aparadas, ${Math.round(bytes / 1024)} KB de cópias.`
    );
    for (const failure of failures) {
      report.push(`• ${failure}`);
    }

    if (placed === 0) {
      return fail("Nenhuma legenda entrou. O relatório abaixo diz por quê.", report);
    }
    const missing = request.cues.length - placed;
    const grew = binBefore !== null && inBin !== null ? inBin - binBefore : null;
    return {
      ok: true,
      message:
        `${placed} legendas animadas em V${trackIndex + 1}` +
        (missing > 0 ? ` (${missing} ficaram de fora — ver relatório)` : "") +
        (trimmed < placed ? ` · ${placed - trimmed} com a duração do modelo` : "") +
        (grew !== null && grew < placed
          ? ` · só ${grew} ganharam mídia: confira a timeline`
          : "") +
        ".",
      inserted: placed,
      report,
    };
  } catch (cause) {
    report.push(`Erro: ${describeError(cause)}`);
    return fail(describeError(cause), report);
  }
}
