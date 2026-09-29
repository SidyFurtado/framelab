/**
 * O `definition.json` de um `.mogrt` com outro texto dentro.
 *
 * ── O que é este arquivo ───────────────────────────────────────────
 * É o descritor do Essential Graphics: os controles que o motion
 * designer expôs (texto, cor, tamanho…), com o valor de fábrica de
 * cada um. O Premiere lê esses valores ao inserir o modelo — é por
 * isso que trocar a frase AQUI, antes de inserir, faz o clipe nascer
 * com o texto certo sem nenhuma API de parâmetro.
 *
 * ── Modelo com MAIS DE UM campo de texto ──────────────────────────
 * O "CLEAN BLUE" tem dois: "Clean" e "blue", cada um com o seu
 * gradiente — é disso que o efeito dele é feito. Trocar só o primeiro
 * deixava a segunda palavra do modelo na tela: escrevi "teste" e saiu
 * "teste blue". Então a regra é UMA LINHA POR CAMPO, na ordem em que
 * o modelo os expõe; a última recebe o que sobrar, e campo sem linha
 * fica VAZIO em vez de guardar a palavra de fábrica.
 *
 * Num modelo de campo único — a maioria, e toda legenda — nada disso
 * aparece: o texto inteiro vai para lá, quebras e tudo.
 *
 * ── Onde o texto mora (medido no "BB Pop" e no "SMOOTH BOUNCE") ───
 * Em dois lugares que precisam concordar:
 *   • `clientControls[]` — o controle de tipo 6, com `value.strDB[].str`
 *     e a tipografia em `fonteditinfo`;
 *   • `sourceInfoLocalized[idioma].capsuleparams.capParams[]` — a
 *     entrada cujo `capPropMatchName` é o id daquele controle, com
 *     `textEditValue`, `capPropDefault`, `fontEditValue[0]`,
 *     `fontSizeEditValue[0]` e `fontTextRunLength[0]`.
 * O comprimento do trecho (`fontTextRunLength`) tem que casar com a
 * frase nova; é o que diz até onde a formatação vale.
 *
 * ── Por que um capsuleID novo ──────────────────────────────────────
 * O Premiere identifica o modelo pelo `capsuleID`. Duas cópias com o
 * mesmo id são, para ele, o MESMO modelo — e a segunda inserção
 * reaproveita a primeira, texto velho incluído. Cada cópia ganha um
 * id próprio, e o nome ganha a frase, para a cópia ser reconhecível
 * no painel de projeto.
 */

export interface DefinitionPatch {
  /** A frase. Quebra de linha vira retorno de carro, como o AE espera. */
  readonly text: string;
  /** Nome PostScript. Vazio mantém o do modelo. */
  readonly font?: string;
  /** Corpo em pixels. 0 mantém o do modelo. */
  readonly size?: number;
  /** O nome da cópia no painel de projeto. Vazio = nome do modelo + frase. */
  readonly label?: string;
}

/** O que o patch conseguiu tocar — para o relatório dizer a verdade. */
export interface DefinitionReport {
  readonly json: string;
  readonly capsuleName: string;
  readonly capsuleId: string;
  /** false quando o modelo não expõe controle de texto nenhum. */
  readonly textApplied: boolean;
  readonly fontApplied: boolean;
  readonly sizeApplied: boolean;
  /** Quantos campos de texto o modelo tem. 2+ divide por linha. */
  readonly textFields: number;
  /** O que foi escrito em cada campo, na ordem. */
  readonly parts: string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retorno de carro, e não `\n`: é assim que o modelo de referência guarda "smooth\rbounce". */
export function textForDefinition(text: string): string {
  return text.replace(/\r\n?|\n/g, "\r").trim();
}

/** UUID v4 sem `crypto`: o UXP não garante `crypto.randomUUID`. */
export function newCapsuleId(random: () => number = Math.random): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += "-";
    } else if (index === 14) {
      out += "4";
    } else if (index === 19) {
      out += hex[8 + Math.floor(random() * 4)];
    } else {
      out += hex[Math.floor(random() * 16)];
    }
  }
  return out;
}

/** Escreve a mesma string em todas as localizações de um `strDB`. */
function setStrDb(holder: unknown, value: string): boolean {
  if (!isObject(holder) || !Array.isArray(holder.strDB)) {
    return false;
  }
  let touched = false;
  for (const row of holder.strDB) {
    if (isObject(row) && typeof row.str === "string") {
      row.str = value;
      touched = true;
    }
  }
  return touched;
}

