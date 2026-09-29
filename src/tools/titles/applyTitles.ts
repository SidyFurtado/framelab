/**
 * Texto animado na timeline — o lado que fala com o Premiere.
 *
 * ── Por que um modelo, e não um texto desenhado pelo painel ────────
 * O UXP do Premiere não cria camada de texto. A API tem componente,
 * parâmetro, keyframe e ação — tudo para MEXER no que existe — e uma
 * única porta para pôr texto novo na timeline: `insertMogrtFromPath`,
 * que solta um Motion Graphics Template numa trilha.
 *
 * ── Por que o texto entra pelo ARQUIVO, e não por parâmetro ───────
 * No Premiere 26.5 os controles do Essential Graphics não aparecem na
 * cadeia de componentes do clipe (só Opacity e Motion), e
 * `getMGTComponent` não existe no runtime — medido num projeto real,
 * relatório em disco. O 27 beta anuncia `MogrtText` para isso; até
 * chegar, o caminho que o host SEMPRE respeita é o que está dentro
 * do `.mogrt`: o painel gera uma cópia do modelo com a frase, a fonte
 * e o corpo já no `definition.json` (ver prepare.ts) e insere a cópia.
 * O clipe nasce certo; nada precisa ser escrito nele depois.
 */
import type { premierepro, Sequence, SequenceEditor, VideoClipTrackItem } from "@adobe/premierepro";
import {
  collectSelectedVideoClips,
  describeError,
  getPremiere,
} from "../../bridge/premiere";
import { nativePath, workspace, write } from "../silence/workspace";
import { loadTemplate, patchFor, prepareMogrt, type TextStyle } from "./prepare";

export type { TextStyle } from "./prepare";

export interface TitleRequest {
  /** Caminho nativo do `.mogrt`. */
  readonly templatePath: string;
  readonly text: string;
  /** Trilha de vídeo, base zero. -1 = a de cima que estiver livre. */
  readonly trackIndex: number;
  /** Segundos. 0 mantém a duração de fábrica do modelo. */
  readonly durationSeconds: number;
  /** true insere na agulha; false, no início do primeiro clipe selecionado. */
  readonly atPlayhead: boolean;
  /** Fonte e corpo escolhidos no painel. Ausente = os do modelo. */
  readonly style?: TextStyle;
}

export interface TitleResult {
  readonly ok: boolean;
  readonly message: string;
  /** O que o host respondeu, linha a linha. Sempre preenchido. */
  readonly report: string[];
}

function fail(message: string, report: string[] = []): TitleResult {
  return { ok: false, message, report };
}

/**
 * O relatório vai para DISCO, além da tela.
 *
 * A lição é do Zoom: o console do UXP mora dentro do Premiere, e
 * chegar até ele custa pedir a alguém que abra, copie e cole. Em
 * arquivo, quem for consertar lê direto — e o painel ainda diz na
 * tela onde o arquivo está.
 */
const REPORT_FILE = "titles-report.txt";

export async function saveReport(lines: readonly string[]): Promise<string | null> {
  try {
    const space = await workspace();
    await write(space, REPORT_FILE, lines.join("\n") + "\n");
    return nativePath(space, REPORT_FILE);
  } catch (cause) {
    console.warn("[Textos] não consegui gravar o relatório:", cause);
    return null;
  }
}

/**
 * O editor da sequência.
 *
 * Duas grafias porque builds do Premiere divergiram no nome — a mesma
 * precaução que o Corte de Silêncios já tomava.
 */
export function resolveEditor(ppro: premierepro, sequence: Sequence): SequenceEditor | null {
  const api = ppro.SequenceEditor as unknown as {
    getEditor?: (sequence: Sequence) => SequenceEditor;
    createForSequence?: (sequence: Sequence) => SequenceEditor;
  };
  try {
    if (typeof api?.getEditor === "function") {
      return api.getEditor(sequence) ?? null;
    }
    if (typeof api?.createForSequence === "function") {
      return api.createForSequence(sequence) ?? null;
    }
  } catch (cause) {
    console.error("[Textos] SequenceEditor indisponível:", cause);
  }
  return null;
}

/**
 * Onde o título começa.
 *
 * A agulha é o padrão porque é onde o editor está olhando. A outra
 * opção existe para o uso que apareceu primeiro: o editor seleciona o
 * clipe que quer legendar e quer o texto COMEÇANDO com ele — alinhar
 * isso à mão é o tipo de precisão que a máquina faz melhor.
 *
 * Sem seleção, cai na agulha em vez de recusar: é o que o editor
 * esperaria de um botão que ele acabou de apertar.
 */
