/**
 * O relatório do Zoom — os fatos, em disco.
 *
 * ── Por que em arquivo, e não no console ──────────────────────────
 * O console do UXP mora dentro do Premiere: chegar até ele exige
 * pedir a alguém que abra, copie e cole. Cada rodada desse ping-pong
 * volta com menos do que precisava, e já custou uma tarde. Em arquivo
 * os fatos ficam TODOS, e quem for consertar lê sem intermediário.
 *
 * O arquivo é sobrescrito a cada aplicação: interessa sempre a última.
 */
import type { Component, ComponentParam, premierepro } from "@adobe/premierepro";
import { nativePath, workspace, write } from "../silence/workspace";

const DIAG_FILE = "zoom-diag.json";

/** Um parâmetro como o host o entrega: nome, tipo e valor cru. */
export interface ParamProbe {
  index: number;
  name: string;
  tipo: string;
  valor: unknown;
}

/**
 * O relatório completo, a cada aplicação.
 *
 * Desligado, e não por economia de disco: montá-lo custa uma ida e
 * volta ao host POR PARÂMETRO e por keyframe. Num trecho de dezoito
 * keyframes em dois parâmetros são mais de cem perguntas ao Premiere
 * que não têm nada a ver com o trabalho pedido.
 *
 * Ligue à mão quando estiver investigando. No mais, o relatório
 * continua saindo sozinho sempre que algo dá errado — ver o `force` de
 * `dumpDiag` — que é exatamente quando ele serve para alguma coisa.
 */
export const DIAG_ENABLED = false;

/**
 * Grava o relatório. Com o diagnóstico desligado, só grava quando
 * `force` diz que algo deu errado: é o caso em que ele vale o disco.
 */
export async function dumpDiag(
  payload: unknown,
  file = DIAG_FILE,
  force = false
): Promise<void> {
  if (!DIAG_ENABLED && !force) {
    return;
  }
  try {
    const space = await workspace();
    await write(space, file, JSON.stringify(payload, null, 2));
    console.log(`[Diag] relatório em ${nativePath(space, file)}`);
  } catch (cause) {
    console.warn("[Diag] não consegui escrever o relatório:", cause);
  }
}

/**
 * Todo parâmetro de um componente, com o valor que ele responde.
 *
 * Serve para dois componentes diferentes e é da comparação entre eles
 * que sai a resposta: o `Motion` é intrínseco e SEMPRE tem valor de
 * verdade — Escala 100%, Posição no centro do quadro. Se a Escala do
 * Motion responder 100, este host fala em porcento; se responder 1,
 * fala em fração. O Transform recém-inserido, do lado, mostra o que um
 * parâmetro ainda sem valor responde.
 */
export async function probeParams(
  ppro: premierepro,
  component: Component,
  ticks: string
): Promise<ParamProbe[]> {
  const rows: ParamProbe[] = [];
  let count = 0;
  try {
    count = Number(await Promise.resolve(component.getParamCount())) || 0;
  } catch {
    return rows;
  }

  for (let index = 0; index < count; index += 1) {
    let name = "(erro)";
    let valor: unknown = "(não lido)";
    let tipo = "?";
    try {
      const param: ComponentParam = component.getParam(index);
      try {
        name = (param.displayName ?? "").trim();
      } catch {
        name = "(sem nome)";
      }
      try {
        const raw = await param.getValueAtTime(ppro.TickTime.createWithTicks(ticks));
        tipo = raw === null ? "null" : typeof raw;
        valor = unwrapValue(raw);
      } catch (cause) {
        valor = `(erro: ${cause instanceof Error ? cause.message : String(cause)})`;
      }
    } catch {
      /* parâmetro ilegível: fica registrado como (erro) */
    }
    rows.push({ index, name, tipo, valor });
  }
  return rows;
}

