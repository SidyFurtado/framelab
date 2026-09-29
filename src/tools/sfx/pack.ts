/**
 * Efeitos Sonoros — o pack, organizado.
 *
 * Tudo aqui é função pura: entra a lista de arquivos que o Drive
 * mostra, sai o catálogo que o editor vê. Nada lê disco nem rede, e
 * é por isso que a organização inteira é conferida fora do Premiere.
 *
 * ── O som diz onde mora ─────────────────────────────────────────────
 * Com o pack de 221 sons, a categoria era a pasta de primeiro nível
 * (ADR-010). O pack grande (~8.500 sons) junta bibliotecas inteiras,
 * com pastas como "SOUND EFFECTS 2" (981 sons) e "SFX 6", e a pasta
 * deixou de dizer o que o som é. Agora a categoria vem do nome do
 * arquivo e das pastas até ele (`taxonomy.ts`), e a biblioteca de origem
 * vira a etiqueta da linha.
 *
 * ── Por que os nomes são limpos ────────────────────────────────────
 * O pack real mistura cinco convenções: prefixo de loja
 * ("ES_", "Mountain Audio - "), código de catálogo ("SBA-300055968"),
 * hífen no lugar de espaço, tudo minúsculo, tudo maiúsculo. Numa lista
 * isso é ruído, e ruído é o que faz uma biblioteca parecer bagunçada
 * mesmo quando as pastas estão certas. O nome do ARQUIVO não muda —
 * só o que o painel mostra.
 *
 * ── Por que variações viram um som só ──────────────────────────────
 * "Boom 1" a "Boom 8" são oito tomadas do mesmo efeito. Listadas uma a
 * uma, empurram o resto da categoria para fora da tela; juntas, são uma
 * linha com oito números para ouvir. É também o que a futura inserção
 * automática precisa: sortear uma variação em vez de repetir a mesma.
 */

import { classify, sourceOf } from "./taxonomy";

/** O pack grande (2026-09-22): ~8.500 sons em 800 pastas, com o pack antigo dentro, na pasta "SFX". */
export const DEFAULT_PACK_ID = "1fuP4p1JRQ9TP64R2U6X4uIrAGf7pzq7N";
/** O pack antigo, de 221 sons. Quem o tinha salvo passa para o grande, que o contém. */
export const LEGACY_PACK_ID = "1vvWFLN8ZQV9kZQ1i5heLL8d5fm0gTv6p";

/** Uma linha da listagem pública de uma pasta do Drive. */
export interface DriveEntry {
  id: string;
  name: string;
  folder: boolean;
  /**
   * A data de modificação como o Drive escreve ("12/31/79").
   *
   * Não serve para ordenar nada — os arquivos vieram de um zip e
   * carregam a data dele. Serve como carimbo: quando alguém troca o
   * arquivo no Drive, o texto muda, e o cache sabe que precisa baixar
   * de novo.
   */
  stamp: string;
}

/** Um arquivo do pack, com as pastas até ele. */
export interface PackFile {
  id: string;
  /** Pastas a partir da raiz do pack. Vazio = solto na raiz. */
  folders: string[];
  name: string;
  stamp: string;
}

export interface SfxVariant {
  id: string;
  /** Nome do arquivo no Drive, como está lá. */
  file: string;
  folders: string[];
  stamp: string;
  ext: string;
}

export interface SfxSound {
  /** Estável entre atualizações: é por ele que os favoritos voltam. */
  key: string;
  name: string;
  category: string;
  variants: SfxVariant[];
  loop: boolean;
  /** Texto normalizado onde a busca procura. */
  haystack: string;
  /** A biblioteca de onde veio (Adobe Audition, Mateus Ferreira…): a etiqueta da linha. */
  source?: string;
}

export interface SfxCategory {
  id: string;
  label: string;
  /** O nome da pasta no Drive. */
  folder: string;
  order: number;
  sounds: SfxSound[];
}

export interface SfxCatalog {
  categories: SfxCategory[];
  /** Sons, já com as variações juntas. */
  sounds: number;
  /** Arquivos de áudio de verdade. */
  files: number;
}

// ── a listagem do Drive ────────────────────────────────────────────

/**
 * As linhas da página `embeddedfolderview` de uma pasta pública.
 *
 * É a página que o próprio Drive usa para embutir uma pasta num site:
 * pública, sem chave de API e sem login. Cada entrada é um
 * `<div class="flip-entry">`, e o link diz se é pasta ou arquivo.
 * Picar por entrada, em vez de uma expressão só para o documento
 * inteiro, faz uma entrada estranha perder só a si mesma.
 */
