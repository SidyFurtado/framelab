/**
 * Organizar Pastas — quantos canais o arquivo tem, segundo o projeto.
 *
 * Esta é a diferença entre locução e trilha que não é chute: narração é
 * mono, trilha comercial praticamente nunca é. O painel do Premiere já
 * mostra isso na coluna "Informações do áudio" ("44100 Hz - Compressed -
 * Mono"), então o dado existe — o que faltava era o plugin lê-lo.
 *
 * Duas fontes, nesta ordem:
 *
 * 1. XMP. `audioChannelType` é campo do esquema XMP Dynamic Media, um
 *    valor com nome próprio, não um texto montado para caber na coluna.
 * 2. Metadados de coluna. É de onde sai a coluna do painel, e serve de
 *    reserva quando o XMP do arquivo vem vazio.
 *
 * Nenhuma das duas é procurada no blob inteiro: varrer tudo atrás da
 * palavra "mono" acharia o nome de um arquivo chamado "Mono Lake.wav" e
 * arquivaria a trilha como locução. Só o valor do campo certo conta, e o
 * que não for encontrado volta null — o chamador trata null como "não
 * sei", que é diferente de "não".
 */
import type { premierepro, ProjectItem } from "@adobe/premierepro";

export type AudioChannels = "mono" | "stereo" | "multi";

/** Traduz o texto do campo, em qualquer das formas que ele aparece. */
function normalizeChannels(value: string): AudioChannels | null {
  const text = value.toLowerCase();
  if (/(^|[^a-z])mono([^a-z]|$)|monaural|1\s*(ch|canal)/.test(text)) {
    return "mono";
  }
  if (/(^|[^a-z])(stereo|st[eé]reo|est[eé]reo)([^a-z]|$)|2\s*(ch|canais)/.test(text)) {
    return "stereo";
  }
  if (/5\.1|7\.1|multi|surround/.test(text)) {
    return "multi";
  }
  return null;
}

/** `xmpDM:audioChannelType`, como elemento, atributo ou chave JSON. */
const XMP_PATTERNS: readonly RegExp[] = [
  /<[\w:.-]*audioChannelType[^>]*>([^<]{1,40})</i,
  /[\w:.-]*audioChannelType\s*=\s*["']([^"']{1,40})["']/i,
  /"[\w:.-]*audioChannelType"\s*:\s*"([^"]{1,40})"/i,
];

/** A coluna "Informações do áudio" (`Column.Intrinsic.AudioInfo`). */
const COLUMN_PATTERNS: readonly RegExp[] = [
  /<[^>]*audio\.?info[^>]*>([^<]{1,120})</i,
  /"[^"]*audio\.?info[^"]*"\s*:\s*"([^"]{1,120})"/i,
];

function firstMatch(raw: string, patterns: readonly RegExp[]): AudioChannels | null {
  for (const pattern of patterns) {
    const found = pattern.exec(raw);
    if (found?.[1]) {
      const verdict = normalizeChannels(found[1]);
      if (verdict) {
        return verdict;
      }
    }
  }
  return null;
}

export function parseChannelsFromXmp(raw: string): AudioChannels | null {
  return raw ? firstMatch(raw, XMP_PATTERNS) : null;
}

export function parseChannelsFromColumns(raw: string): AudioChannels | null {
  return raw ? firstMatch(raw, COLUMN_PATTERNS) : null;
}

/*
 * A sonda.
 *
 * A tipagem do host promete uma string e não diz o que vem dentro dela.
 * Enquanto isso não estiver confirmado num projeto de verdade, cada
 * varredura imprime uma amostra crua no console: é o que permite ajustar
 * os padrões acima para o que o Premiere realmente responde, em vez de
 * para o que a documentação sugere.
 */
const PROBE_LIMIT = 2;
const PROBE_CHARS = 1200;
let probesLeft = PROBE_LIMIT;

/** Rearma a sonda. Chamado no início de cada varredura. */
export function resetChannelProbe(): void {
  probesLeft = PROBE_LIMIT;
}

function probe(name: string, source: string, raw: string): void {
  if (probesLeft <= 0) {
    return;
  }
  probesLeft -= 1;
  console.log(
    `[Organize] sonda de metadados (${source}) de "${name}" — ` +
      `${raw.length} caracteres, primeiros ${PROBE_CHARS}:\n` +
      raw.slice(0, PROBE_CHARS)
  );
}

/**
 * Mono, estéreo ou mais — ou null quando o host não responde.
 *
 * Nunca lança: um projeto onde os metadados não abrem continua sendo
 * organizado pelos outros sinais, só que sem este.
 */
export async function readAudioChannels(
  ppro: premierepro,
  item: ProjectItem,
  name: string
): Promise<AudioChannels | null> {
  const metadata = ppro.Metadata;
  if (!metadata) {
    return null;
  }

  try {
    const raw = (await metadata.getXMPMetadata(item)) ?? "";
    probe(name, "xmp", raw);
    const verdict = parseChannelsFromXmp(raw);
    if (verdict) {
      return verdict;
    }
  } catch {
    // Sem XMP legível; a coluna ainda pode responder.
  }

  try {
    const raw = (await metadata.getProjectColumnsMetadata(item)) ?? "";
    probe(name, "colunas", raw);
    return parseChannelsFromColumns(raw);
  } catch {
    return null;
  }
}