/**
 * O valor de verdade, por baixo do embrulho do host.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * O typings promete que `getValueAtTime` devolve number | string |
 * boolean | PointF | Color. O host devolve OUTRA coisa: um `Keyframe`,
 * cujo campo `value` é, ele próprio, `{ value: ... }`. Resultado: o
 * relatório anterior anotou "[object Object]" em TODOS os onze
 * parâmetros — Rotation, Opacity, Scale, todos — e a pergunta que ele
 * existia para responder (em que unidade este host fala) voltou em
 * branco.
 *
 * Desembrulha `.value` enquanto houver, e só então decide o que é.
 */
export function unwrapValue(raw: unknown, depth = 0): unknown {
  if (raw === null || raw === undefined) {
    return raw ?? null;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : "NaN";
  }
  if (typeof raw !== "object") {
    return raw;
  }
  // Um ponto pode vir como array [x, y] — o Motion responde assim.
  if (Array.isArray(raw)) {
    return raw.map((item) => unwrapValue(item, depth + 1));
  }
  // Um ponto não sobrevive ao JSON como objeto do host: vira {}.
  // Copiado campo a campo, ele chega legível do outro lado.
  const point = raw as { x?: unknown; y?: unknown };
  if (point.x !== undefined || point.y !== undefined) {
    return { x: Number(point.x), y: Number(point.y) };
  }
  const wrapper = raw as { value?: unknown };
  if ("value" in wrapper && depth < 4) {
    return unwrapValue(wrapper.value, depth + 1);
  }
  try {
    const keys = Object.keys(raw as object);
    return keys.length > 0 ? `(objeto: ${keys.join(", ")})` : String(raw);
  } catch {
    return String(raw);
  }
}

/** O mesmo desembrulho, mas só quando dá um número. Senão, null. */
export function numberOf(raw: unknown): number | null {
  const plain = unwrapValue(raw);
  return typeof plain === "number" ? plain : null;
}

/** Um keyframe como ele está no host: onde, e com que valor. */
export interface KeyframeProbe {
  ticks: string;
  segundos: number;
  valor: unknown;
}

/**
 * A lista inteira de keyframes de um parâmetro, com VALOR.
 *
 * A validação antiga só contava quantos eram. Contar não distingue
 * "nove keyframes subindo de 100 a 115" de "nove keyframes subindo de
 * 0 a 115" — que é exatamente o bug que ela deixou passar quatro vezes.
 */
export async function probeKeyframes(
  param: ComponentParam
): Promise<KeyframeProbe[] | string> {
  let times: unknown;
  try {
    times = await Promise.resolve(param.getKeyframeListAsTickTimes());
  } catch (cause) {
    return `(erro na lista: ${cause instanceof Error ? cause.message : String(cause)})`;
  }
  if (!Array.isArray(times)) {
    return "(o host não devolveu uma lista)";
  }
  const rows: KeyframeProbe[] = [];
  for (const time of times) {
    let valor: unknown = "(não lido)";
    try {
      valor = unwrapValue(await param.getValueAtTime(time));
    } catch (cause) {
      valor = `(erro: ${cause instanceof Error ? cause.message : String(cause)})`;
    }
    rows.push({
      ticks: String(time?.ticks ?? "?"),
      segundos: Number(time?.seconds ?? NaN),
      valor,
    });
  }
  return rows;
}

/** O componente da cadeia cujo matchName casa com o padrão, ou null. */
export async function findComponent(
  chain: { getComponentCount(): number | Promise<number>; getComponentAtIndex(index: number): Component | Promise<Component> },
  pattern: RegExp
): Promise<Component | null> {
  try {
    const count = Number(await Promise.resolve(chain.getComponentCount())) || 0;
    for (let index = 0; index < count; index += 1) {
      const component = await Promise.resolve(chain.getComponentAtIndex(index));
      const matchName = component ? await component.getMatchName().catch(() => "") : "";
      if (pattern.test(matchName)) {
        return component;
      }
    }
  } catch {
    /* cadeia ilegível */
  }
  return null;
}