export function parseFolderView(html: string): DriveEntry[] {
  const entries: DriveEntry[] = [];
  for (const chunk of html.split('<div class="flip-entry"').slice(1)) {
    const id = /id="entry-([\w-]+)"/.exec(chunk)?.[1];
    const title = /class="flip-entry-title">([^<]*)</.exec(chunk)?.[1];
    if (!id || title === undefined) {
      continue;
    }
    const href = /<a href="([^"]*)"/.exec(chunk)?.[1] ?? "";
    const stamp = /class="flip-entry-last-modified"><div>([^<]*)</.exec(chunk)?.[1] ?? "";
    entries.push({
      id,
      name: decodeEntities(title).trim(),
      folder: href.includes("/folders/"),
      stamp: decodeEntities(stamp).trim(),
    });
  }
  return entries;
}

/**
 * true quando a resposta É uma listagem — mesmo que vazia.
 *
 * Pasta que deixou de ser pública não dá erro: o Drive responde 200
 * com a página de login. Sem esta checagem, isso virava "o pack está
 * vazio", que é a explicação errada.
 */
export function looksLikeFolderView(html: string): boolean {
  return html.includes("flip-entries");
}

/** O id de uma pasta, a partir do link que o editor colar — ou do id puro. */
export function folderIdFrom(input: string): string | null {
  const text = input.trim();
  const match =
    /\/folders\/([\w-]{10,})/.exec(text) ??
    /[?&]id=([\w-]{10,})/.exec(text) ??
    /^([\w-]{10,})$/.exec(text);
  return match ? match[1] : null;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (all, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos" || lower === "#39") return "'";
    const value = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : all;
  });
}

// ── o que é áudio ──────────────────────────────────────────────────

/**
 * Os formatos que o Premiere importa, na ordem de preferência.
 *
 * Quando o mesmo som existe em dois formatos ("Tech Message.mp3" e
 * ".wav"), fica o de cima: WAV não tem perda, e é a cópia que se quer
 * na timeline.
 */
const FORMATS = ["wav", "aif", "aiff", "m4a", "aac", "mp3", "mpeg"];

/**
 * true para um arquivo de áudio de verdade.
 *
 * O pack real traz o lixo de sempre junto: `.pek` e `.cfa` (o cache de
 * forma de onda que o Premiere escreve ao lado da mídia), `.DS_Store`,
 * e os `._arquivo` da pasta `__MACOSX` de um zip aberto no Mac — que
 * têm extensão de áudio e não são áudio.
 */
export function isAudioName(name: string): boolean {
  if (name.startsWith(".")) {
    return false;
  }
  return FORMATS.includes(extensionOf(name));
}

/** Pasta que nunca tem som: o resto de um zip aberto no Mac. */
export function isJunkFolder(name: string): boolean {
  return name === "__MACOSX" || name.startsWith(".");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// ── os nomes ───────────────────────────────────────────────────────

export interface SoundName {
  /** O nome sem o número da tomada. */
  base: string;
  /** "Boom 3" → 3. null quando o arquivo não tem número. */
  take: number | null;
  loop: boolean;
}

/** Lojas e bibliotecas que assinam o nome do arquivo. */
const VENDOR_PREFIX =
  // "(MISTER HORSE - ESSENTIAL SOUND EFFECTS) CLICK 02": the pack grande prefixa a loja entre parênteses.
  /^(?:ES_|\([^)]*(?:sound|sfx|effects|audio|horse)[^)]*\)\s*|(?:Mountain Audio|Ni Sound|LG[_ ]Sound|Filmmaking Props|VIRAL SFX|GDYN)(?:\s*-\s*|[_\s]+))/i;

const TAIL_NOISE: RegExp[] = [
  /\s*-\s*SFX Producer$/i,
  /\s*\((?:wav|mp3|aiff?)\)$/i,
  // Código de catálogo: "SDT012702", "SBA-300055968".
  /[\s_-]+[A-Z]{2,4}-?\d{5,}$/,
  /[\s_-]+sound[\s_-]+effect$/i,
  // "Counter Beeps - Sound (1)": o "Sound" não diz nada.
  /\s*-\s*Sound(?=\s*(?:\(\d+\))?$)/i,
];

/** Palavras que ficam minúsculas no meio de um nome. */
const SMALL_WORDS = new Set([
  "a", "o", "e", "de", "da", "do", "das", "dos", "na", "no", "nas", "nos",
  "em", "com", "para", "por", "of", "the", "and", "in", "on", "at", "to",
  "an", "or", "for",
]);

