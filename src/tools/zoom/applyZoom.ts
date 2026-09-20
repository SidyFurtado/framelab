/**
 * Zoom In / Out — timeline logic.
 *
 * For every selected video clip a NEW `Transform` effect instance is appended
 * to the clip's video component chain and its Scale is keyframed across the
 * clip's visible range. The clip's intrinsic `Motion` (Scale, Position, Anchor
 * Point and any keyframes the editor already made) is never touched.
 */
import type {
  Component,
  ComponentParam,
  premierepro,
  TickTime,
  VideoComponentChain,
  VideoFilterComponent,
} from "@adobe/premierepro";
import {
  collectSelectedVideoClips,
  describeError,
  getPremiere,
  readTicksPerFrame,
  snapTicksToFrame,
} from "../../bridge/premiere";
import { dumpDiag, findComponent, numberOf, probeKeyframes, probeParams } from "./diag";

export type ZoomDirection = "in" | "out";

/**
 * `full` spans the whole visible clip at the parameter's default interpolation.
 * `punch` is a short accent at the head of the clip that eases out hard.
 */
export type ZoomStyle = "full" | "punch";

export interface ZoomOptions {
  direction: ZoomDirection;
  style: ZoomStyle;
  /** Scale target in percent, relative to the framing the clip already has. */
  scalePercent: number;
  /** Punch Smooth duration in seconds. Ignored when style is "full". */
  punchDuration: number;
  /** The speed curve to bake. Progress 0..1 in, eased progress out. */
  ease: (t: number) => number;
}

export interface ZoomResult {
  ok: boolean;
  message: string;
}

export const SCALE_MIN = 105;
export const SCALE_MAX = 150;

export const SCALE_DEFAULTS: Record<ZoomStyle, number> = {
  full: 115,
  punch: 120,
};

export const PUNCH_DURATION_MIN = 0.4;
export const PUNCH_DURATION_MAX = 4.0;
export const PUNCH_DURATION_DEFAULT = 1.6;
export const PUNCH_DURATION_PRESETS = [0.8, 1.2, 1.6, 2.0];

/**
 * How many keyframes a curved zoom lays down between its two ends.
 *
 * Sampled evenly in time rather than at even progress: even-progress
 * spacing cannot represent a curve that overshoots, and every drawn
 * curve can. Frame snapping caps this from below on short punches.
 */
const CURVE_KEYS = 8;

/**
 * Liga o dump completo dos parâmetros do Transform no console.
 *
 * Desligado porque custa uma ida e volta ao host por parâmetro e por
 * clipe. Ligue à mão quando um Scale não for encontrado numa build
 * nova do Premiere — é para isso que o dump existe.
 */
const DUMP_PARAMS = false;

/** Transform's Scale at 100% leaves the incoming image exactly as it was. */
const NEUTRAL_SCALE = 100;

/**
 * Candidate matchNames for the Transform video filter. One of these must be
 * present in `VideoFilterFactory.getMatchNames()` — nothing is assumed.
 */
const TRANSFORM_MATCH_NAMES = ["AE.ADBE Geometry2", "ADBE Geometry2"];

/** `ComponentParam` exposes no matchName, only a localized display name. */
const SCALE_PARAM_NAMES = new Set([
  "scale",
  "scale (zoom)",
  "escala",
  "escala (zoom)",
  "échelle",
  "echelle",
  "skalierung",
  "scala",
  "schaal",
  "skala",
  "масштаб",
  "スケール",
  "缩放",
  "縮放",
  "비율",
]);