async function insertionPoint(
  ppro: premierepro,
  sequence: Sequence,
  request: TitleRequest
): Promise<number> {
  const playhead = async (): Promise<number> =>
    (await sequence.getPlayerPosition().catch(() => null))?.seconds ?? 0;

  if (request.atPlayhead) {
    return playhead();
  }
  const selected = await collectSelectedVideoClips(ppro, sequence).catch(() => []);
  const starts: number[] = [];
  for (const ref of selected) {
    const start = await ref.clip.getStartTime?.().catch(() => null);
    if (start && Number.isFinite(start.seconds)) {
      starts.push(start.seconds);
    }
  }
  return starts.length > 0 ? Math.min(...starts) : playhead();
}

/**
 * A trilha onde o título NÃO cobre nada.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * A primeira versão largava o título na trilha escolhida e pronto —
 * e numa trilha ocupada isso é jogar texto em cima de vídeo, que é o
 * oposto do que qualquer editor quer. Livre aqui quer dizer livre NO
 * TRECHO: uma trilha com clipes longe dali continua servindo, e
 * exigir trilha vazia inteira mandaria criar trilha à toa numa
 * sequência cheia.
 *
 * Procura do topo para baixo porque título mora em cima. Devolve
 * null quando não há nenhuma livre — quem chama decide o que fazer.
 */
export async function freeTrack(
  ppro: premierepro,
  sequence: Sequence,
  trackCount: number,
  startSeconds: number,
  endSeconds: number,
  report: string[]
): Promise<number | null> {
  for (let index = trackCount - 1; index >= 0; index -= 1) {
    const track = await sequence.getVideoTrack(index).catch(() => null);
    if (!track) {
      continue;
    }
    // O typings desta versão não promete `isLocked`, e builds a
    // expuseram. Trilha travada recusa a inserção sem explicar, então
    // pular é melhor que tentar — quando o método existir.
    const locked = (track as { isLocked?: () => Promise<boolean> }).isLocked;
    if (typeof locked === "function" && (await locked.call(track).catch(() => false))) {
      report.push(`V${index + 1}: travada.`);
      continue;
    }
    let items: Awaited<ReturnType<typeof track.getTrackItems>> = [];
    try {
      items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    } catch (cause) {
      report.push(`V${index + 1}: não deu para ler (${describeError(cause)}).`);
      continue;
    }
    const spans = await Promise.all(
      items.map(async (item) => {
        const from = await item.getStartTime().catch(() => null);
        const to = await item.getEndTime().catch(() => null);
        return from && to ? { from: from.seconds, to: to.seconds } : null;
      })
    );
    // Toca no trecho? `>` e `<` e não `>=`: um clipe que termina
    // exatamente onde o título começa é vizinho, não sobreposição.
    const busy = spans.some(
      (span) => span && span.from < endSeconds && span.to > startSeconds
    );
    if (!busy) {
      report.push(`V${index + 1}: livre no trecho — é ela.`);
      return index;
    }
    report.push(`V${index + 1}: ocupada no trecho.`);
  }
  return null;
}

/** A frase que explica uma inserção recusada, conforme onde ela foi tentada. */
export function insertRefusal(trackIndex: number, trackCount: number): string {
  return trackIndex >= trackCount
    ? "Não há trilha de vídeo livre neste trecho e o Premiere não criou " +
        "uma. No Premiere, clique com o botão direito no cabeçalho das " +
        "trilhas → Adicionar trilha, e tente de novo."
    : "O Premiere não inseriu o modelo. Confira se o After Effects está " +
        "instalado (os modelos são dele) e se a trilha está destravada.";
}

/**
 * Insere o modelo e devolve o que aconteceu.
 *
 * A cópia com o texto é gerada ANTES de tocar na timeline: se o modelo
 * não puder ser lido, nada entra e a mensagem diz por quê. A duração
 * vem por último, em transação própria — o título já está lá quando
 * ela roda, e uma recusa ali não desfaz a inserção.
 */
export async function applyTitle(request: TitleRequest): Promise<TitleResult> {
  const report: string[] = [];
  const result = await run(request, report);
  const path = await saveReport([
    `Framelab — Textos Animados · ${new Date().toISOString()}`,
    result.ok ? "RESULTADO: ok" : `RESULTADO: ${result.message}`,
    "",
    ...report,
  ]);
  return {
    ...result,
    report: path ? [...report, "", `Relatório salvo em: ${path}`] : report,
  };
}