/**
 * O nome que o editor vê, a partir do nome do arquivo.
 *
 * A ordem importa: a loja sai antes de separar as palavras (senão
 * "ES_" vira "ES"), e o número da tomada sai por último, depois que o
 * "Loop" do fim deixou de esconder ele.
 */
export function parseSoundName(fileName: string): SoundName {
  let text = stemOf(fileName).trim();

  for (let guard = 0; guard < 4; guard += 1) {
    const next = text.replace(VENDOR_PREFIX, "");
    if (next === text) break;
    text = next;
  }
  for (let guard = 0; guard < 4; guard += 1) {
    const next = TAIL_NOISE.reduce((value, rule) => value.replace(rule, ""), text).trim();
    if (next === text) break;
    text = next;
  }

  text = text
    // "StingerCameraShut" → "Stinger Camera Shut"
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .replace(/(\S)-(?=\S)/g, "$1 ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let loop = false;
  const withoutLoop = text.replace(/\s*\bloop\b\s*/i, " ").trim();
  if (withoutLoop !== text && withoutLoop.length > 0) {
    loop = true;
    text = withoutLoop;
  }
  // "Fireball 01 Whoosh": número de catálogo no meio não é nome. Só
  // depois do loop, que é a palavra que escondia o número da tomada.
  text = text.replace(/ 0\d(?= \D)/g, "");

  let take: number | null = null;
  const numbered = /^(.*?[^\d\s(])[\s(]*(\d{1,3})\)?$/.exec(text);
  if (numbered && numbered[1].trim().length >= 2) {
    text = numbered[1].trim();
    take = Number.parseInt(numbered[2], 10);
  }

  // "Woosh" é grafia errada de "Whoosh", e o pack usa as duas.
  text = text.replace(/\b([Ww])oosh/g, (_all, w: string) => `${w}hoosh`);

  return { base: titleCase(text), take, loop };
}

/**
 * Cada palavra com maiúscula — exceto as pequenas, e exceto as que já
 * têm maiúscula no meio ("UI", "iPhone") ou são só uma sigla.
 *
 * Um nome TODO EM MAIÚSCULAS é tratado como minúsculo: gritar numa
 * lista é pior que um nome comum.
 */
function titleCase(text: string): string {
  const letters = text.replace(/[^\p{L}]/gu, "");
  const shouting = letters.length > 3 && letters === letters.toUpperCase();
  return text
    .split(" ")
    .map((word, index) => {
      if (!word) return word;
      if (shouting) {
        if (word.length <= 2) return word;
        word = word.toLowerCase();
      }
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      if (/\p{Lu}/u.test(word.slice(1))) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** Minúsculo, sem acento, só letras e números separados por espaço. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── as categorias ──────────────────────────────────────────────────

interface KnownCategory {
  label: string;
  order: number;
}

/**
 * As pastas que o pack já tem, com o nome que o editor fala.
 *
 * A chave é a pasta normalizada e sem espaço, então "Hits - impacts",
 * "hits impacts" e "HITS_IMPACTS" caem no mesmo lugar. A ordem segue o
 * uso num AD: transição e impacto primeiro, o resto depois.
 */
const KNOWN_CATEGORIES: Record<string, KnownCategory> = {
  wooshes: { label: "Whooshes", order: 1 },
  whooshes: { label: "Whooshes", order: 1 },
  woosh: { label: "Whooshes", order: 1 },
  whoosh: { label: "Whooshes", order: 1 },
  transitions: { label: "Whooshes", order: 1 },
  hitsimpacts: { label: "Impactos", order: 2 },
  hits: { label: "Impactos", order: 2 },
  impacts: { label: "Impactos", order: 2 },
  impactos: { label: "Impactos", order: 2 },
  risers: { label: "Risers", order: 3 },
  riser: { label: "Risers", order: 3 },
  ui: { label: "Interface", order: 4 },
  interface: { label: "Interface", order: 4 },
  cinematics: { label: "Cinemáticos", order: 5 },
  cinematic: { label: "Cinemáticos", order: 5 },
  cameras: { label: "Câmera", order: 6 },
  camera: { label: "Câmera", order: 6 },
  computer: { label: "Computador", order: 7 },
  computador: { label: "Computador", order: 7 },
  bells: { label: "Brilhos", order: 8 },
  diversos: { label: "Diversos", order: 90 },
  misc: { label: "Diversos", order: 90 },
};

/** Arquivos soltos na raiz do pack, fora de qualquer pasta. */
const ROOT_CATEGORY = "avulsos";

export function categoryFor(folder: string): { id: string; label: string; order: number } {
  if (!folder) {
    return { id: ROOT_CATEGORY, label: "Avulsos", order: 95 };
  }
  const key = normalize(folder).replace(/ /g, "");
  const known = KNOWN_CATEGORIES[key];
  if (known) {
    return { id: normalize(known.label).replace(/ /g, "-"), ...known };
  }
  // Pasta nova: entra com o nome dela, arrumado, antes de "Diversos".
  return { id: normalize(folder).replace(/ /g, "-") || "pasta", label: titleCase(folder.trim()), order: 50 };
}

// ── a busca ────────────────────────────────────────────────────────

/**
 * Português para as palavras que o pack usa.
 *
 * O pack é quase todo em inglês e o editor pensa em português: sem
 * esta ponte, "impacto" não acha "Boom" e "moeda" não acha "Coins".
 * Só entra aqui palavra que existe no pack de verdade.
 */
const SYNONYMS: Record<string, string[]> = {
  impacto: ["impact", "hit", "boom", "punch"],
  batida: ["hit", "punch", "impact"],
  explosao: ["explosion", "boom", "fireball"],
  clique: ["click", "select"],
  clicar: ["click", "select"],
  teclado: ["keyboard", "teclado"],
  digitar: ["keyboard", "teclado", "typing"],
  foto: ["camera", "shutter", "flash"],
  obturador: ["shutter"],
  dinheiro: ["cash", "coin"],
  grana: ["cash", "coin"],
  moeda: ["coin"],
  moedas: ["coin"],
  bolha: ["bubble"],
  bolhas: ["bubble"],
  piscada: ["wink"],
  piscar: ["wink"],
  papel: ["paper"],
  relogio: ["clock"],
  tensao: ["riser"],
  subida: ["riser"],
  brilho: ["shine", "sparkle", "shining", "magic", "bell"],
  sino: ["bell"],
  transicao: ["whoosh", "swoosh", "transition"],
  vento: ["whoosh", "swoosh"],
  notificacao: ["notification", "message", "pop"],
  celular: ["iphone", "notification"],
  erro: ["glitch", "falha"],
  falha: ["glitch", "falha"],
  tecnologia: ["tech", "digital", "hologram", "data", "sci"],
  dados: ["data"],
  jogo: ["game"],
  rebobinar: ["rebobinar", "rewind"],
  bip: ["beep", "censura"],
  estalo: ["snap", "pop"],
  corte: ["cut", "slice"],
  fogo: ["fire", "flare", "fireball"],
  sucesso: ["success", "right", "confirmation"],
  certo: ["right", "success", "confirmation"],
  engrenagem: ["gears"],
  filme: ["film", "projector", "movie"],
};

/**
 * A busca em grupos: cada palavra digitada, com os sinônimos dela.
 *
 * Todas as palavras precisam casar (E), e cada uma casa por qualquer
 * um dos sinônimos (OU). Assim "whoosh grave" estreita, em vez de
 * alargar.
 */
export function queryTerms(query: string): string[][] {
  return normalize(query)
    .split(" ")
    .filter(Boolean)
    .map((word) => [word, ...(SYNONYMS[word] ?? [])]);
}

/**
 * Casa pelo COMEÇO de uma palavra: "whoo" acha "Whooshes", mas "hit"
 * não acha "white". Substring solta faz a busca devolver lixo com
 * duas letras digitadas.
 */
export function soundMatches(sound: SfxSound, terms: string[][]): boolean {
  if (terms.length === 0) {
    return true;
  }
  const hay = ` ${sound.haystack}`;
  return terms.every((options) => options.some((option) => hay.includes(` ${option}`)));
}

// ── o catálogo ─────────────────────────────────────────────────────

interface Member {
  file: PackFile;
  parsed: SoundName;
}

/**
 * O pack inteiro, organizado.
 *
 * Dentro de cada categoria, os arquivos com o mesmo nome-base viram
 * um som com várias tomadas. O mesmo arquivo em dois formatos conta
 * uma vez, no melhor formato.
 */
export function buildCatalog(files: PackFile[]): SfxCatalog {
  const byCategory = new Map<string, { info: { id: string; label: string; order: number }; folder: string; groups: Map<string, Member[]> }>();

  for (const file of files) {
    if (!isAudioName(file.name) || file.folders.some(isJunkFolder)) {
      continue;
    }
    // Onde o som mora é o que ele é, não a pasta de onde veio (ver taxonomy.ts).
    const kind = classify(file.folders, file.name);
    const info = { id: kind.id, label: kind.label, order: kind.order };
    let bucket = byCategory.get(info.id);
    if (!bucket) {
      bucket = { info, folder: kind.label, groups: new Map() };
      byCategory.set(info.id, bucket);
    }
    const parsed = parseSoundName(file.name);
    // Tomadas do mesmo som só se juntam dentro da mesma biblioteca: "Impact 03" da Adobe e do
    // Mateus Ferreira são sons diferentes.
    const source = sourceOf(file.folders);
    const groupKey = `${normalize(source).replace(/ /g, "-")}|${normalize(parsed.base) || normalize(stemOf(file.name))}`;
    const members = bucket.groups.get(groupKey) ?? [];
    members.push({ file, parsed });
    bucket.groups.set(groupKey, members);
  }

  let fileCount = 0;
  const categories: SfxCategory[] = [];
  for (const [categoryId, bucket] of byCategory) {
    const sounds: SfxSound[] = [];
    for (const [groupKey, members] of bucket.groups) {
      const variants = pickVariants(members);
      if (variants.length === 0) continue;
      fileCount += variants.length;
      const first = members.find((member) => member.file.id === variants[0].id) ?? members[0];
      const name = first.parsed.base;
      const loop = members.some((member) => member.parsed.loop);
      const haystack = normalize(
        [
          name,
          bucket.info.label,
          ...new Set(members.flatMap((member) => member.file.folders)),
          ...members.map((member) => stemOf(member.file.name)),
          loop ? "loop" : "",
        ].join(" ")
      );
      sounds.push({
        key: `${categoryId}/${groupKey.replace(/ /g, "-")}`,
        name,
        category: categoryId,
        variants,
        loop,
        haystack,
        source: sourceOf(first.file.folders),
      });
    }
    sounds.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" }));
    categories.push({
      id: categoryId,
      label: bucket.info.label,
      folder: bucket.folder,
      order: bucket.info.order,
      sounds,
    });
  }

  categories.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, "pt-BR"));
  return {
    categories,
    sounds: categories.reduce((sum, category) => sum + category.sounds.length, 0),
    files: fileCount,
  };
}

/**
 * As tomadas de um som, em ordem, sem o mesmo arquivo duas vezes.
 *
 * "Duas vezes" é o mesmo nome de arquivo com outra extensão — e o
 * nome COMO ESTÁ no Drive, não o limpo: "Camera Shutter" e
 * "camera-shutter-sound-effect" limpam para a mesma coisa e são dois
 * sons diferentes.
 */
function pickVariants(members: Member[]): SfxVariant[] {
  const best = new Map<string, Member>();
  for (const member of members) {
    const same = normalize(stemOf(member.file.name)) + "|" + member.file.folders.join("/");
    const held = best.get(same);
    if (!held || formatRank(member.file.name) < formatRank(held.file.name)) {
      best.set(same, member);
    }
  }
  return [...best.values()]
    .sort((a, b) => {
      const ta = a.parsed.take ?? -1;
      const tb = b.parsed.take ?? -1;
      return ta - tb || a.file.name.localeCompare(b.file.name, "pt-BR", { numeric: true });
    })
    .map((member) => ({
      id: member.file.id,
      file: member.file.name,
      folders: member.file.folders,
      stamp: member.file.stamp,
      ext: extensionOf(member.file.name),
    }));
}

function formatRank(name: string): number {
  const rank = FORMATS.indexOf(extensionOf(name));
  return rank < 0 ? FORMATS.length : rank;
}

// ── o arquivo na pasta do editor ───────────────────────────────────

/** Tira do nome o que o Finder ou o Windows não aceitam num arquivo. */
function safeName(text: string): string {
  return text.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "Som";
}

/**
 * Onde uma tomada mora na pasta dos SFX: uma subpasta por categoria e
 * o nome que a lista mostra, com o número da variação quando há mais
 * de uma. É o que o editor vê no Finder na hora de arrastar um som
 * para o Premiere.
 */
export function fileNameFor(category: SfxCategory, sound: SfxSound, index: number): string {
  const variant = sound.variants[index];
  const take = sound.variants.length > 1 ? ` ${index + 1}` : "";
  return `${safeName(category.label)}/${safeName(sound.name)}${take}.${variant?.ext || "wav"}`;
}
