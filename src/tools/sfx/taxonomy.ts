/**
 * Onde cada som mora no plugin — pelo que ele É, não pela pasta de onde veio.
 *
 * O pack grande (~8.500 sons, 800 pastas) junta bibliotecas com lógicas
 * diferentes: a Adobe Audition por tema (IMPACTS, ANIMALS…), a do Mateus
 * Ferreira por tipo de design (ESSENTIAL/CLICK, SWISHES…), e coleções com
 * pastas que não dizem nada ("SOUND EFFECTS 2" com 981 sons, "SFX 6",
 * "MORE SFX"). Espelhar essas pastas seria dar ao editor o trabalho de
 * saber de cor onde cada biblioteca guardou o whoosh.
 *
 * Então cada arquivo é lido por inteiro — o nome dele e as pastas até ele
 * — e cai numa categoria de edição. Nome do arquivo pesa mais que a pasta;
 * a pasta mais funda pesa mais que as de cima; uma pasta que já é uma
 * categoria conhecida (IMPACTS, CARTOON, Wooshes) decide sozinha quando o
 * nome não diz nada. A biblioteca de origem vira a etiqueta do som.
 */

export interface Kind {
  id: string;
  label: string;
  /** Para a grade: o que a categoria tem, em poucas palavras. */
  blurb: string;
  order: number;
  /** Palavras (já normalizadas) que puxam um som para cá. */
  words: RegExp;
}

const w = (list: string): RegExp => new RegExp(`\\b(?:${list})\\b`);