async function run(request: TitleRequest, report: string[]): Promise<TitleResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return fail("Premiere UXP indisponível neste build.");
  }
  if (!request.templatePath) {
    return fail("Escolha um modelo de texto.");
  }

  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) {
      return fail("Nenhum projeto aberto.");
    }
    const sequence = await project.getActiveSequence();
    if (!sequence) {
      return fail("Abra uma sequência na timeline primeiro.");
    }
    const editor = resolveEditor(ppro, sequence);
    if (!editor || typeof editor.insertMogrtFromPath !== "function") {
      return fail(
        "Esta versão do Premiere não aceita inserir modelo (.mogrt) pelo painel."
      );
    }
    const trackCount = await sequence.getVideoTrackCount();
    if (!(trackCount > 0)) {
      return fail("A sequência não tem trilha de vídeo.");
    }

    // ── a cópia com o texto ────────────────────────────────────
    const text = request.text.trim();
    let mogrtPath = request.templatePath;
    if (text) {
      const template = await loadTemplate(request.templatePath);
      const prepared = await prepareMogrt(template, patchFor(text, request.style));
      report.push(
        `Cópia gerada: "${prepared.capsuleName}" (${Math.round(prepared.bytes / 1024)} KB) ` +
          `em ${prepared.path}`
      );
      report.push(
        `texto: ${prepared.textApplied ? "trocado" : "o modelo não expõe controle de texto"}` +
          ` · campos: ${prepared.textFields}` +
          (prepared.textFields > 1
            ? ` [${prepared.parts.map((part) => JSON.stringify(part)).join(", ")}]`
            : "") +
          (request.style?.font ? ` · fonte: ${prepared.fontApplied ? "trocada" : "não aceita"}` : "")
      );
      if (!prepared.textApplied) {
        return fail(
          "Esse modelo não tem controle de texto — não dá para escrever nele. " +
            "Escolha outro.",
          report
        );
      }
      mogrtPath = prepared.path;
    }

    // ── onde e em que trilha ───────────────────────────────────
    const startSeconds = Math.max(0, await insertionPoint(ppro, sequence, request));
    const start = ppro.TickTime.createWithSeconds(startSeconds);
    // Sem duração pedida, reserva o que um título costuma durar — o
    // modelo pode ser mais curto, e sobrar é melhor que atropelar.
    const span = request.durationSeconds > 0 ? request.durationSeconds : 5;

    let trackIndex: number;
    if (request.trackIndex >= 0) {
      trackIndex = Math.min(request.trackIndex, trackCount - 1);
      report.push(`Trilha escolhida à mão: V${trackIndex + 1}.`);
    } else {
      const free = await freeTrack(ppro, sequence, trackCount, startSeconds, startSeconds + span, report);
      trackIndex = free ?? trackCount;
      if (free === null) {
        report.push(`Nenhuma trilha livre no trecho; tentando V${trackCount + 1} (acima do topo).`);
      }
    }
    report.push(`Inserindo em V${trackIndex + 1}, aos ${startSeconds.toFixed(2)}s.`);

    // O insert NÃO é uma Action: ele age no host na hora, e por isso
    // corre sob `lockedAccess` sozinho, sem transação em volta.
    let inserted: unknown[] = [];
    let insertError = "";
    project.lockedAccess(() => {
      try {
        inserted = editor.insertMogrtFromPath(mogrtPath, start, trackIndex, 0) as unknown[];
      } catch (cause) {
        insertError = describeError(cause);
      }
    });
    if (insertError) {
      report.push(`insertMogrtFromPath: ${insertError}`);
    }
    if (!Array.isArray(inserted) || inserted.length === 0) {
      return fail(insertRefusal(trackIndex, trackCount), report);
    }
    report.push(`O host devolveu ${inserted.length} item(ns).`);
    const clip = inserted[0] as VideoClipTrackItem;

    // ── a duração ──────────────────────────────────────────────
    let trimmed = true;
    if (request.durationSeconds > 0) {
      const end = ppro.TickTime.createWithSeconds(startSeconds + request.durationSeconds);
      project.lockedAccess(() => {
        try {
          trimmed = project.executeTransaction((compound) => {
            compound.addAction(clip.createSetEndAction(end));
          }, "Duração do título");
        } catch (cause) {
          trimmed = false;
          report.push(`Duração recusada: ${describeError(cause)}`);
        }
      });
      report.push(
        trimmed
          ? `Duração ajustada para ${request.durationSeconds}s.`
          : "Duração ficou a do modelo."
      );
    }

    return {
      ok: true,
      message: text
        ? `Título em V${trackIndex + 1}${trimmed ? "" : " (duração do modelo)"}.`
        : `Modelo em V${trackIndex + 1} com o texto de fábrica.`,
      report,
    };
  } catch (cause) {
    report.push(`Erro: ${describeError(cause)}`);
    return fail(describeError(cause), report);
  }
}