export async function applyZoom(options: ZoomOptions): Promise<ZoomResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return fail("Premiere UXP runtime unavailable.");
  }

  /**
   * Takes the appended Transforms back out.
   *
   * The insert and the keyframes are two transactions, and the second one
   * failing left an inert Transform on every selected clip — one more per
   * attempt, for the editor to find and delete by hand. Assigned once the
   * first transaction has actually committed, so the catch below can undo
   * it too.
   */
  let rollbackAppends: (() => void) | null = null;

  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) {
      return fail("No active project.");
    }

    const sequence = await project.getActiveSequence();
    if (!sequence) {
      return fail("Open a sequence in the timeline first.");
    }

    const videoClips = await collectSelectedVideoClips(ppro, sequence);
    if (videoClips.length === 0) {
      return fail("Nenhum clipe de vídeo selecionado na timeline.");
    }
    const ticksPerFrame = await readTicksPerFrame(sequence);

    const { matchName: transformMatchName, candidates } =
      await resolveTransformMatchName(ppro);
    if (!transformMatchName) {
      return fail(
        `Transform effect not found in Premiere VideoFilterFactory. Relevant candidates: ${
          candidates.length > 0 ? candidates.join(", ") : "none"
        }`
      );
    }

    console.log(`[Zoom] Using Transform matchName: "${transformMatchName}"`);

    interface ClipTarget {
      /** Stable identity, so the clip can be found again after a commit. */
      clipKey: string;
      chain: VideoComponentChain;
      newComponent: VideoFilterComponent;
      /** Chain length before the append — where the new component lands. */
      appendIndex: number;
      startTicks: string;
      endTicks: string;
      /** O MESMO clipe em tempo de sequência — só para o relatório. */
      seqStartTicks: string;
      seqEndTicks: string;
    }

    const targets: ClipTarget[] = [];
    let speedSkipped = 0;

    for (const ref of videoClips) {
      const clip = ref.clip;
      const chain = await clip.getComponentChain();
      if (!chain) {
        continue;
      }

      // Speed changes break the arithmetic the same way they break the
      // silence cut: a second of source stops being a second of sequence,
      // so a punch of "1.6s" runs for 0.8s on a clip at 200%. The Silence
      // Tool has always refused these; this one used to cut them crooked.
      const speed = await Promise.resolve(clip.getSpeed()).catch(() => 1);
      if (Number.isFinite(speed) && Math.abs(speed - 1) > 0.001) {
        speedSkipped += 1;
        continue;
      }

      const inPoint = await clip.getInPoint();
      const outPoint = await clip.getOutPoint();
      if (!inPoint || !outPoint || !(outPoint.seconds > inPoint.seconds)) {
        continue;
      }

      /*
       * Os dois relógios do clipe, lado a lado.
       *
       * `getInPoint`/`getOutPoint` respondem em tempo de MÍDIA — é o
       * que o resto do plugin chama de `sourceStart`/`sourceEnd`.
       * `getStartTime`/`getEndTime` respondem em tempo de SEQUÊNCIA.
       * Os keyframes vão nos ticks do in/out, e até agora ninguém
       * mediu se é nesse relógio que o host os lê. Num clipe intocado
       * no começo da timeline os dois marcam zero e a diferença não
       * aparece — que é exatamente o caso que foi testado.
       */
      const seqStart = await Promise.resolve(clip.getStartTime()).catch(() => null);
      const seqEnd = await Promise.resolve(clip.getEndTime()).catch(() => null);

      const newComponent = await ppro.VideoFilterFactory.createComponent(
        transformMatchName
      );
      if (!newComponent) {
        continue;
      }

      // An append lands at the end, so the index it will occupy is the
      // length now. Reading it back by index beats guessing "the last
      // one", which happily returned somebody else's effect.
      const appendIndex = await Promise.resolve(chain.getComponentCount());

      // Full Clip runs edge to edge; Punch Smooth is a short accent at the
      // head, clamped so it can never run past the clip.
      const punchSec = Math.max(
        PUNCH_DURATION_MIN,
        Math.min(PUNCH_DURATION_MAX, options.punchDuration)
      );
      const endTime =
        options.style === "punch"
          ? ppro.TickTime.createWithSeconds(
              Math.min(inPoint.seconds + punchSec, outPoint.seconds)
            )
          : outPoint;

      targets.push({
        clipKey: ref.key,
        chain,
        newComponent,
        appendIndex,
        startTicks: inPoint.ticks,
        endTicks: endTime.ticks,
        seqStartTicks: seqStart ? seqStart.ticks : "(ilegível)",
        seqEndTicks: seqEnd ? seqEnd.ticks : "(ilegível)",
      });
    }

    if (targets.length === 0) {
      return fail(
        speedSkipped > 0
          ? `Nenhum clipe elegível: ${speedSkipped} com velocidade alterada. ` +
            "O Zoom precisa de clipes com velocidade a 100% para o tempo do punch bater."
          : "Nenhum clipe selecionado aceitou um efeito Transform."
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Transaction 1: Insert Transform component into each clip's chain
    // ─────────────────────────────────────────────────────────────────────────
    let insertCommitted = false;
    project.lockedAccess(() => {
      insertCommitted = project.executeTransaction((compoundAction) => {
        for (const target of targets) {
          const action = target.chain.createAppendComponentAction(
            target.newComponent
          );
          compoundAction.addAction(action);
        }
      }, "Adicionar efeito Transform");
    });

    if (!insertCommitted) {
      return fail("O Premiere recusou a inserção do efeito Transform.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // After insertion: locate Scale param on the committed Transform
    // ─────────────────────────────────────────────────────────────────────────
    interface ReadyScaleItem {
      chain: VideoComponentChain;
      scaleParam: ComponentParam;
      startTicks: string;
      endTicks: string;
    }

    const readyScaleItems: ReadyScaleItem[] = [];
    /** Every Transform the append actually landed, so it can be undone. */
    const appended: Array<{ chain: VideoComponentChain; component: Component }> = [];

    rollbackAppends = (): void => {
      if (appended.length === 0) {
        return;
      }
      try {
        project.lockedAccess(() => {
          project.executeTransaction((compoundAction) => {
            for (const entry of appended) {
              compoundAction.addAction(
                entry.chain.createRemoveComponentAction(entry.component)
              );
            }
          }, "Remover efeito Transform");
        });
      } catch (cause) {
        console.error("[Zoom] não foi possível remover os Transform inseridos:", cause);
      }
    };

    /*
     * Everything below is read again from the host.
     *
     * The chains captured before the append are snapshots of a project
     * that has since changed, and touching one of them answers "The
     * script object is no longer valid" — the same failure that the
     * Organize tool was hitting. Identity survives the commit; handles
     * do not.
     */
    const refreshedSequence = await (await ppro.Project.getActiveProject())
      ?.getActiveSequence();
    const refreshedClips = refreshedSequence
      ? await collectSelectedVideoClips(ppro, refreshedSequence)
      : [];
    const clipByKey = new Map(refreshedClips.map((ref) => [ref.key, ref.clip]));

    /*
     * Um Transform que não for reencontrado aqui fica NO CLIPE.
     *
     * Os três `continue` abaixo pulavam o registro em `appended`, e
     * `rollbackAppends` só desfaz o que está lá. Ou seja: justamente
     * no caso em que a coisa deu errado — clipe não reencontrado,
     * cadeia ilegível, componente sumido — o efeito inserido ficava
     * pendurado no clipe, inerte, para o editor achar e apagar à mão.
     * Era o rollback falhando pela porta dos fundos.
     *
     * Agora o registro é feito com o que houver: quando a cadeia
     * responde mas o componente não é encontrado, ela ainda dá para
     * remover pelo índice do append.
     */
    const semResgate: string[] = [];
    /** O primeiro clipe serve de cobaia para o relatório. */
    let probeChain: VideoComponentChain | null = null;
    let probeTransform: Component | null = null;
    let probeTicks = "0";
    let probeTarget: ClipTarget | null = null;

    for (const target of targets) {
      const clip = clipByKey.get(target.clipKey);
      if (!clip) {
        console.warn("[Zoom] clipe não encontrado após a inserção do Transform");
        semResgate.push(target.clipKey);
        continue;
      }
      const chain = await clip.getComponentChain();
      if (!chain) {
        console.warn("[Zoom] cadeia de efeitos ilegível após a inserção");
        semResgate.push(target.clipKey);
        continue;
      }

      const comp = await findTransformComponent(
        chain,
        transformMatchName,
        target.appendIndex
      );
      if (!comp) {
        console.warn("[Zoom] componente Transform não encontrado no clipe");
        // A cadeia responde: dá para tirar pelo índice em que o
        // append caiu, mesmo sem reconhecer o componente pelo nome.
        const porIndice = await componentAtIndex(chain, target.appendIndex);
        if (porIndice) {
          appended.push({ chain, component: porIndice });
        } else {
          semResgate.push(target.clipKey);
        }
        continue;
      }
      appended.push({ chain, component: comp });
      if (!probeTransform) {
        probeChain = chain;
        probeTransform = comp;
        probeTicks = target.startTicks;
        probeTarget = target;
      }

      const scaleParam = await findScaleParamWithDiag(comp);
      if (!scaleParam) {
        console.warn("[Zoom] parâmetro Scale não encontrado no Transform");
        continue;
      }

      readyScaleItems.push({
        chain,
        scaleParam,
        startTicks: target.startTicks,
        endTicks: target.endTicks,
      });
    }

    if (semResgate.length > 0) {
      console.warn(
        `[Zoom] ${semResgate.length} Transform(s) podem ter ficado no clipe: ` +
          semResgate.join(", ")
      );
    }

    if (readyScaleItems.length === 0) {
      rollbackAppends();
      return fail(
        "Nenhum parâmetro Scale encontrado no Transform. O console do UXP tem o dump."
      );
    }

    /*
     * O relatório, ANTES de escrever qualquer coisa.
     *
     * O `Motion` é intrínseco e sempre tem valor de verdade — Escala
     * 100%, Posição no centro. Se a Escala dele responder 100, este
     * host fala em porcento; se responder 1, fala em fração. Ao lado,
     * o Transform recém-inserido mostra o que responde um parâmetro
     * que ainda não tem valor. É a comparação entre os dois que diz em
     * que unidade escrever — coisa que até agora só foi deduzida, e
     * deduzida errado.
     */
    const motion = probeChain ? await findComponent(probeChain, /motion/i) : null;
    const relatorio: Record<string, unknown> = {
      quando: new Date().toISOString(),
      transformMatchName,
      ticksDaCabeca: probeTicks,
      relogios: probeTarget
        ? {
            mediaIn: probeTarget.startTicks,
            mediaOut: probeTarget.endTicks,
            sequenciaIn: probeTarget.seqStartTicks,
            sequenciaOut: probeTarget.seqEndTicks,
          }
        : "(clipe-cobaia não encontrado)",
      vouEscrever: {
        de: options.direction === "in" ? NEUTRAL_SCALE : options.scalePercent,
        para: options.direction === "in" ? options.scalePercent : NEUTRAL_SCALE,
      },
      scaleParamEscolhido: readyScaleItems[0]
        ? safeDisplayName(readyScaleItems[0].scaleParam)
        : null,
      motion: motion ? await probeParams(ppro, motion, probeTicks) : "(Motion não encontrado)",
      transformNovo: probeTransform
        ? await probeParams(ppro, probeTransform, probeTicks)
        : "(Transform não encontrado)",
    };
    // Escrito já aqui: se a transação seguinte derrubar o plugin, o que
    // foi medido até agora continua em disco.
    await dumpDiag(relatorio);

    // ─────────────────────────────────────────────────────────────────────────
    // O primeiro frame a 0% — o que era, de verdade
    //
    // Ligar o cronômetro faz o Premiere plantar um keyframe SEU, no
    // tick 0 do parâmetro, com valor 0. As quatro tentativas anteriores
    // supuseram isso sem nunca medir, e trataram o sintoma; o relatório
    // agora mede. O que não estava suposto é a assimetria — e é ela que
    // explica por que o bug parecia intermitente:
    //
    //   • Clipe APARADO (in point ≠ 0): o âncora nasce no tick 0, que
    //     fica FORA do trecho animado. Ele é estranho à nossa lista, a
    //     varredura do fim o remove, e o zoom sai certo. Foi o caso
    //     testado — e por isso o bug "sumiu" quatro vezes.
    //   • Clipe INTEIRO, do começo da mídia (in point = 0): o âncora
    //     nasce EXATAMENTE no tick da nossa cabeça. E
    //     `createAddKeyframeAction` num tick que já tem keyframe é
    //     IGNORADO em silêncio — a nossa cabeça de 100% nunca entrava,
    //     a do host de 0% ficava, e é esse b-roll que abre sumindo.
    //
    // A correção não é escrever por cima nem apagar depois: é não
    // deixar acontecer a colisão. Três transações, nesta ordem —
    // liga o cronômetro, VÊ o que ele criou e apaga, e só então
    // escreve num campo limpo. Apagar tem de ficar numa transação
    // separada da escrita: no mesmo compound as duas se anulam.
    // ─────────────────────────────────────────────────────────────────────────
    const [baseFrom, baseTo] =
      options.direction === "in"
        ? [NEUTRAL_SCALE, options.scalePercent]
        : [options.scalePercent, NEUTRAL_SCALE];

    /** Os ticks que NÓS pusemos, por item — com o valor de cada um. */
    const placedOf = new Map<ReadyScaleItem, Map<string, number>>();

    /*
     * O plano inteiro, calculado antes de tocar no host.
     *
     * Um clipe sem duração não tem o que animar — e ligar o cronômetro
     * nele deixaria o Scale com UM keyframe só, o âncora, no comando do
     * clipe inteiro. É a forma mais crua do mesmo bug, então ele nem
     * entra na lista.
     */
    const animaveis: ReadyScaleItem[] = [];
    for (const item of readyScaleItems) {
      const startSec = ppro.TickTime.createWithTicks(item.startTicks).seconds;
      const endSec = ppro.TickTime.createWithTicks(item.endTicks).seconds;
      const duration = endSec - startSec;
      if (!(duration > 0)) {
        continue;
      }
      placedOf.set(
        item,
        placeKeyframes(
          ppro,
          options,
          baseFrom,
          baseTo,
          item.startTicks,
          item.endTicks,
          startSec,
          duration,
          ticksPerFrame
        )
      );
      animaveis.push(item);
    }

    if (animaveis.length === 0) {
      rollbackAppends();
      return fail("Nenhum clipe selecionado tem duração para animar.");
    }

    // ── 1ª transação: só ligar o cronômetro ──────────────────────────
    let clockCommitted = false;
    project.lockedAccess(() => {
      clockCommitted = project.executeTransaction((compoundAction) => {
        for (const item of animaveis) {
          compoundAction.addAction(item.scaleParam.createSetTimeVaryingAction(true));
        }
      }, "Ligar o cronômetro do Zoom");
    });

    if (!clockCommitted) {
      rollbackAppends();
      return fail("O Premiere recusou ligar o cronômetro do Scale.");
    }

    // ── 2ª transação: apagar o que o host plantou sozinho ────────────
    /** O âncora do host, como ele saiu — a medida que faltava. */
    const keyframesDoHost: Array<{ ticks: string; valor: unknown }> = [];
    const paraApagar: Array<{ param: ComponentParam; time: TickTime }> = [];

    for (const item of animaveis) {
      let times: unknown;
      try {
        times = await Promise.resolve(item.scaleParam.getKeyframeListAsTickTimes());
      } catch (cause) {
        console.warn("[Zoom] não deu para listar o que o cronômetro criou:", cause);
        continue;
      }
      if (!Array.isArray(times)) {
        continue;
      }
      for (const time of times) {
        // Só o primeiro clipe vai para o relatório: o arquivo é para
        // ler, e vinte clipes de lista não se leem.
        if (item === animaveis[0]) {
          let valor: unknown = "(não lido)";
          try {
            const bruto = await item.scaleParam.getValueAtTime(time);
            valor = numberOf(bruto) ?? bruto;
          } catch (cause) {
            valor = `(erro: ${describeError(cause)})`;
          }
          keyframesDoHost.push({ ticks: String(time?.ticks ?? "?"), valor });
        }
        paraApagar.push({ param: item.scaleParam, time });
      }
    }

    let hostCleared = true;
    if (paraApagar.length > 0) {
      console.log(
        `[Zoom] o cronômetro criou ${paraApagar.length} keyframe(s); apagando antes de escrever`
      );
      hostCleared = false;
      try {
        project.lockedAccess(() => {
          hostCleared = project.executeTransaction((compoundAction) => {
            for (const entry of paraApagar) {
              compoundAction.addAction(
                entry.param.createRemoveKeyframeAction(entry.time)
              );
            }
          }, "Limpar o keyframe que o Premiere criou sozinho");
        });
      } catch (cause) {
        console.warn("[Zoom] a limpeza do âncora não assentou:", cause);
      }
    }

    // ── 3ª transação: os nossos, num campo limpo ─────────────────────
    let animCommitted = false;
    project.lockedAccess(() => {
      animCommitted = project.executeTransaction((compoundAction) => {
        for (const item of animaveis) {
          const placed = placedOf.get(item);
          if (!placed) {
            continue;
          }

          for (const [ticks, value] of placed) {
            const kf = item.scaleParam.createKeyframe(value);
            kf.position = ppro.TickTime.createWithTicks(ticks);
            compoundAction.addAction(item.scaleParam.createAddKeyframeAction(kf));
          }

          // Without LINEAR, Premiere smooths on top of the baked curve
          // and the shape drifts.
          for (const ticks of placed.keys()) {
            compoundAction.addAction(
              item.scaleParam.createSetInterpolationAtKeyframeAction(
                ppro.TickTime.createWithTicks(ticks),
                ppro.Constants.InterpolationMode.LINEAR
              )
            );
          }
        }
      }, "Aplicar Zoom");
    });

    if (!animCommitted) {
      rollbackAppends();
      return fail("Premiere rejected the zoom animation transaction.");
    }

    /** O primeiro tick de cada clipe — é ele que a conferência lê. */
    const headOf = new Map<ReadyScaleItem, string>();
    for (const [item, placed] of placedOf) {
      const first = [...placed.keys()][0];
      if (first !== undefined) {
        headOf.set(item, first);
      }
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Some com o que não fomos nós
    //
    // Numa transação à parte, DEPOIS do commit: se esta falhar, o zoom
    // já está aplicado e continua aplicado. Nada de rollback por causa
    // de um frame.
    // ─────────────────────────────────────────────────────────────────────────
    const strays: Array<{ param: ComponentParam; times: TickTime[] }> = [];
    for (const item of readyScaleItems) {
      const nossos = placedOf.get(item);
      if (!nossos || nossos.size === 0) {
        continue;
      }
      try {
        const kfTimes = await Promise.resolve(item.scaleParam.getKeyframeListAsTickTimes());
        if (!Array.isArray(kfTimes)) {
          continue;
        }
        // Comparado como NÚMERO, não como texto: o host devolve o tick
        // na forma dele, e "0" e "0000" são o mesmo instante com
        // strings diferentes.
        const meus = new Set<string>();
        for (const t of nossos.keys()) {
          try {
            meus.add(BigInt(t).toString());
          } catch {
            meus.add(t);
          }
        }
        const alheios = kfTimes.filter((time) => {
          try {
            return !meus.has(BigInt(time.ticks).toString());
          } catch {
            return false;
          }
        });
        if (alheios.length > 0) {
          strays.push({ param: item.scaleParam, times: alheios });
        }
      } catch (err) {
        console.warn("[Zoom] leitura de keyframes para a varredura falhou:", err);
      }
    }

    if (strays.length > 0) {
      const total = strays.reduce((soma, entry) => soma + entry.times.length, 0);
      console.log(`[Zoom] removendo ${total} keyframe(s) que o host criou sozinho`);
      try {
        project.lockedAccess(() => {
          project.executeTransaction((compoundAction) => {
            for (const entry of strays) {
              for (const time of entry.times) {
                compoundAction.addAction(entry.param.createRemoveKeyframeAction(time));
              }
            }
          }, "Limpar keyframe alheio do Zoom");
        });
      } catch (err) {
        console.warn("[Zoom] não foi possível remover o keyframe alheio:", err);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // A cabeça, CONFERIDA — e refeita enquanto não bater
    //
    // ── Por que conferir, se já foi escrita ──────────────────────────
    // As duas transações acima são a quarta tentativa de resolver o
    // primeiro frame a 0%, e as três anteriores também "commitaram sem
    // erro". Commit não é evidência: `createAddKeyframeAction` num tick
    // que já tem keyframe é IGNORADO em silêncio, e `executeTransaction`
    // devolve `true` do mesmo jeito. A única prova é LER o valor de
    // volta — coisa que a validação abaixo nunca fez, porque só contava
    // quantos keyframes existiam.
    //
    // Então: lê a cabeça. Se ela já estiver no valor certo, não se faz
    // nada. Se não estiver, apaga e reescreve — em duas transações
    // separadas, porque no mesmo compound as duas se anulam — e lê de
    // novo, para o relatório dizer se pegou.
    // ─────────────────────────────────────────────────────────────────────────
    interface RelatoDaCabeca {
      tick: string;
      alvo: number;
      antes: unknown;
      precisou: boolean;
      apagou: boolean;
      escreveu: boolean;
      depois: unknown;
      erro?: string;
    }
    const cabecas: RelatoDaCabeca[] = [];

    for (const item of readyScaleItems) {
      const tick = headOf.get(item);
      if (tick === undefined) {
        continue;
      }
      const alvo = placedOf.get(item)?.get(tick) ?? baseFrom;
      const time = ppro.TickTime.createWithTicks(tick);

      const ler = async (): Promise<unknown> => {
        try {
          return await item.scaleParam.getValueAtTime(time);
        } catch (cause) {
          return `(erro: ${describeError(cause)})`;
        }
      };

      const bruto = await ler();
      const relato: RelatoDaCabeca = {
        tick,
        alvo,
        antes: numberOf(bruto) ?? bruto,
        precisou: false,
        apagou: false,
        escreveu: false,
        depois: null,
      };

      const lido = numberOf(bruto);
      // `null` aqui é "não deu para ler" — e não dá para declarar certo
      // o que não foi lido. Refazer nesse caso é barato e idempotente.
      if (lido === null || Math.abs(lido - alvo) > 0.5) {
        relato.precisou = true;
        try {
          project.lockedAccess(() => {
            relato.apagou = project.executeTransaction((compoundAction) => {
              compoundAction.addAction(
                item.scaleParam.createRemoveKeyframeAction(time)
              );
            }, "Corrigir a cabeça do Zoom (apagar)");
          });
          project.lockedAccess(() => {
            relato.escreveu = project.executeTransaction((compoundAction) => {
              const kf = item.scaleParam.createKeyframe(alvo);
              kf.position = time;
              compoundAction.addAction(item.scaleParam.createAddKeyframeAction(kf));
              compoundAction.addAction(
                item.scaleParam.createSetInterpolationAtKeyframeAction(
                  time,
                  ppro.Constants.InterpolationMode.LINEAR
                )
              );
            }, "Corrigir a cabeça do Zoom (escrever)");
          });
        } catch (cause) {
          relato.erro = describeError(cause);
          console.warn("[Zoom] a correção da cabeça não assentou:", cause);
        }
        const depois = await ler();
        relato.depois = numberOf(depois) ?? depois;
      } else {
        relato.depois = relato.antes;
      }

      cabecas.push(relato);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Validation: verify keyframes exist via getKeyframeListAsTickTimes
    // ─────────────────────────────────────────────────────────────────────────
    let verifiedCount = 0;
    let unreadableCount = 0;
    for (const item of readyScaleItems) {
      try {
        // O typings diz síncrono; o host devolve Promise. Sem o await,
        // Array.isArray(promessa) dava zero em TODO clipe e a
        // verificação desfazia um zoom que tinha funcionado.
        const kfTimes = await Promise.resolve(item.scaleParam.getKeyframeListAsTickTimes());
        const count = Array.isArray(kfTimes) ? kfTimes.length : 0;
        console.log(`[Zoom] Scale keyframe count after commit: ${count}`);
        if (count > 0 && Array.isArray(kfTimes) && kfTimes[0]) {
          try {
            const firstVal = await item.scaleParam.getValueAtTime(kfTimes[0]);
            console.log(`[Zoom] First keyframe at ${kfTimes[0].seconds}s has value:`, firstVal);
          } catch {
            // non-fatal diagnostic
          }
        }
        if (count >= 2) {
          verifiedCount += 1;
        }
      } catch (err) {
        console.warn("[Zoom] getKeyframeListAsTickTimes error:", err);
        // The transaction did commit, so this is not evidence of failure —
        // but folding it into `verifiedCount` made the number in the
        // message stop meaning "keyframes are there".
        unreadableCount += 1;
      }
    }

    /*
     * O relatório fechado: o que foi escrito, e o que o host guardou.
     *
     * A lista de keyframes vem com VALOR, não só com contagem — é a
     * diferença entre "nove keyframes" e "nove keyframes subindo de
     * zero". Só do primeiro clipe: o arquivo é para ler, e vinte
     * clipes de lista não se leem.
     */
    relatorio.depois = {
      cronometroLigado: clockCommitted,
      keyframesDoHost,
      hostLimpo: hostCleared,
      cabecas,
      keyframesDoPrimeiroClipe: readyScaleItems[0]
        ? await probeKeyframes(readyScaleItems[0].scaleParam)
        : "(nenhum item)",
      clipesVerificados: verifiedCount,
      clipesIlegiveis: unreadableCount,
    };
    await dumpDiag(relatorio);

    if (verifiedCount === 0 && unreadableCount === 0) {
      rollbackAppends();
      return fail("Nenhum keyframe foi criado no Scale do Transform.");
    }

    // One subtraction against the clips we started from. Adding a running
    // `skipped` to it counted the same clip twice.
    const applied = verifiedCount + unreadableCount;
    return {
      ok: true,
      message: summarize(
        applied,
        videoClips.length - applied,
        unreadableCount,
        speedSkipped
      ),
    };
  } catch (cause) {
    rollbackAppends?.();
    return fail(`Zoom falhou: ${describeError(cause)}`);
  }
}

/**
 * Os keyframes de um clipe: tick → valor, já no grid e sem repetidos.
 *
 * ── Por que uma reta não leva nove keyframes ──────────────────────
 * Assar a curva em nove amostras é o que permite desenhar qualquer
 * forma, inclusive as que passam do alvo e voltam. Só que uma RETA
 * entre dois pontos é definida por dois pontos: as sete do meio caem
 * todas exatamente em cima dela, e o que fazem de útil é nada. O que
 * fazem de ruim não é nada: são sete keyframes a mais para o editor
 * desviar quando for ajustar o punch à mão.
 *
 * A reta é DETECTADA, amostrando a curva — e não perguntada ao
 * seletor. Assim também sai com dois keyframes a reta que alguém
 * desenhou à mão sem escolher o preset.
 */
function placeKeyframes(
  ppro: premierepro,
  options: ZoomOptions,
  baseFrom: number,
  baseTo: number,
  startTicks: string,
  endTicks: string,
  startSec: number,
  duration: number,
  ticksPerFrame: bigint | null
): Map<string, number> {
  const placed = new Map<string, number>();
  const delta = baseTo - baseFrom;

  // Snapped to the frame grid and deduped: off-grid keyframes land
  // where the editor cannot reproduce them by dragging, and two that
  // round onto one frame become one keyframe with an arbitrary value.
  placed.set(startTicks, baseFrom);
  placed.set(snapTicksToFrame(startTicks, ticksPerFrame), baseFrom);

  if (!isLinear(options.ease)) {
    for (let step = 1; step < CURVE_KEYS; step++) {
      const t = step / CURVE_KEYS;
      const ticks = snapTicksToFrame(
        ppro.TickTime.createWithSeconds(startSec + duration * t).ticks,
        ticksPerFrame
      );
      placed.set(ticks, baseFrom + delta * options.ease(t));
    }
  }

  placed.set(endTicks, baseTo);
  placed.set(snapTicksToFrame(endTicks, ticksPerFrame), baseTo);
  return placed;
}

/** True quando a curva é a reta: toda amostra cai sobre ela. */
function isLinear(ease: (t: number) => number): boolean {
  for (let step = 1; step < CURVE_KEYS; step++) {
    const t = step / CURVE_KEYS;
    if (Math.abs(ease(t) - t) > 0.002) {
      return false;
    }
  }
  return true;
}

/** Returns the host's own spelling of the Transform matchName, or null. */
async function resolveTransformMatchName(
  ppro: premierepro
): Promise<{ matchName: string | null; candidates: string[] }> {
  let available: string[] = [];
  try {
    const names = await ppro.VideoFilterFactory.getMatchNames();
    if (Array.isArray(names)) {
      available = names;
    }
  } catch (err) {
    console.error("[Zoom] Failed to getMatchNames from VideoFilterFactory:", err);
    return { matchName: null, candidates: [] };
  }

  const candidates = available.filter(
    (name) => typeof name === "string" && /geometry|transform/i.test(name)
  );
  console.log(
    "[Zoom] Available Transform/Geometry video filter matchNames:",
    candidates
  );

  if (candidates.length === 0) {
    return { matchName: null, candidates: [] };
  }

  const byLowercase = new Map<string, string>();
  for (const name of available) {
    if (typeof name === "string") {
      byLowercase.set(name.toLowerCase(), name);
    }
  }

  for (const candidate of TRANSFORM_MATCH_NAMES) {
    const match = byLowercase.get(candidate.toLowerCase());
    if (match) {
      return { matchName: match, candidates };
    }
  }

  const geometry2 = candidates.find((c) => /geometry2/i.test(c));
  if (geometry2) {
    return { matchName: geometry2, candidates };
  }

  const transform = candidates.find((c) => /transform/i.test(c));
  if (transform) {
    return { matchName: transform, candidates };
  }

  const geometry = candidates.find((c) => /geometry/i.test(c));
  if (geometry) {
    return { matchName: geometry, candidates };
  }

  return { matchName: null, candidates };
}

/** O componente que caiu num índice da cadeia, ou null. */
async function componentAtIndex(
  chain: VideoComponentChain,
  index: number
): Promise<Component | null> {
  try {
    return (await Promise.resolve(chain.getComponentAtIndex(index))) ?? null;
  } catch {
    return null;
  }
}

/**
 * The Transform that was just appended.
 *
 * Looked up at the index the append was going to occupy, then confirmed
 * by matchName. The old version fell back to "the last component in the
 * chain" with no check at all, which would happily hand back an unrelated
 * effect for the keyframes to land in.
 */
async function findTransformComponent(
  chain: VideoComponentChain,
  expectedMatchName: string,
  appendIndex: number
): Promise<Component | null> {
  const count = await Promise.resolve(chain.getComponentCount());
  if (count === 0) {
    return null;
  }

  const matches = async (component: Component | null): Promise<boolean> => {
    if (!component) {
      return false;
    }
    const matchName = await component.getMatchName().catch(() => "");
    return matchName.toLowerCase() === expectedMatchName.toLowerCase();
  };

  if (appendIndex < count) {
    try {
      const atIndex = await Promise.resolve(chain.getComponentAtIndex(appendIndex));
      if (await matches(atIndex)) {
        return atIndex;
      }
    } catch {
      // Fall through to the search below.
    }
  }

  // The chain shifted under us. Search only what was added after the
  // append point, so an effect that was already there cannot be picked.
  for (let index = count - 1; index >= appendIndex; index--) {
    try {
      const component = await Promise.resolve(chain.getComponentAtIndex(index));
      if (await matches(component)) {
        return component;
      }
    } catch {
      // Keep looking.
    }
  }

  return null;
}

/**
 * Dumps every param (index | displayName | areKeyframesSupported) of the
 * Transform component to the console, then returns the Scale param.
 * areKeyframesSupported() is checked per-param for diagnostic purposes only —
 * it is NOT used as a hard gate.
 */
async function findScaleParamWithDiag(
  component: Component
): Promise<ComponentParam | null> {
  let count = 0;
  try {
    // Mesmo caso do typings-vs-host: sem await, `index < promessa`
    // nunca é verdadeiro e o laço não roda — nenhum Scale é achado.
    count = Number(await Promise.resolve(component.getParamCount())) || 0;
  } catch {
    console.error("[Zoom] getParamCount() threw on Transform component");
    return null;
  }

  /*
   * Os nomes, em lote — e sem perguntar por keyframes.
   *
   * `areKeyframesSupported()` é uma ida e volta ao host POR PARÂMETRO,
   * e o próprio comentário acima diz que o valor é só diagnóstico: ele
   * nunca barrou nada. Com treze parâmetros no Transform e vinte
   * clipes selecionados, eram ~260 esperas cujo único destino era uma
   * linha de console. Saiu da varredura; quem quiser o dump completo
   * liga `DUMP_PARAMS`.
   *
   * Os nomes continuam sendo lidos, porque é por eles que o Scale é
   * achado — mas todos de uma vez.
   */
  const params = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      Promise.resolve(component.getParam(index)).catch(() => null)
    )
  );
  const rows = params.map((param, index) => ({
    index,
    name: param ? safeDisplayName(param) : "(error)",
  }));

  if (DUMP_PARAMS) {
    console.log(`[Zoom] Transform has ${count} params:`);
    for (const row of rows) {
      const param = params[row.index];
      let kf: boolean | string = "?";
      try {
        kf = param ? await param.areKeyframesSupported() : "error";
      } catch {
        kf = "error";
      }
      console.log(`  [${row.index}] "${row.name}" | keyframesSupported=${kf}`);
    }
  }

  // Pass 1: exact match with known localized names. No "uniform" guard
  // here — nothing in SCALE_PARAM_NAMES contains it, so the check was dead.
  for (const row of rows) {
    if (SCALE_PARAM_NAMES.has(row.name)) {
      try {
        return component.getParam(row.index);
      } catch {
        // continue
      }
    }
  }

  // Pass 2: starts with "scale" / "escala" but not uniform/width/height
  for (const row of rows) {
    const name = row.name;
    if (
      (name.startsWith("scale") || name.startsWith("escala")) &&
      !name.includes("width") &&
      !name.includes("height") &&
      !name.includes("largura") &&
      !name.includes("altura") &&
      !name.includes("uniform") &&
      !name.includes("proporç")
    ) {
      try {
        return component.getParam(row.index);
      } catch {
        // continue
      }
    }
  }

  // Pass 3: any keyframeable param whose name mentions scale, in either
  // spelling. Looking only for "scale" meant this last resort never fired
  // on a Premiere running in Portuguese, which is the one it exists for.
  //
  // Aqui `areKeyframesSupported` É usado como filtro — e só aqui. Por
  // isso a pergunta é feita agora, sobre os poucos candidatos que
  // mencionam escala, em vez de sobre os treze parâmetros lá em cima.
  // Mesmo resultado, duas idas e voltas em vez de treze.
  const candidatos = rows.filter(
    (row) =>
      (row.name.includes("scale") || row.name.includes("escala")) &&
      !row.name.includes("uniform")
  );
  const aceitaKeyframe = await Promise.all(
    candidatos.map((row) => {
      const param = params[row.index];
      return param
        ? Promise.resolve(param.areKeyframesSupported()).catch(() => false)
        : Promise.resolve(false);
    })
  );
  for (let at = 0; at < candidatos.length; at++) {
    if (aceitaKeyframe[at] === true) {
      try {
        return component.getParam(candidatos[at].index);
      } catch {
        // continue
      }
    }
  }

  console.warn("[Zoom] Could not match Scale param in any pass.");
  return null;
}

function safeDisplayName(param: ComponentParam): string {
  try {
    return (param.displayName ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function summarize(
  applied: number,
  skipped: number,
  unverified: number,
  speedSkipped: number
): string {
  const parts = [`Zoom aplicado em ${applied} ${plural(applied, "clipe")}.`];
  if (speedSkipped > 0) {
    parts.push(
      `${speedSkipped} ${plural(speedSkipped, "clipe")} com velocidade alterada ` +
        `${speedSkipped === 1 ? "foi ignorado" : "foram ignorados"}.`
    );
  }
  const other = skipped - speedSkipped;
  if (other > 0) {
    parts.push(
      `${other} sem Scale no Transform ${other === 1 ? "foi ignorado" : "foram ignorados"}.`
    );
  }
  if (unverified > 0) {
    parts.push(
      `Não consegui reler ${unverified} — confira o Effect Controls.`
    );
  }
  return parts.join(" ");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function fail(message: string): ZoomResult {
  return { ok: false, message };
}
