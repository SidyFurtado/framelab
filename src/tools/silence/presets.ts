/**
 * Corte de Silêncios — presets e limites dos parâmetros.
 *
 * Os quatro presets não são "o mesmo corte com números diferentes": cada
 * um descreve um ritmo de fala que já existe no mundo real. O agressivo
 * encosta as palavras (jump cut de YouTube), o suave só tira o ar morto
 * de uma aula. O que muda entre eles são sempre os mesmos eixos —
 * quanto de silêncio vira corte, quanto de ar sobra em volta da fala e
 * com que rigor um som solto é tratado como ruído — então os quatro
 * cabem na mesma UI e continuam ajustáveis à mão.
 */

/**
 * De onde sai a informação de "aqui tem som".
 *
 * `waveform` mede a onda de verdade, via ffmpeg — é o corte que um
 * editor espera de uma ferramenta de silêncio. `transcript` usa a
 * transcrição do Premiere: não precisa de ffmpeg, nunca corta no meio
 * de uma palavra e sabe o que é muleta, mas depende de o clipe estar
 * transcrito e herda os erros do reconhecimento.
 */
export type DetectionMode = "waveform" | "transcript";

export interface SilenceParams {
  /** Só vira corte o silêncio que passar disso (segundos). */
  minSilence: number;
  /** Ar mantido ANTES de cada bloco de fala (segundos). */
  padIn: number;
  /** Ar mantido DEPOIS de cada bloco de fala (segundos). */
  padOut: number;
  /** Nenhum trecho mantido termina menor que isso (segundos). */
  minKeep: number;
  /**
   * Remove as muletas que a transcrição marcou com a tag `filler`
   * ("né", "tipo", "hum"). É a diferença entre um corte limpo e um
   * corte de YouTube.
   */
  removeFillers: boolean;
  /**
   * Confiança mínima (0..1) para um som ILHADO contar como fala.
   * Abaixo disso é ruído que o transcritor ouviu como palavra. Zero
   * desliga. Ver `rejectNoise` em detect.ts: só afeta som cercado de
   * silêncio, nunca palavra dentro de frase.
   */
  minConfidence: number;
  /**
   * Duração (s) abaixo da qual um som ILHADO é tratado como ruído.
   * Zero desliga.
   */
  noiseIsland: number;
  /**
   * Modo onda: true calibra o limiar pelo piso de ruído medido em cada
   * clipe; false usa `dbThreshold` como número absoluto.
   */
  autoThreshold: boolean;
  /** Modo onda, automático: quantos dB acima do piso de ruído medido. */
  dbMargin: number;
  /** Modo onda, manual: limiar absoluto em dBFS. */
  dbThreshold: number;
}

export interface SilencePreset {
  readonly id: string;
  readonly name: string;
  /** Uma linha, mostrada quando o preset está ativo. */
  readonly note: string;
  readonly params: SilenceParams;
}

/**
 * Ordenados do mais agressivo para o mais conservador — a mesma ordem
 * em que aparecem no trilho, para o trilho virar uma escala e não uma
 * lista de nomes.
 */
export const SILENCE_PRESETS: readonly SilencePreset[] = [
  {
    id: "youtube",
    name: "YouTube",
    note: "Jump cut: tira todo silêncio e as muletas, e é o mais duro com ruído solto.",
    params: {
      minSilence: 0.15,
      padIn: 0.02,
      padOut: 0.04,
      minKeep: 0.1,
      removeFillers: true,
      minConfidence: 0.4,
      noiseIsland: 0.25,
      autoThreshold: true,
      dbMargin: 12,
      dbThreshold: -32,
    },
  },
  {
    id: "dinamico",
    name: "Dinâmico",
    note: "Corta as pausas mas deixa a respiração. Padrão para UGC e VSL.",
    params: {
      minSilence: 0.3,
      padIn: 0.05,
      padOut: 0.08,
      minKeep: 0.15,
      removeFillers: false,
      minConfidence: 0.3,
      noiseIsland: 0.2,
      autoThreshold: true,
      dbMargin: 10,
      dbThreshold: -35,
    },
  },
  {
    id: "natural",
    name: "Natural",
    note: "Só as pausas longas. Mantém o fôlego de entrevista e depoimento.",
    params: {
      minSilence: 0.6,
      padIn: 0.1,
      padOut: 0.15,
      minKeep: 0.25,
      removeFillers: false,
      minConfidence: 0.2,
      noiseIsland: 0.12,
      autoThreshold: true,
      dbMargin: 8,
      dbThreshold: -38,
    },
  },
  {
    id: "aula",
    name: "Aula",
    note: "Tira só o ar morto e não descarta nada como ruído. Preserva o raciocínio.",
    params: {
      minSilence: 1.2,
      padIn: 0.2,
      padOut: 0.25,
      minKeep: 0.4,
      removeFillers: false,
      minConfidence: 0,
      noiseIsland: 0,
      autoThreshold: true,
      dbMargin: 6,
      dbThreshold: -42,
    },
  },
];

export const DEFAULT_PRESET_ID = "dinamico";

export function presetById(id: string): SilencePreset | undefined {
  return SILENCE_PRESETS.find((preset) => preset.id === id);
}