/** A ordem é a do uso num AD: transição, impacto e texto primeiro. */
export const KINDS: Kind[] = [
  { id: "assinatura", label: "Assinatura Sidy", blurb: "Os seus, escolhidos a dedo", order: 0, words: /$^/ },
  { id: "whooshes", label: "Whooshes & transições", blurb: "Passagens, swishes, slides", order: 1,
    words: w("whooshe?s?|wooshe?s?|swooshe?s?|swishe?s?|swipes?|sweeps?|transitions?|transicao|transicoes|pass ?by|passby|fly ?by|flyby|air slicers?|slides?|zips?|breeze|phew|whips?|rush|spin|spins|zoom|slices?|swings?|swoops?|woop") },
  { id: "impactos", label: "Impactos & hits", blurb: "Hits, booms, punches", order: 2,
    words: w("impacts?|impacto|hits?|booms?|punch(?:es)?|punching|slams?|thuds?|stomps?|bangs?|knocks?|thumps?|smash(?:es)?|glove|stick hit|bag drop|straight hand") },
  { id: "risers", label: "Risers & tensão", blurb: "Subidas, suspense, reverses", order: 3,
    words: w("risers?|rises?|rising|build ?ups?|buildups?|uplifters?|tension|suspense|swells?|reverses?|reversed|downer") },
  { id: "cliques", label: "Cliques & interface", blurb: "Cliques, UI, teclado, bipes", order: 4,
    words: w("clicks?|clique|mouse|buttons?|ui|interface|beeps?|bleeps?|blips?|select|notifications?|notify|typing|keyboard|teclado|tecla|type ?writer|typewriter|enter|menu|hover|taps?|ticks?|toggle|switch|messages?|desativar|confirmation") },
  { id: "pops", label: "Pops & bolhas", blurb: "Pops, bolhas, puffs", order: 5,
    words: w("pops?|pop ?ups?|bubbles?|bolhas?|doinks?|puffs?|plucks?|boops?|bloops?|plops?|winks?") },
  { id: "glitch", label: "Glitch & digital", blurb: "Glitch, dados, interferência", order: 6,
    words: w("glitch(?:es|s)?|data|datamosh|mosh|circuit ?bend|circuitbend|mangl(?:ed|ing)|stutter|static|interference|interferencia|distort(?:ed|ion)?|digital|vhs|bitcrush(?:ed)?|transmission|signal|error|falha") },
  { id: "cinematicos", label: "Cinemáticos & trailer", blurb: "Braams, stingers, drones", order: 7,
    words: w("cinematic|cinematics|cinematicos?|cine|trailer|braams?|stingers?|sub ?drops?|bass ?drops?|drops?|drones?|epic|dark|horror|scary|spooky|growl|tense pulses|dramatic|choir") },
  { id: "camera", label: "Câmera & flash", blurb: "Obturador, flash, film burn", order: 8,
    words: w("cameras?|shutters?|flash(?:es)?|film ?burn|projector|polaroid|photos?|foto|obturador|rec|film") },
  { id: "brilhos", label: "Brilhos & mágica", blurb: "Shines, sparkles, sinos", order: 9,
    words: w("shines?|shining|shimmer|sparkles?|magic|magica|twinkles?|glitter|chimes?|bells?|dings?|fairy|glow|wand|zing") },
  { id: "dinheiro", label: "Dinheiro & sucesso", blurb: "Moedas, caixa, vitória", order: 10,
    words: w("cash|coins?|money|dinheiro|register|cha ?ching|ka ?ching|success|win|winner|victory|reward|level ?up|achievement|correct|right|quest") },
  { id: "cartoon", label: "Cartoon & comédia", blurb: "Boings, molas, efeitos engraçados", order: 11,
    words: w("cartoons?|comedy|funny|boings?|springs?|slide ?whistle|squeaks?|honks?|fails?|wacky|toon|comic|whistles?|emotes?") },
  { id: "pessoas", label: "Pessoas & vozes", blurb: "Respiração, risadas, plateia", order: 12,
    words: w("human|humans|people|pessoas?|voices?|vocal|breath|breaths|breathing|laughs?|laughing|screams?|crowds?|applause|claps?|clapping|cheers?|kiss|cough|sneeze|gasps?|footsteps?|steps|walk|walking|heart ?beats?|heartbeat|yells?|whispers?|baby|kids?|child|man|woman|female|male|grunt|sigh|eat|eating|drink|drinking|swallow") },
  { id: "foley", label: "Foley & objetos", blurb: "Papel, vidro, madeira, quebras", order: 13,
    words: w("paper|papel|glass|vidro|creaks?|rustles?|rattles?|clinks?|clangs?|cracks?|cloth|doors?|drawers?|keys|metal|metallic|wood|wooden|plastic|bottles?|cups?|zipper|chairs?|books?|pages?|crash(?:es)?|break|breaks|breaking|shatter|debris|scrape|rub|shake|pencil|drawing|crumble|flip") },
  { id: "ambientes", label: "Ambientes", blurb: "Ambiência, cidade, salas", order: 14,
    words: w("ambiences?|ambiance|ambient|room ?tone|atmos|atmosphere|city|street|traffic|office|restaurant|cafe|park|mall|market|interior|exterior") },
  { id: "natureza", label: "Natureza & clima", blurb: "Chuva, vento, água, trovão", order: 15,
    words: w("weather|rain|raining|thunder|storms?|wind|windy|water|agua|ocean|sea|waves?|river|stream|nature|natureza|forest|splash|drip|underwater|lightening|lightning") },
  { id: "fogo", label: "Fogo & explosões", blurb: "Fogo, explosões, fogos", order: 16,
    words: w("fire|fogo|flames?|burn(?:ing)?|explosions?|explosoes|explosao|blasts?|detonat\\w*|fireworks?|fireballs?|match fire|flare") },
  { id: "tecnologia", label: "Tecnologia & máquinas", blurb: "Máquinas, sci-fi, veículos", order: 17,
    words: w("technology|tech|machines?|robots?|computer|phone|iphone|telefone|servo|motor|engines?|mechanical|gears?|electric|electricity|power ?ups?|power ?downs?|scanner|holograms?|sci ?fi|scifi|laser|beams?|spaceship|cars?|vehicles?|truck|motorcycle|train|plane|helicopter|radar|clock|ticking") },
  { id: "animais", label: "Animais", blurb: "Bichos de todo tipo", order: 18,
    words: w("animals?|dogs?|cats?|birds?|horses?|cows?|lions?|pigs?|sheep|chickens?|ducks?|monkeys?|wolf|wolves|bark|barking|meow|chirp|roar|insects?|bees?|frogs?|elephant|goat|rooster") },
  { id: "esportes", label: "Esportes", blurb: "Bolas, torcida, jogos", order: 19,
    words: w("sports?|balls?|basketball|basket|soccer|football|tennis|golf|baseball|stadium|bowling|boxing|referee|skate|hockey") },
  { id: "alarmes", label: "Alarmes & emergência", blurb: "Sirenes, alarmes, alertas", order: 20,
    words: w("emergency|sirens?|alarms?|alerts?|police|ambulance|warning|buzzer|censura|bleep censor") },
  { id: "games", label: "Games & armas", blurb: "Armas, loot, arcade", order: 21,
    words: w("games?|gaming|fortnite|shotguns?|sniper|snipers|guns?|gunshots?|rifles?|pistols?|reload|weapons?|arma|loot|kill|elimination|revive|shield|health|victory royale|fall dmg|8 ?bit|retro|arcade|laser gun|shots?|shoot|shooting|grenades?|launchers?|missiles?|smg|equip|pickup|scope|bolt|knife|sword|stab|ricochet|hitmarker|headshot|ammo|bullets?|shells?|trigger|grappler|batarang|scythe|sycthe|die") },
  { id: "memes", label: "Memes & bordões", blurb: "Bordões, virais, MLG", order: 23,
    words: w("memes?|mlg|bruh|nope|oof|yeet|wow|spongebob|vine|airhorn|air horn|sad violin|hell no|you suck|emotional damage|surprise|zoidberg|few moments later|not finished|never done|clean af|bizniss|oh no|what|damn") },
  { id: "musical", label: "Percussão & musical", blurb: "Bateria, pratos, instrumentos", order: 22,
    words: w("drums?|drum hits?|cymbals?|percussion|percs?|snare|toms?|bass|instruments?|piano|guitar|synth|notes?|chords?|orchestra|strings|juno|samples of") },
  { id: "diversos", label: "Diversos", blurb: "O que não se encaixou", order: 90, words: /$^/ },
];
const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