/** Os controles de texto: tipo 6, os únicos que carregam `fonteditinfo`. */
function textControls(definition: Json): Json[] {
  const controls = Array.isArray(definition.clientControls) ? definition.clientControls : [];
  return controls.filter(
    (control): control is Json =>
      isObject(control) && (control.type === 6 || isObject(control.fonteditinfo))
  );
}

/**
 * A frase repartida entre os campos do modelo.
 *
 * Um campo: tudo nele. Vários: uma linha para cada, e o último fica
 * com o resto — assim nenhuma palavra do editor é descartada por
 * causa de um modelo com três caixas.
 */
export function splitAcross(text: string, fields: number): string[] {
  if (fields <= 1) {
    return [text];
  }
  const lines = text.split("\r");
  return Array.from({ length: fields }, (_, index) =>
    index === fields - 1 ? lines.slice(index).join("\r") : (lines[index] ?? "")
  );
}

/** As entradas de `capParams`, em todos os idiomas, que espelham o controle. */
function capParamsFor(definition: Json, controlId: string): Json[] {
  const found: Json[] = [];
  const localized = definition.sourceInfoLocalized;
  if (!isObject(localized)) {
    return found;
  }
  for (const info of Object.values(localized)) {
    if (!isObject(info) || !isObject(info.capsuleparams)) {
      continue;
    }
    const params = info.capsuleparams.capParams;
    if (!Array.isArray(params)) {
      continue;
    }
    for (const param of params) {
      if (isObject(param) && param.capPropMatchName === controlId) {
        found.push(param);
      }
    }
  }
  return found;
}

/** Garante a fonte na lista de fontes usadas, para o Premiere resolvê-la. */
function registerFont(definition: Json, font: string): void {
  const used = definition.usedFontsLocalized;
  if (!isObject(used)) {
    return;
  }
  for (const [locale, list] of Object.entries(used)) {
    if (Array.isArray(list) && !list.includes(font)) {
      used[locale] = [...list, font];
    }
  }
}

/**
 * Aplica o patch e devolve o JSON novo.
 *
 * Um modelo sem controle de texto sai com `textApplied: false` e o
 * resto intacto — quem chama decide se ainda vale inserir.
 */
export function patchDefinition(json: string, patch: DefinitionPatch): DefinitionReport {
  const definition = JSON.parse(json) as unknown;
  if (!isObject(definition)) {
    throw new Error("definition.json não é um objeto");
  }
  const text = textForDefinition(patch.text);
  const baseName =
    typeof definition.capsuleName === "string" ? definition.capsuleName : "Modelo";
  const capsuleName =
    patch.label?.trim() || `${baseName} · ${text.replace(/\r/g, " ").slice(0, 32)}`;
  const capsuleId = newCapsuleId();

  definition.capsuleID = capsuleId;
  definition.capsuleName = capsuleName;
  setStrDb(definition.capsuleNameLocalized, capsuleName);

  let textApplied = false;
  let fontApplied = false;
  let sizeApplied = false;

  const controls = textControls(definition);
  const parts = splitAcross(text, controls.length);

  controls.forEach((control, index) => {
    const part = parts[index] ?? "";
    if (setStrDb(control.value, part)) {
      textApplied = true;
    }
    const fontInfo = isObject(control.fonteditinfo) ? control.fonteditinfo : null;
    if (fontInfo && patch.font) {
      fontInfo.fontEditValue = patch.font;
      fontApplied = true;
    }
    if (fontInfo && patch.size && patch.size > 0) {
      fontInfo.fontSizeEditValue = patch.size;
      sizeApplied = true;
    }

    const id = typeof control.id === "string" ? control.id : "";
    for (const param of capParamsFor(definition, id)) {
      if ("textEditValue" in param) {
        param.textEditValue = part;
        textApplied = true;
      }
      if ("capPropDefault" in param && typeof param.capPropDefault === "string") {
        param.capPropDefault = part;
      }
      if (Array.isArray(param.fontTextRunLength)) {
        param.fontTextRunLength = [part.length];
      }
      if ("capPropTextRunCount" in param) {
        param.capPropTextRunCount = 1;
      }
      if (patch.font && Array.isArray(param.fontEditValue)) {
        param.fontEditValue = [patch.font];
        fontApplied = true;
      }
      if (patch.size && patch.size > 0 && Array.isArray(param.fontSizeEditValue)) {
        param.fontSizeEditValue = [patch.size];
        sizeApplied = true;
      }
    }
  });
  if (fontApplied && patch.font) {
    registerFont(definition, patch.font);
  }

  return {
    json: JSON.stringify(definition),
    capsuleName,
    capsuleId,
    textApplied,
    fontApplied,
    sizeApplied,
    textFields: controls.length,
    parts,
  };
}
