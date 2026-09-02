/**
 * As formas possíveis do JSON de transcrição da Adobe.
 *
 * ── Por que existe mais de uma ─────────────────────────────────────
 * O `Transcript.importFromJSON` do Premiere não vem documentado com
 * um schema, e o painel só sabe a forma que o `exportToJSON` DEVOLVE
 * — que é lida por um parser tolerante e por isso não revela o que o
 * importador EXIGE. Resultado, medido num teste real: as 285 palavras
 * saíram certas, caíram nos clipes certos, e o host recusou a
 * importação sem dizer por quê.
 *
 * Então em vez de um palpite só, o painel tenta as formas plausíveis
 * em ordem, da mais próxima do schema publicado à mais antiga, e para
 * na primeira que o host aceitar. A que funcionar fica guardada, para
 * as próximas irem direto.
 *
 * Isto é contorno, não conhecimento. O conhecimento vem do
 * `dumpExistingTranscript`: um clipe transcrito pelo próprio Premiere
 * revela a forma exata, e aí a escada some.
 */
import type { AdobeTranscript } from "./toAdobe";

export interface SchemaShape {
  readonly id: string;
  readonly label: string;
  build(transcript: AdobeTranscript, language: string): string;
}

/**
 * As formas, da mais provável à menos.
 *
 * A ordem importa: cada tentativa é uma transação com o host, e a
 * primeira que passar encerra a busca.
 */
export const SHAPES: readonly SchemaShape[] = [
  {
    id: "v1-schema",
    label: "schema v1.0.0 com cabeçalho",
    build: (transcript, language) =>
      JSON.stringify({
        $schema: "https://schemas.adobe.com/transcript/v1.0.0",
        version: "1.0.0",
        language,
        speakers: [{ id: "s0", name: "Locutor 1" }],
        segments: transcript.segments.map((segment, index) => ({
          id: `seg${index}`,
          speakerId: "s0",
          start: segment.start,
          duration: segmentDuration(segment),
          words: segment.words.map((word, at) => ({
            id: `w${index}_${at}`,
            text: word.text,
            start: word.start,
            duration: word.duration,
            type: "word",
            confidence: word.confidence,
            tags: [],
          })),
        })),
      }),
  },
  {
    id: "v1-plain",
    label: "schema v1.0.0 mínimo",
    build: (transcript) => JSON.stringify(transcript),
  },
  {
    id: "monologues",
    label: "formato antigo (monologues)",
    build: (transcript) =>
      JSON.stringify({
        monologues: transcript.segments.map((segment) => ({
          speaker: 0,
          elements: segment.words.map((word) => ({
            type: "text",
            value: word.text,
            ts: word.start,
            end_ts: word.start + word.duration,
            confidence: word.confidence,
          })),
        })),
      }),
  },
];

function segmentDuration(segment: AdobeTranscript["segments"][number]): number {
  const words = segment.words;
  if (words.length === 0) {
    return 0;
  }
  const last = words[words.length - 1];
  return Math.max(0.01, last.start + last.duration - segment.start);
}

/**
 * A forma que já funcionou nesta máquina.
 *
 * Guardada em memória pela sessão: sem isso, cada clipe de um lote
 * refaria a escada inteira, e uma seleção de vinte clipes pagaria
 * vinte transações recusadas antes de cada acerto.
 */
let known: string | null = null;

export function rememberShape(id: string): void {
  known = id;
}

/** As formas a tentar, com a que já funcionou na frente. */
export function shapesToTry(): SchemaShape[] {
  if (!known) {
    return [...SHAPES];
  }
  const first = SHAPES.filter((shape) => shape.id === known);
  return [...first, ...SHAPES.filter((shape) => shape.id !== known)];
}