/** O preset cujos números batem exatamente com estes, se houver. */
export function matchPreset(params: SilenceParams): SilencePreset | null {
  return (
    SILENCE_PRESETS.find(
      (preset) =>
        near(preset.params.minSilence, params.minSilence) &&
        near(preset.params.padIn, params.padIn) &&
        near(preset.params.padOut, params.padOut) &&
        near(preset.params.minKeep, params.minKeep) &&
        near(preset.params.minConfidence, params.minConfidence) &&
        near(preset.params.noiseIsland, params.noiseIsland) &&
        near(preset.params.dbMargin / 100, params.dbMargin / 100) &&
        near(preset.params.dbThreshold / 100, params.dbThreshold / 100) &&
        preset.params.autoThreshold === params.autoThreshold &&
        preset.params.removeFillers === params.removeFillers
    ) ?? null
  );
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

export function defaultParams(): SilenceParams {
  return { ...(presetById(DEFAULT_PRESET_ID) ?? SILENCE_PRESETS[1]).params };
}

/** Definição de cada slider: os limites vivem aqui, não no markup. */
export interface SliderSpec {
  readonly key:
    | "minSilence"
    | "padIn"
    | "padOut"
    | "minKeep"
    | "minConfidence"
    | "noiseIsland"
    | "dbMargin"
    | "dbThreshold";
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Como o valor é lido na tela. */
  readonly unit: "s" | "%" | "dB" | "dB+";
  /** Em que bloco da interface o slider aparece. */
  readonly group: "corte" | "ruido";
  /** Em que modos o slider faz sentido. */
  readonly modes: readonly DetectionMode[];
  /** Frase curta sob o slider. Explica o efeito, não repete o nome. */
  readonly note: string;
}

export function formatParam(spec: SliderSpec, value: number): string {
  switch (spec.unit) {
    case "%":
      return `${Math.round(value * 100)}%`;
    case "dB":
      return `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(0)} dB`;
    case "dB+":
      return `piso +${value.toFixed(0)} dB`;
    default:
      return `${value.toFixed(2)}s`;
  }
}

const BOTH: readonly DetectionMode[] = ["waveform", "transcript"];

export const SLIDERS: readonly SliderSpec[] = [
  {
    key: "minSilence",
    label: "Silêncio mínimo",
    min: 0.1,
    max: 3,
    step: 0.05,
    unit: "s",
    group: "corte",
    modes: BOTH,
    note: "Pausas mais curtas que isso ficam intactas. É o controle principal.",
  },
  {
    key: "padIn",
    label: "Margem antes",
    min: 0,
    max: 0.6,
    step: 0.01,
    unit: "s",
    group: "corte",
    modes: BOTH,
    note: "Ar mantido antes de cada fala. Zero encosta o corte na primeira sílaba.",
  },
  {
    key: "padOut",
    label: "Margem depois",
    min: 0,
    max: 0.8,
    step: 0.01,
    unit: "s",
    group: "corte",
    modes: BOTH,
    note: "Ar mantido depois da fala. Evita cortar a cauda da última palavra.",
  },
  {
    key: "minKeep",
    label: "Trecho mínimo",
    min: 0.05,
    max: 1.5,
    step: 0.05,
    unit: "s",
    group: "corte",
    modes: BOTH,
    note: "Nenhum pedaço mantido fica menor que isso — evita clipes de 2 frames.",
  },
  {
    key: "minConfidence",
    label: "Rejeitar ruído abaixo de",
    min: 0,
    max: 0.95,
    step: 0.05,
    unit: "%",
    group: "ruido",
    modes: ["transcript"],
    note:
      "Som isolado reconhecido com menos confiança que isso é ruído, não fala. " +
      "Suba quando um estalo no meio do silêncio estiver travando o corte. Zero desliga.",
  },
  {
    key: "noiseIsland",
    label: "Som solto até",
    min: 0,
    max: 0.6,
    step: 0.02,
    unit: "s",
    group: "ruido",
    modes: BOTH,
    note:
      "Som isolado — sem fala perto, ou na borda do clipe — mais curto que isso é " +
      "ruído. Pega tosse, batida de mesa e o estalo que o transcritor ouve como " +
      "palavra. Zero desliga.",
  },
  {
    key: "dbMargin",
    label: "Margem sobre o ruído",
    min: 3,
    max: 24,
    step: 1,
    unit: "dB+",
    group: "ruido",
    modes: ["waveform"],
    note:
      "O limiar é o piso de ruído MEDIDO em cada clipe mais esta margem — por isso " +
      "um take com ar-condicionado se calibra sozinho. Margem maior corta mais.",
  },
  {
    key: "dbThreshold",
    label: "Limiar fixo",
    min: -70,
    max: -10,
    step: 1,
    unit: "dB",
    group: "ruido",
    modes: ["waveform"],
    note:
      "Usado quando o limiar automático está desligado. Medido em banda de fala " +
      "(até 4 kHz), então chiado de banda larga lê alguns dB abaixo do medidor do " +
      "Premiere — na dúvida, use o automático.",
  },
];

export function clampParams(params: SilenceParams): SilenceParams {
  const out = { ...params };
  const fallback = defaultParams();
  for (const spec of SLIDERS) {
    const value = out[spec.key];
    // NaN walks straight through Math.min/Math.max and poisons every plan
    // downstream — a silent zero-cut with no error anywhere. The default
    // preset's own value is the honest thing to fall back to.
    out[spec.key] = Number.isFinite(value)
      ? Math.min(spec.max, Math.max(spec.min, value))
      : fallback[spec.key];
  }
  return out;
}