/** Pastas que já são uma categoria: decidem quando o nome do arquivo não diz nada. */
const FOLDER_KINDS: Record<string, string> = {
  "01 sfx assinatura sidy": "assinatura",
  wooshes: "whooshes", whooshes: "whooshes", swishes: "whooshes", transition: "whooshes", "whoosh sfx pack": "whooshes",
  "motion design": "whooshes", velocity: "whooshes",
  "hits impacts": "impactos", impacts: "impactos", "impact sounds": "impactos", hit: "impactos", "punching percussion": "impactos",
  risers: "risers",
  ui: "cliques", computer: "cliques", "editing sfx": "cliques",
  bells: "brilhos",
  cameras: "camera",
  cinematics: "cinematicos", "cinematic sound effects": "cinematicos", drones: "cinematicos", "trailer construction lite version": "cinematicos",
  "ambience 1": "ambientes", "ambience 2": "ambientes",
  animals: "animais",
  cartoon: "cartoon", "emote sfx": "cartoon",
  crashes: "foley", "sons abstratos": "foley", papel: "foley", vidro: "foley",
  "emergency effects": "alarmes",
  "fire and explosions": "fogo", explosoes: "fogo",
  sports: "esportes",
  technology: "tecnologia", machines: "tecnologia",
  weather: "natureza", natureza: "natureza", agua: "natureza", storm: "natureza",
  "human elements": "pessoas", pessoas: "pessoas",
  "glitch volume 01": "glitch", "more glitches": "glitch", "glitches e interferencia": "glitch", "mangling audio": "glitch",
  "data mosh hits": "glitch", "data mosh loops": "glitch", "experimental glitch hits one shots": "glitch", signal: "glitch",
  fortnite: "games", elimination: "games", kill: "games", "fall dmg": "games", "pump shotgun sounds": "games", "tac shotgun": "games",
  snipers: "games", revive: "games", shield: "games", health: "games", "loot sounds": "games", "victory royale": "games",
  drums: "musical", "instruments multi samples": "musical", "beefy field percs one shots": "musical", "alpha juno vhs one shots": "musical",
  "sound effects 2": "games", explosives: "fogo", "assault rifles": "games", smg: "games", pistols: "games", shotguns: "games",
  ricochet: "games", pickup: "games", ads: "games", grappler: "games",
  "more sfx lordsse": "memes", "popular sfx lordsse": "memes", mlg: "memes",
  "efeitos sonoros vinhetas": "cinematicos",
};

const WEAK_FOLDERS = new Set(["more sfx lordsse", "popular sfx lordsse", "sound effects 2", "emote sfx"]);

export const normalizeTaxon = (s: string): string =>
  // "CineRiser1" is two words and a take: split the joins before folding case.
  s.replace(/([a-z])([A-Z])/g, "$1 $2").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\(\d+\)/g, " ").replace(/\.[a-z0-9]{2,4}$/, "").replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ").trim();

/** Bibliotecas conhecidas, pelo nome da pasta de cima: a etiqueta que acompanha cada som. */
const SOURCES: Array<[RegExp, string]> = [
  [/adobe audition/, "Adobe Audition"],
  [/mateus ferreira|designer sound fx/, "Mateus Ferreira"],
  [/sfx library collection/, "SFX Library Collection"],
  [/negativist/, "Negativist Audio"],
  [/assinatura/, "Assinatura Sidy"],
  [/outros sfx/, "Outros"],
];
export function sourceOf(folders: readonly string[]): string {
  const joined = folders.map(normalizeTaxon).join(" / ");
  return SOURCES.find(([pattern]) => pattern.test(joined))?.[1] ?? (folders.length ? "Pack SFX" : "Pack");
}

/**
 * A categoria de um arquivo. Nome pesa 5, a pasta mais funda 2, as outras 1;
 * uma pasta que é categoria conhecida soma 4 (2,5 se for coleção genérica) —
 * a mais funda vence. Empate: a categoria que vem antes na grade.
 */
export function classify(folders: readonly string[], name: string): Kind {
  const score = new Map<string, number>();
  const add = (id: string, points: number): void => { score.set(id, (score.get(id) ?? 0) + points); };
  const file = normalizeTaxon(name);
  const path = folders.map(normalizeTaxon);
  if (path.some((p) => FOLDER_KINDS[p] === "assinatura")) return BY_ID.get("assinatura")!;
  let named = false;
  for (const kind of KINDS) {
    // The file name names the sound: it outweighs any folder.
    if (kind.words.test(` ${file} `)) { add(kind.id, 5); named = true; }
    path.forEach((p, i) => { if (kind.words.test(` ${p} `)) add(kind.id, i === path.length - 1 ? 2 : 1); });
  }
  // A folder that is a known category decides only when the name is silent.
  for (let i = named ? -1 : path.length - 1; i >= 0; i--) {
    const direct = FOLDER_KINDS[path[i]];
    // A collection folder (memes, a game's sound bank) only speaks when the file name does not.
    if (direct) { add(direct, (WEAK_FOLDERS.has(path[i]) ? 2.5 : 4) + i * 0.01); break; }
  }
  let best: string | null = null, top = 0;
  for (const [id, points] of score) if (points > top || (points === top && best && BY_ID.get(id)!.order < BY_ID.get(best)!.order)) { best = id; top = points; }
  return BY_ID.get(best ?? "diversos")!;
}

export const kindById = (id: string): Kind | undefined => BY_ID.get(id);
