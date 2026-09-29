/**
 * Efeitos Sonoros — a ferramenta.
 *
 * A biblioteca de SFX da equipe, dentro do Premiere: o pack mora numa
 * pasta pública do Drive, e o painel mostra ele organizado por
 * categoria, com busca e prévia. Clicou, ouviu.
 *
 * ── Pôr na timeline, de dois jeitos ────────────────────────────────
 *   • o botão + da linha (ou "Inserir na agulha", para o escolhido)
 *     põe o som na agulha, na primeira trilha de áudio livre (ver
 *     `insert.ts`);
 *   • arrastar a linha e soltar na timeline, onde o editor quiser —
 *     o arrasto oficial da Adobe para painéis UXP (ver `onDragStart`).
 *     Só a partir do Premiere 27: no 26.5 a timeline recusa.
 * Os dois precisam do arquivo na pasta dos SFX: o Premiere importa por
 * referência, e a cópia temporária da prévia é apagada.
 *
 * ── O pack fica no Drive — ou na pasta que o editor escolher ───────
 * Sem pasta escolhida, o som vem do Drive na hora de ouvir e não fica
 * guardado no computador — foi pedido assim (ver `preview.ts`). Com uma
 * pasta, tudo que vai para o disco vai para ELA (ver `folder.ts`): o
 * "Baixar o pack" do botão principal, e cada som ouvido, que fica
 * salvo lá e da segunda vez toca do disco.
 *
 * ── Organizado em cartões ──────────────────────────────────────────
 * A ferramenta abre nas categorias, um cartão por pasta do pack, com o
 * que tem dentro. A lista de sons é de uma categoria por vez; a busca
 * atravessa todas.
 *
 * ── Som novo é arquivo novo no Drive ───────────────────────────────
 * A lista vem da pasta, não do build. Quem cuida do pack sobe um
 * arquivo na categoria certa, e ele aparece aqui na próxima
 * atualização — sem versão nova do plugin.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL, escapeHtml } from "../../shell/controls";
import { sfxSettings as settings, SFX_DEFAULTS as DEFAULTS, type SfxSettings } from "./config";
import { describe, readText, shellModule, uxpModule, workspace, write } from "../silence/workspace";
import { crawlPack } from "./drive";
import { insertAtPlayhead } from "./insert";
import { nativeFileOf } from "./native";
import {
  claimSync,
  drainSync,
  stopSyncJob,
  type SyncJob,
} from "./syncJob";
import {
  buildCatalog,
  fileNameFor,
  folderIdFrom,
  queryTerms,
  soundMatches,
  type SfxCatalog,
  type SfxCategory,
  type SfxSound,
  type SfxVariant,
} from "./pack";
import { playUrl, prime, probeDuration, setHost, stopPlayback, warmPlayer } from "./player";
import { kindById } from "./taxonomy";
import { isNearby, previewSource, remember, silenceUrl, warmSilence, type PreviewSource } from "./preview";
import {
  BACK_ICON,
  categoryIcon,
  EQ_ICON,
  FOLDER_ICON,
  INSERT_ICON,
  PLAY_ICON,
  REFRESH_ICON,
  SEARCH_ICON,
  SPIN_ICON,
  starIcon,
} from "./icons";
import { folderLabel, forgetOpenFolders } from "./folder";
import { destinationOf, pickAndSave, readDestination } from "../../bridge/destination";
import {
  clearCopy,
  copiedFile,
  copyToDisk,
  copyUsage,
  forgetCopy,
  knownSeconds,
  loadManifest,
  localState,
  plannedFile,
  readSnapshot,
  rememberSeconds,
  setFolder,
  writeSnapshot,
  type PackSnapshot,
} from "./store";
import { guardCaret } from "./caretGuard";

/** O relatório do arrasto para a timeline, na pasta de dados. */
const DRAG_REPORT = "sfx-drag-report.txt";

/**
 * O Premiere aceita soltar na timeline o que vem de um painel UXP?
 *
 * Só a partir do 27. No 26.5.1 o arrasto começa e a timeline recusa
 * (`dropEffect=none`, o cursor de proibido — relatório do editor,
 * 2026-09-22): o recurso está atrás de um beta desligado. Oferecer o
 * arrasto ali seria oferecer um gesto que nunca funciona; quando o
 * Premiere for atualizado, ele aparece sozinho.
 */
function timelineAcceptsDrop(): boolean {
  const version = uxpModule<{ host?: { version?: string } }>("uxp")?.host?.version ?? "";
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major >= 27;
}

/** Depois disto, reabrir a ferramenta pergunta ao Drive de novo. */
const REFRESH_MS = 10 * 60 * 1000;
/** Downloads simultâneos na cópia offline. */
const SYNC_PARALLEL = 3;

/** Os cartões de categoria — o começo da ferramenta. */
const VIEW_HOME = "inicio";
const VIEW_FAVORITES = "favoritos";

// ── o estado que sobrevive à troca de ferramenta ───────────────────
//
// A listagem e o download do pack moram fora do `mount`: sair para o
// Zoom no meio de um download de 90 MB não pode jogar o download fora,
// e voltar não pode pedir a listagem ao Drive de novo.

let snapshot: PackSnapshot | null = null;
let catalog: SfxCatalog | null = null;
/** Assinatura da listagem: ids e carimbos. Igual = nada a redesenhar. */
let signature = "";
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;
let refreshError: string | null = null;

let sync: SyncJob | null = null;
/** O `mount` que estiver na tela, avisado quando algo de fora muda. */
const listeners = new Set<() => void>();
/** O que o `mount` na tela precisa largar ao sair. */
let teardown: (() => void) | null = null;
/** A leitura do Drive em andamento: o pack grande tem 800 pastas, e a espera precisa ter número. */
let crawlProgress: { folders: number; files: number } | null = null;

/**
 * Para o download em curso e redesenha.
 *
 * `stopSyncJob` devolve se havia mesmo algo de pé: cancelar duas vezes,
 * ou cancelar um job que já terminou, não redesenha à toa.
 */
function haltSync(): void {
  if (stopSyncJob(sync)) {
    notify();
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (cause) {
      console.error("[Efeitos] falha ao redesenhar:", cause);
    }
  }
}

function adopt(files: PackSnapshot): void {
  snapshot = files;
  catalog = buildCatalog(files.files);
  signature = files.files
    .map((file) => `${file.id}:${file.stamp}:${file.folders.join("/")}/${file.name}`)
    .sort()
    .join("|");
}

/** Pergunta ao Drive o que tem no pack. Uma pergunta por vez. */
function refreshPack(rootId: string): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    refreshError = null;
    notify();
    try {
      crawlProgress = { folders: 0, files: 0 };
      let told = 0;
      const files = await crawlPack(rootId, (folders, found) => {
        crawlProgress = { folders, files: found };
        // Um redesenho a cada leva de pastas, não a cada pasta.
        if (folders - told >= 20) { told = folders; notify(); }
      });
      if (files.length === 0) {
        throw new Error("a pasta do pack não tem nenhum áudio");
      }
      const next: PackSnapshot = { rootId, fetchedAt: Date.now(), files };
      adopt(next);
      await writeSnapshot(next);
    } catch (cause) {
      refreshError = describe(cause);
      console.warn("[Efeitos] atualização do pack falhou:", cause);
    } finally {
      lastRefresh = Date.now();
      refreshing = null;
      crawlProgress = null;
      notify();
    }
  })();
  return refreshing;
}

interface Take {
  category: SfxCategory;
  sound: SfxSound;
  index: number;
}

function allTakes(from: SfxCatalog): Take[] {
  return from.categories.flatMap((category) =>
    category.sounds.flatMap((sound) =>
      sound.variants.map((_variant, index) => ({ category, sound, index }))
    )
  );
}

function allVariants(from: SfxCatalog): SfxVariant[] {
  return from.categories.flatMap((category) => category.sounds.flatMap((sound) => sound.variants));
}

/**
 * Baixa para a pasta dos SFX o que falta do pack.
 *
 * Só roda quando o editor escolheu uma pasta e pediu. Três por vez: o Drive corta
 * quem pede demais em paralelo, e três já enchem a banda de um
 * escritório. A duração de cada som é lida logo depois de gravar, para
 * a lista mostrá-la sem ninguém ter ouvido.
 */
async function runSync(from: SfxCatalog, categoryId?: string): Promise<void> {
  /*
   * A guarda é adquirida AQUI, no ponto central, e não em quem chama.
   *
   * `downloadCategory` pergunta antes de abrir o seletor de pasta — um
   * `await` que dura o tempo que o editor quiser —, e voltava de lá
   * chamando `runSync` sem perguntar de novo. A pergunta e a posse
   * acontecem juntas dentro de `claimSync`, sem nada entre elas que
   * ceda o controle; as guardas de fora continuam, mas só pela
   * interface. Ver `syncJob.ts`.
   */
  const job = claimSync(sync, (novo) => {
    sync = novo;
  });
  if (!job) {
    return;
  }

  const queue = allTakes(from).filter(({ category, sound, index }) =>
    (!categoryId || category.id === categoryId) && localState(sound.variants[index]) === "drive");
  job.total = queue.length;
  notify();

  /*
   * A identidade do próprio objeto é o token: enquanto `sync` for este
   * job, ele manda; quando deixar de ser, nada do que ele fizer pode
   * alcançar a tela nem a guarda do job que entrou no lugar.
   */
  try {
    await drainSync(job, {
      workers: SYNC_PARALLEL,
      next: () => queue.shift(),
      current: () => sync === job,
      tick: notify,
      run: async (take, signal) => {
        const variant = take.sound.variants[take.index];
        const local = await copyToDisk(
          variant,
          fileNameFor(take.category, take.sound, take.index),
          signal
        );
        if (local.kind === "empty") {
          job.empty += 1;
        } else {
          job.bytes += local.bytes;
          if (knownSeconds(variant) === null) {
            rememberSeconds(variant, await probeDuration(local.url));
          }
        }
      },
    });
  } finally {
    /*
     * Rede de segurança: se `drainSync` estourar, a guarda não pode
     * ficar presa — seria a ferramenta inteira inerte até recarregar, o
     * defeito que o P2-13 acabou de tirar. No caminho normal ela já
     * caiu, e isto não faz nada.
     */
    if (sync === job && job.running) {
      job.running = false;
      notify();
    }
  }
}

// ── formatação ─────────────────────────────────────────────────────

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 10) return `${seconds.toFixed(1).replace(".", ",")} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",")} MB`;
}

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "ontem" : `há ${days} dias`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ── as categorias, para os cartões ─────────────────────────────────

/**
 * Uma linha dizendo o que tem em cada pasta do pack.
 *
 * O nome da categoria ("Brilhos", "Diversos") não conta o que tem
 * dentro; o cartão conta. Pasta nova no Drive entra sem linha, e tudo
 * bem: o nome dela é o que o editor escreveu.
 */
/** Linhas por vez na lista e nos resultados. */
const PAGE_SIZE = 80;
/** Acima disto, "Baixar" o pack pede confirmação. */
const CONFIRM_ABOVE = 400;

const BLURBS: Record<string, string> = {
  whooshes: "Transições e passagens",
  impactos: "Booms e batidas",
  risers: "Subidas de tensão",
  interface: "Cliques, pops e telas",
  cinematicos: "Acentos de trailer",
  camera: "Obturador, flash e filme",
  computador: "Teclado e mouse",
  brilhos: "Shine, sino e mágica",
  diversos: "Moedas, bolhas, relógio…",
};

// ── a ferramenta ───────────────────────────────────────────────────

export const sfxTool: Tool = {
  id: "sfx",
  name: "Efeitos Sonoros",
  summary: "O pack de SFX da equipe, organizado e com prévia",
  hint:
    "O pack de efeitos do Drive da equipe (~8.500 sons), organizado pelo tipo de som, com a biblioteca de origem em cada linha. Clique num som para " +
    "ouvir. Sem pasta escolhida, o som vem do Drive e não fica no computador; com " +
    "uma pasta, cada som ouvido, o “Baixar” de uma categoria e o do pack inteiro vão para ela, uma subpasta por categoria. Os números tocam " +
    "cada variação e ↑ ↓ passeiam pela lista ouvindo. Som novo na pasta do Drive " +
    "aparece aqui ao atualizar, sem versão nova do plugin.",
  category: "audio",
  glyph: "sfx",
  available: true,
  usesSelection: false,

  mount(container: HTMLElement, context: ToolContext): void {
    const warm = settings.peek();
    const saved = warm ?? DEFAULTS;
    const config: SfxSettings = { ...saved, favorites: [...saved.favorites] };
    let alive = true;
    let query = "";
    let selectedKey: string | null = null;
    /** A variação escolhida de cada som, para voltar a ela. */
    const chosen = new Map<string, number>();
    let playing: { key: string; take: number } | null = null;
    let loading: { key: string; take: number } | null = null;
    /** Um som indo para a timeline; o botão espera ele terminar. */
    let inserting = false;
    /** Apaga o arquivo temporário da prévia que está na tela. */
    let release: (() => void) | null = null;
    /** Cada clique ganha um número; respostas de cliques velhos morrem. */
    let ticket = 0;
    /** Os sons na ordem da tela — é por ela que ↑ ↓ andam. */
    let visible: SfxSound[] = [];
    const rows = new Map<string, HTMLElement>();
    let drawnSignature = "";
    let lastSyncRunning = false;
    /** Quantas linhas a lista mostra agora: o pack grande tem categorias de mais de mil sons. */
    let limit = PAGE_SIZE;
    /** "Baixar" o pack inteiro pede um segundo clique: são milhares de arquivos. */
    let armedUntil = 0;

    container.innerHTML = markup(config);

    const dotEl = container.querySelector<HTMLElement>("[data-pack-dot]");
    const metaEl = container.querySelector<HTMLElement>("[data-pack-meta]");
    const refreshEl = container.querySelector<HTMLElement>("[data-refresh]");
    const queryEl = container.querySelector<HTMLInputElement>("[data-query]");
    const clearEl = container.querySelector<HTMLElement>("[data-clear]");
    const bodyEl = container.querySelector<HTMLElement>("[data-body]");
    const packInputEl = container.querySelector<HTMLInputElement>("[data-pack-input]");
    const packUseEl = container.querySelector<HTMLElement>("[data-pack-use]");
    const packNoteEl = container.querySelector<HTMLElement>("[data-pack-note]");
    const advToggleEl = container.querySelector<HTMLElement>("[data-adv-toggle]");
    const advContentEl = container.querySelector<HTMLElement>("[data-adv-content]");
    const advIconEl = container.querySelector<HTMLElement>("[data-adv-icon]");
    const stageEl = container.querySelector<HTMLElement>("[data-stage]");
    setHost(stageEl);
    void warmSilence();
    void warmPlayer();
    const folderTextEl = container.querySelector<HTMLElement>("[data-folder-text]");
    const folderActEl = container.querySelector<HTMLElement>("[data-folder-act]");
    const folderPathEl = container.querySelector<HTMLElement>("[data-folder-path]");
    const folderPickEl = container.querySelector<HTMLElement>("[data-folder-pick]");
    const folderInfoEl = container.querySelector<HTMLElement>("[data-folder-info]");
    const folderOpenEl = container.querySelector<HTMLElement>("[data-folder-open]");
    const folderClearEl = container.querySelector<HTMLElement>("[data-folder-clear]");
    const folderDropEl = container.querySelector<HTMLElement>("[data-folder-drop]");

    function persist(): void {
      settings.save({ ...config, favorites: [...config.favorites] });
    }

    function categoryById(id: string): SfxCategory | undefined {
      return catalog?.categories.find((category) => category.id === id);
    }

    function findSound(key: string | null): SfxSound | undefined {
      if (!key || !catalog) return undefined;
      for (const category of catalog.categories) {
        const found = category.sounds.find((sound) => sound.key === key);
        if (found) return found;
      }
      return undefined;
    }

    function isFavorite(sound: SfxSound): boolean {
      return config.favorites.includes(sound.key);
    }

    function favorites(): SfxSound[] {
      return catalog?.categories.flatMap((category) => category.sounds.filter(isFavorite)) ?? [];
    }

    /**
     * Onde o editor está: nos cartões, numa categoria ou nos favoritos.
     * Uma categoria que sumiu do Drive (pasta renomeada) volta ao início.
     */
    function currentView(): string {
      if (config.view === VIEW_FAVORITES) {
        return favorites().length > 0 ? VIEW_FAVORITES : VIEW_HOME;
      }
      return categoryById(config.view) ? config.view : VIEW_HOME;
    }

    // ── a linha do pack ──────────────────────────────────────────

    function renderPack(): void {
      if (!dotEl || !metaEl) return;
      const state = refreshing ? "is-busy" : refreshError ? "is-error" : catalog ? "is-live" : "";
      dotEl.className = `sfx-dot ${state}`.trim();
      metaEl.title = refreshError ?? "";

      if (!catalog) {
        metaEl.textContent = refreshing
          ? crawlProgress && crawlProgress.folders > 0
            ? `Lendo o pack no Drive · ${crawlProgress.folders} pastas · ${crawlProgress.files} sons…`
            : "Conectando ao Drive…"
          : refreshError
            ? "O pack não abriu"
            : "Pack do Drive";
        return;
      }
      const when = refreshing
        ? crawlProgress && crawlProgress.folders > 0 ? `atualizando · ${crawlProgress.folders} pastas lidas…` : "atualizando…"
        : refreshError
          ? `sem conexão · lista de ${ago(snapshot?.fetchedAt ?? 0)}`
          : `atualizado ${ago(snapshot?.fetchedAt ?? lastRefresh)}`;
      metaEl.textContent = `Drive · ${plural(catalog.sounds, "som", "sons")} · ${when}`;
    }

    // ── o miolo: cartões, lista ou resultados ────────────────────

    function matching(sounds: SfxSound[]): SfxSound[] {
      const terms = queryTerms(query);
      return terms.length === 0 ? sounds : sounds.filter((sound) => soundMatches(sound, terms));
    }

    function tileHtml(id: string, label: string, blurb: string, count: number, icon: string): string {
      return (
        `<div class="sfx-tile" ${CONTROL} data-open="${escapeHtml(id)}">` +
        `<span class="sfx-tile-head"><span class="sfx-tile-icon">${icon}</span>` +
        `<span class="sfx-tile-count">${count}</span></span>` +
        `<span class="sfx-tile-name">${escapeHtml(label)}</span>` +
        (blurb ? `<span class="sfx-tile-blurb">${escapeHtml(blurb)}</span>` : "") +
        "</div>"
      );
    }

    function homeHtml(from: SfxCatalog): string {
      const tiles: string[] = [];
      const favs = favorites();
      if (favs.length > 0) {
        tiles.push(tileHtml(VIEW_FAVORITES, "Favoritos", "Os que você marcou", favs.length, starIcon(true)));
      }
      for (const category of from.categories) {
        tiles.push(
          tileHtml(category.id, category.label, kindById(category.id)?.blurb ?? BLURBS[category.id] ?? "", category.sounds.length, categoryIcon(category.id))
        );
      }
      return `<div class="sfx-tiles">${tiles.join("")}</div>`;
    }

    function headingHtml(label: string, count: number, icon: string, category?: SfxCategory): string {
      // A categoria inteira para a pasta dos SFX, numa subpasta com o nome dela.
      const missing = category
        ? category.sounds.reduce((n, sound) => n + sound.variants.filter((v) => localState(v) === "drive").length, 0)
        : 0;
      const get = category && missing > 0 && !sync?.running
        ? `<span class="sfx-action is-small" ${CONTROL} data-get-category="${escapeHtml(category.id)}" ` +
          `title="Para ${escapeHtml(config.folder ? folderLabel(config.folder) : "a pasta que você escolher")}/${escapeHtml(label)}">` +
          `Baixar ${plural(missing, "som", "sons")}</span>`
        : "";
      return (
        '<div class="sfx-heading">' +
        `<span class="sfx-back" ${CONTROL} data-home title="Voltar às categorias">${BACK_ICON}</span>` +
        `<span class="sfx-heading-icon">${icon}</span>` +
        `<span class="sfx-heading-name">${escapeHtml(label)}</span>` +
        `<span class="sfx-heading-count">${plural(count, "som", "sons")}</span>` +
        get +
        "</div>"
      );
    }

    /** O fim de uma lista cortada: quantos faltam, e o botão que traz mais. */
    function moreHtml(rest: number): string {
      return rest > 0
        ? `<div class="sfx-more"><span class="sfx-action" ${CONTROL} data-more>Mostrar mais ${Math.min(PAGE_SIZE, rest)}</span>` +
          `<span class="sfx-more-count">faltam ${rest}</span></div>`
        : "";
    }

    function sectionHtml(label: string, count: number): string {
      return (
        '<div class="sfx-section">' +
        `<span>${escapeHtml(label)}</span><span class="sfx-section-count">${count}</span>` +
        "</div>"
      );
    }

    function rowHtml(sound: SfxSound): string {
      const active = sound.key === selectedKey;
      const states = sound.variants.map(localState);
      const allEmpty = states.every((state) => state === "empty");
      const count = sound.variants.length;
      const take = Math.min(chosen.get(sound.key) ?? 0, count - 1);
      const seconds = knownSeconds(sound.variants[take]);
      const classes = ["sfx-row"];
      if (active) classes.push("is-active");
      if (allEmpty) classes.push("is-empty");
      if (playing?.key === sound.key) classes.push("is-playing");
      if (loading?.key === sound.key) classes.push("is-loading");
      const fav = isFavorite(sound);

      const badges =
        (count > 1 ? `<span class="sfx-badge" title="${count} variações">×${count}</span>` : "") +
        (sound.source && sound.source !== "Pack SFX" ? `<span class="sfx-src" title="Biblioteca de origem">${escapeHtml(sound.source)}</span>` : "") +
        (sound.loop ? '<span class="sfx-badge is-accent">loop</span>' : "") +
        (allEmpty ? '<span class="sfx-badge is-warn">vazio no Drive</span>' : "");

      const takes =
        active && count > 1
          ? '<span class="sfx-takes">' +
            sound.variants
              .map((variant, index) => {
                const busy = playing ?? loading;
                const on = busy?.key === sound.key ? busy.take === index : index === take;
                const empty = states[index] === "empty";
                return (
                  `<span class="sfx-take${empty ? " is-empty" : ""}" role="button" tabindex="-1" ` +
                  `data-take="${index}" aria-pressed="${on ? "true" : "false"}" ` +
                  `title="${escapeHtml(variant.file)}${empty ? " — vazio no Drive" : ""}">${index + 1}</span>`
                );
              })
              .join("") +
            "</span>"
          : "";

      return (
        `<div class="${classes.join(" ")}" data-row="${escapeHtml(sound.key)}"${canDrag ? ' draggable="true"' : ""} ` +
        `role="button" tabindex="0" aria-label="Ouvir ${escapeHtml(sound.name)}">` +
        `<span class="sfx-play" aria-hidden="true">${PLAY_ICON}${EQ_ICON}${SPIN_ICON}</span>` +
        '<span class="sfx-main">' +
        `<span class="sfx-line"><span class="sfx-name">${escapeHtml(sound.name)}</span>${badges}</span>` +
        takes +
        "</span>" +
        `<span class="sfx-dur" data-dur>${formatSeconds(seconds)}</span>` +
        (allEmpty
          ? ""
          : `<span class="sfx-put" role="button" tabindex="-1" data-insert title="Inserir">${INSERT_ICON}</span>`) +
        `<span class="sfx-fav${fav ? " is-on" : ""}" role="button" tabindex="-1" data-fav ` +
        `aria-pressed="${fav ? "true" : "false"}" title="${fav ? "Tirar dos favoritos" : "Favoritar"}">` +
        `${starIcon(fav)}</span>` +
        '<span class="sfx-progress" data-progress></span>' +
        "</div>"
      );
    }

    function ghostHtml(): string {
      return (
        '<div class="sfx-tiles">' +
        Array.from({ length: 6 }, () => '<div class="sfx-tile is-ghost"><span></span><span></span></div>').join("") +
        "</div>"
      );
    }

    const canDrag = timelineAcceptsDrop();
    const TIP =
      '<p class="sfx-tip">' +
      (canDrag
        ? "Arraste um som para a timeline, ou + para inserir"
        : "Leve a agulha até o ponto e clique em + (ou I) para pôr o som ali") +
      " · ↑ ↓ passeiam ouvindo · 1–9 variação · F favorita</p>";

    // O redesenho da lista faz o UXP selecionar todo o texto da busca;
    // a guarda devolve o cursor (o porquê está em caretGuard.ts).
    const caret = queryEl ? guardCaret(queryEl, { activeElement: () => document.activeElement }) : null;

    /** O redesenho, com o cursor da busca devolvido ao lugar. */
    function renderBody(): void {
      if (caret) caret.around(paintBody);
      else paintBody();
    }

    function paintBody(): void {
      if (!bodyEl) return;
      rows.clear();
      visible = [];
      drawnSignature = signature;

      if (!catalog) {
        bodyEl.innerHTML =
          refreshError && !refreshing
            ? '<div class="sfx-empty"><p>O pack não abriu.</p>' +
              `<p class="sfx-empty-detail">${escapeHtml(refreshError)}</p>` +
              `<span class="sfx-action" ${CONTROL} data-retry>Tentar de novo</span></div>`
            : ghostHtml();
        return;
      }

      const blocks: string[] = [];
      const searching = queryTerms(query).length > 0;

      if (searching) {
        let total = 0;
        const sections: string[] = [];
        for (const category of catalog.categories) {
          const sounds = matching(category.sounds);
          if (sounds.length === 0) continue;
          total += sounds.length;
          // Só as primeiras `limit` linhas vão para a tela; a contagem é a de verdade.
          const room = limit - visible.length;
          if (room <= 0) continue;
          sections.push(sectionHtml(category.label, sounds.length));
          for (const sound of sounds.slice(0, room)) {
            sections.push(rowHtml(sound));
            visible.push(sound);
          }
        }
        if (total === 0) {
          bodyEl.innerHTML =
            '<div class="sfx-empty">' +
            `<p>Nada com <b>“${escapeHtml(query.trim())}”</b>.</p>` +
            '<p class="sfx-empty-detail">O pack é quase todo em inglês: tente whoosh, hit, riser, click.</p>' +
            "</div>";
          return;
        }
        blocks.push(`<p class="sfx-results">${plural(total, "som", "sons")} para “${escapeHtml(query.trim())}”</p>`);
        blocks.push(...sections, moreHtml(total - visible.length), TIP);
      } else {
        const view = currentView();
        if (view === VIEW_HOME) {
          bodyEl.innerHTML = homeHtml(catalog);
          return;
        }
        if (view === VIEW_FAVORITES) {
          const favs = favorites();
          blocks.push(headingHtml("Favoritos", favs.length, starIcon(true)));
          for (const category of catalog.categories) {
            const sounds = category.sounds.filter(isFavorite);
            if (sounds.length === 0) continue;
            blocks.push(sectionHtml(category.label, sounds.length));
            for (const sound of sounds) {
              blocks.push(rowHtml(sound));
              visible.push(sound);
            }
          }
        } else {
          const category = categoryById(view);
          if (category) {
            blocks.push(headingHtml(category.label, category.sounds.length, categoryIcon(category.id), category));
            blocks.push('<div class="sfx-rows">');
            for (const sound of category.sounds.slice(0, limit)) {
              blocks.push(rowHtml(sound));
              visible.push(sound);
            }
            blocks.push("</div>", moreHtml(category.sounds.length - visible.length));
          }
        }
        blocks.push(TIP);
      }

      bodyEl.innerHTML = blocks.join("");
      for (const row of bodyEl.querySelectorAll<HTMLElement>("[data-row]")) {
        rows.set(row.dataset.row ?? "", row);
      }
    }

    /** Redesenha só uma linha — a lista inteira perderia a rolagem e a barra. */
    function paintRow(key: string | null): void {
      if (!key) return;
      const row = rows.get(key);
      const sound = findSound(key);
      if (!row || !sound) return;
      const holder = document.createElement("div");
      holder.innerHTML = rowHtml(sound);
      const fresh = holder.firstElementChild as HTMLElement | null;
      if (!fresh) return;
      const hadFocus = document.activeElement === row;
      row.replaceWith(fresh);
      rows.set(key, fresh);
      if (hadFocus) fresh.focus();
    }

    function runProgress(key: string, seconds: number | null): void {
      const bar = rows.get(key)?.querySelector<HTMLElement>("[data-progress]");
      if (!bar || seconds === null) return;
      bar.style.transition = "none";
      bar.style.width = "0";
      void bar.offsetWidth;
      bar.style.transition = `width ${seconds}s linear`;
      bar.style.width = "100%";
    }

    function renderAll(): void {
      renderPack();
      renderBody();
      syncActions();
    }

    function open(view: string): void {
      limit = PAGE_SIZE;
      config.view = view;
      persist();
      if (bodyEl) bodyEl.scrollTop = 0;
      renderBody();
      // A rolagem é do painel, não da lista: sem voltar ao topo, abrir
      // uma categoria no meio da página mostrava o fim dela.
      container.closest<HTMLElement>(".work-scroll")?.scrollTo?.({ top: 0 });
    }

    // ── a prévia ─────────────────────────────────────────────────

    function letGo(): void {
      release?.();
      release = null;
    }

    function stop(): void {
      ticket += 1;
      stopPlayback();
      letGo();
      const before = playing?.key ?? loading?.key ?? null;
      playing = null;
      loading = null;
      paintRow(before);
      syncActions();
    }

    function emptyMessage(variant: SfxVariant): void {
      context.setStatus(
        `“${variant.file}” está vazio no próprio Drive — o upload dele falhou e precisa ser refeito.`,
        "error"
      );
    }

    async function play(sound: SfxSound, take: number): Promise<void> {
      const variant = sound.variants[take];
      if (!variant) return;
      if (localState(variant) === "empty") {
        emptyMessage(variant);
        return;
      }

      const before = selectedKey;
      stopPlayback();
      letGo();
      // Ainda dentro do clique, antes de qualquer espera: destrava o
      // player no gesto do editor (ver `player.ts`).
      prime(silenceUrl());
      const mine = ++ticket;
      playing = null;
      loading = { key: sound.key, take };
      selectedKey = sound.key;
      chosen.set(sound.key, take);
      if (before !== sound.key) paintRow(before);
      paintRow(sound.key);
      syncActions();
      const label =
        sound.variants.length > 1 ? `${sound.name} · ${take + 1} de ${sound.variants.length}` : sound.name;
      const toFolder = !!config.folder && localState(variant) === "drive";
      if (toFolder) {
        context.setStatus(`Baixando ${label} para ${folderLabel(config.folder)}…`, "idle");
      } else if (!isNearby(variant) && localState(variant) !== "copied") {
        context.setStatus(`Buscando ${label} no Drive…`, "idle");
      }
      /** Dito junto do "Tocando" quando a pasta recusou o arquivo. */
      let note = "";

      const finish = (): void => {
        letGo();
        playing = null;
        loading = null;
        paintRow(sound.key);
        syncActions();
      };

      let source: PreviewSource | null = null;
      try {
        const category = categoryById(sound.category);
        if (toFolder && category) {
          // Com pasta, ouvir é baixar PARA ELA: o som fica lá e da
          // segunda vez toca do disco.
          try {
            const saved = await copyToDisk(variant, fileNameFor(category, sound, take));
            if (saved.kind === "empty") {
              source = { kind: "empty" };
            } else if (saved.data) {
              // Os bytes que acabaram de ir para a pasta tocam daqui,
              // sem ler de volta nem baixar de novo.
              remember(variant, saved.data);
            }
            if (alive) {
              renderPack();
              syncActions();
            }
          } catch (cause) {
            // A pasta recusou (permissão, disco cheio): o som ainda toca,
            // de passagem, e a mensagem diz que não ficou salvo.
            note = ` — não ficou salvo na pasta (${describe(cause)})`;
          }
        }
        source ??= await previewSource(variant);
      } catch (cause) {
        if (!alive || mine !== ticket) return;
        finish();
        context.setStatus(`Não baixou “${sound.name}”: ${describe(cause)}`, "error");
        return;
      }
      if (!alive || mine !== ticket) {
        if (source.kind === "ready") source.release();
        return;
      }
      if (source.kind === "empty") {
        finish();
        emptyMessage(variant);
        return;
      }
      release = source.release;

      playUrl(source.url, {
        onStart: (seconds) => {
          if (!alive || mine !== ticket) return;
          loading = null;
          playing = { key: sound.key, take };
          paintRow(sound.key);
          syncActions();
          context.setStatus(`Tocando ${label}${note}`, note ? "error" : "idle");
          if (seconds !== null && knownSeconds(variant) === null) {
            rememberSeconds(variant, seconds);
            const dur = rows.get(sound.key)?.querySelector<HTMLElement>("[data-dur]");
            if (dur) dur.textContent = formatSeconds(seconds);
          }
          runProgress(sound.key, seconds ?? knownSeconds(variant));
        },
        onEnd: () => {
          if (!alive || mine !== ticket) return;
          finish();
          context.setStatus("", "idle");
        },
        onError: (message) => {
          if (!alive || mine !== ticket) return;
          if (localState(variant) === "copied") forgetCopy(variant);
          finish();
          context.setStatus(`Não tocou “${sound.name}”: ${message}`, "error");
        },
      }, `${sound.name} #${take + 1}`);
    }

    function toggle(sound: SfxSound, take?: number): void {
      const index = take ?? chosen.get(sound.key) ?? 0;
      const busy = playing ?? loading;
      if (busy && busy.key === sound.key && busy.take === index) {
        stop();
        return;
      }
      void play(sound, index);
    }

    function toggleFavorite(sound: SfxSound): void {
      config.favorites = isFavorite(sound)
        ? config.favorites.filter((key) => key !== sound.key)
        : [...config.favorites, sound.key];
      persist();
      if (currentView() === VIEW_FAVORITES || (config.view === VIEW_FAVORITES && favorites().length === 0)) {
        renderBody();
      } else {
        paintRow(sound.key);
      }
    }

    function move(step: number): void {
      if (visible.length === 0) return;
      const at = visible.findIndex((sound) => sound.key === selectedKey);
      const next = visible[Math.max(0, Math.min(visible.length - 1, at < 0 ? 0 : at + step))];
      if (!next || (next.key === selectedKey && at >= 0)) return;
      void play(next, chosen.get(next.key) ?? 0);
      const row = rows.get(next.key);
      row?.focus();
      row?.scrollIntoView?.({ block: "nearest" });
    }

    // ── o botão principal: ouvir o escolhido ─────────────────────

    function syncActions(): void {
      if (!alive) return;
      const sound = findSound(selectedKey);
      context.setApplyLabel(inserting ? "Inserindo…" : "Inserir");
      context.setApplyEnabled(!!sound && !inserting);
      if (sync?.running) {
        context.setResetLabel("Parar download");
        // `stopSyncJob` larga a guarda e aborta o que está em voo; o
        // relato do que foi baixado sai por `reportSync`, na hora.
        context.setResetHandler(haltSync);
      } else {
        context.setResetHandler(null);
      }
      renderFolder();
    }

    context.setApplyHandler(async () => {
      const sound = findSound(selectedKey);
      if (sound) await insertSound(sound, chosen.get(sound.key) ?? 0);
    });

    // ── pôr na timeline ──────────────────────────────────────────

    function takeLabel(sound: SfxSound, take: number): string {
      return sound.variants.length > 1 ? `${sound.name} ${take + 1}` : sound.name;
    }

    /**
     * O som na pasta dos SFX, baixando se preciso. Sem pasta, pede uma:
     * o Premiere importa por referência, e o arquivo tem de ficar.
     * null = o editor desistiu de escolher.
     */
    async function fileInFolder(sound: SfxSound, take: number): Promise<string | "empty" | null> {
      const variant = sound.variants[take];
      const category = categoryById(sound.category);
      if (!variant || !category) return null;
      if (!config.folder) {
        context.setStatus("Para pôr na timeline o som precisa de uma pasta — escolha onde guardar os SFX.", "idle");
        await choose(true);
        if (!config.folder) return null;
      }
      const held = copiedFile(variant);
      if (held) return held;
      const saved = await copyToDisk(variant, fileNameFor(category, sound, take));
      if (alive) {
        renderPack();
        syncActions();
      }
      if (saved.kind === "empty") return "empty";
      if (saved.data) remember(variant, saved.data);
      return nativeFileOf(saved.url);
    }

    async function insertSound(sound: SfxSound, take: number): Promise<void> {
      if (inserting) return;
      const variant = sound.variants[take];
      if (!variant) return;
      if (localState(variant) === "empty") {
        emptyMessage(variant);
        return;
      }
      inserting = true;
      syncActions();
      const label = takeLabel(sound, take);
      context.setStatus(`Inserindo ${label}…`, "idle");
      try {
        const file = await fileInFolder(sound, take);
        if (file === null) {
          context.setStatus("Nada foi inserido: nenhuma pasta escolhida.", "idle");
          return;
        }
        if (file === "empty") {
          emptyMessage(variant);
          paintRow(sound.key);
          return;
        }
        const seconds = knownSeconds(variant) ?? (await probeDuration(`file://${encodeURI(file)}`));
        rememberSeconds(variant, seconds);
        const result = await insertAtPlayhead(file, seconds);
        if (!alive) return;
        context.setStatus(
          result.ok ? `${label} entrou na ${result.message}.` : `Não inseri ${label}: ${result.message}.`,
          result.ok ? "done" : "error"
        );
      } catch (cause) {
        if (alive) context.setStatus(`Não inseri ${label}: ${describe(cause)}.`, "error");
      } finally {
        inserting = false;
        if (alive) syncActions();
      }
    }

    /** O tipo que o Premiere aceita no arrasto, pela extensão. */
    const CONTENT_TYPES: Record<string, string> = {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      mpeg: "audio/mpeg",
      m4a: "audio/m4a",
      aac: "audio/aac",
      aif: "audio/aif",
      aiff: "audio/x-aiff",
    };

    /**
     * O arrasto para a timeline — o formato oficial da Adobe para painéis
     * UXP ("Drag and Drop Media into Premiere Pro"): um JSON como
     * `text/plain`, versão "1.0.0", com a URI `file://` de arquivo local.
     *
     * O arquivo tem de EXISTIR quando o editor soltar. Por isso o
     * download começa já no `mousedown` (ver abaixo): enquanto a mão vai
     * até a timeline, o som chega à pasta. O caminho vai no pacote desde
     * o início — é o mesmo que o download vai usar.
     *
     * A Adobe documenta isto a partir do Premiere 27. No 26.5.1 o código
     * existe, mas atrás de um recurso beta (`PPro.UXPDragAndDrop`, "Enable
     * UXP Drag and Drop for testing") que a versão normal não liga e que a
     * API do plugin não alcança (`BetaFeature` não é exposto ao UXP).
     *
     * Por isso vai também `text/uri-list` — o formato de um arquivo
     * arrastado do Finder. Se o UXP repassar isso ao sistema, a timeline
     * aceita como aceitaria do Finder. E cada arrasto deixa uma linha em
     * `sfx-drag-report.txt`: se começou, o que foi posto, como terminou.
     */
    function onDragStart(event: DragEvent): void {
      const row = (event.target as Element | null)?.closest<HTMLElement>("[data-row]");
      const sound = findSound(row?.dataset.row ?? null);
      const transfer = event.dataTransfer;
      if (!sound || !transfer) return;
      const take = chosen.get(sound.key) ?? 0;
      const variant = sound.variants[take];
      const category = categoryById(sound.category);
      if (!variant || !category || localState(variant) === "empty") {
        event.preventDefault();
        if (variant) emptyMessage(variant);
        return;
      }
      const relative = fileNameFor(category, sound, take);
      const file = plannedFile(variant, relative);
      if (!file) {
        event.preventDefault();
        context.setStatus(
          "Para arrastar para a timeline, escolha antes a pasta dos SFX (linha embaixo da busca).",
          "error"
        );
        return;
      }
      if (localState(variant) !== "copied") {
        void copyToDisk(variant, relative)
          .then((saved) => {
            if (saved.kind === "ok" && saved.data) remember(variant, saved.data);
            if (alive) renderPack();
          })
          .catch((cause) => {
            if (alive) context.setStatus(`Não baixei ${takeLabel(sound, take)}: ${describe(cause)}`, "error");
          });
      }
      const name = file.slice(file.lastIndexOf("/") + 1);
      const payload = {
        version: "1.0.0",
        items: [
          {
            name,
            display_name: takeLabel(sound, take),
            content_type: CONTENT_TYPES[variant.ext] ?? "audio/wav",
            // encodeURI, como a Adobe pede — e o `#` e o `?` à mão, que
            // ele deixa passar e que cortariam o caminho no meio.
            uri: `file://${encodeURI(file).replace(/#/g, "%23").replace(/\?/g, "%3F")}`,
          },
        ],
      };
      const uri = payload.items[0].uri;
      const notes: string[] = [];
      try {
        transfer.setData("text/plain", JSON.stringify(payload));
        notes.push("text/plain ok");
      } catch (cause) {
        notes.push(`text/plain falhou (${describe(cause)})`);
      }
      try {
        transfer.setData("text/uri-list", uri);
        notes.push("text/uri-list ok");
      } catch (cause) {
        notes.push(`text/uri-list falhou (${describe(cause)})`);
      }
      transfer.effectAllowed = "copyMove";
      transfer.dropEffect = "copy";
      dragNote(`começou · ${takeLabel(sound, take)} · ${notes.join(" · ")} · ${uri}`);
      context.setStatus(`Solte ${takeLabel(sound, take)} na timeline…`, "idle");
    }

    /** Uma linha no relatório do arrasto (as últimas 60 ficam). */
    function dragNote(line: string): void {
      const now = new Date();
      const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
      void (async () => {
        try {
          const space = await workspace();
          const before = (readText(space, DRAG_REPORT) ?? "").split("\n").slice(-59);
          await write(space, DRAG_REPORT, [...before, `${stamp} ${line}`].join("\n"));
        } catch {
          // Sem relatório, o arrasto segue igual.
        }
      })();
    }

    // ── a pasta dos SFX ──────────────────────────────────────────

    /**
     * A pasta em vigor, do grupo `audio`.
     *
     * ⚠️ Esse grupo tem DOIS membros de propósito: esta biblioteca e o
     * SFX Automático. Escolher aqui vale lá, e vice-versa — é a mesma
     * pasta de sons vista de dois lugares, e foi pedido assim. Quem
     * quiser separá-los mexe na tabela de `bridge/destination`, que é
     * onde a decisão está escrita, e não num `if` aqui dentro.
     */
    function applyFolder(): void {
      setFolder(config.folder ? { path: config.folder, token: config.folderToken } : null);
      forgetOpenFolders();
    }
    applyFolder();
    void (async () => {
      const held = await readDestination(
        "sfx",
        destinationOf(config.folder, config.folderToken)
      ).catch(() => null);
      if (!alive || !held || held.path === config.folder) return;
      config.folder = held.path;
      config.folderToken = held.token;
      applyFolder();
      renderAll();
    })();

    /**
     * A linha da pasta, embaixo da busca, e a seção dela nos ajustes.
     *
     * A linha diz onde os sons vão parar e oferece o próximo passo —
     * escolher, baixar o que falta ou abrir. O resto (trocar, apagar,
     * deixar de usar) mora nos ajustes, onde não disputa espaço com a
     * lista.
     */
    function renderFolder(): void {
      const label = config.folder ? folderLabel(config.folder) : "";
      const variants = catalog ? allVariants(catalog) : [];
      const copy = copyUsage(variants);
      const missing = variants.filter((variant) => localState(variant) === "drive").length;
      const running = !!sync?.running;

      if (folderTextEl && folderActEl) {
        folderTextEl.title = config.folder;
        if (!config.folder) {
          folderTextEl.innerHTML = '<span class="sfx-folder-dim">Pasta dos SFX: nenhuma — os sons vêm do Drive</span>';
          folderActEl.textContent = "Escolher…";
          folderActEl.dataset.act = "pick";
        } else if (running && sync) {
          folderTextEl.innerHTML =
            `<b>${escapeHtml(label)}</b><span class="sfx-folder-dim"> · baixando ${sync.done} de ${sync.total}</span>`;
          folderActEl.textContent = "Parar";
          folderActEl.dataset.act = "stop";
        } else if (catalog && missing > 0) {
          folderTextEl.innerHTML =
            `<b>${escapeHtml(label)}</b><span class="sfx-folder-dim"> · ${copy.files} de ${catalog.files} sons</span>`;
          folderActEl.textContent = Date.now() < armedUntil ? `Confirmar: ${missing}` : `Baixar ${missing}`;
          folderActEl.dataset.act = "download";
        } else {
          folderTextEl.innerHTML =
            `<b>${escapeHtml(label)}</b><span class="sfx-folder-dim"> · ${plural(copy.files, "som", "sons")}` +
            `${copy.bytes > 0 ? ` · ${formatBytes(copy.bytes)}` : ""}</span>`;
          folderActEl.textContent = "Abrir";
          folderActEl.dataset.act = "open";
        }
        folderActEl.hidden = !catalog && !!config.folder;
      }

      if (folderPathEl) folderPathEl.textContent = config.folder || "Nenhuma";
      if (folderPickEl) folderPickEl.textContent = config.folder ? "Trocar…" : "Escolher…";
      if (folderInfoEl) {
        folderInfoEl.textContent = !config.folder
          ? "Sem pasta, os sons vêm do Drive na hora de ouvir e não ficam guardados neste " +
            "computador. Escolha uma pasta para ter o pack no disco, uma subpasta por categoria."
          : running && sync
            ? `Baixando ${sync.done} de ${sync.total} · ${formatBytes(sync.bytes)}`
            : `${copy.files} de ${catalog?.files ?? 0} sons nesta pasta` +
              (copy.bytes > 0 ? ` · ${formatBytes(copy.bytes)}` : "") +
              (missing > 0 ? ` · faltam ${missing}` : "") +
              ". Apagar tira só o que o plugin baixou; o resto da pasta não é tocado.";
      }
      if (folderOpenEl) folderOpenEl.hidden = !config.folder;
      if (folderClearEl) folderClearEl.hidden = !config.folder || copy.files === 0 || running;
      if (folderDropEl) folderDropEl.hidden = !config.folder || running;
    }

    /** `quiet`: quem chamou já vai baixar em seguida, não precisa de dica. */
    async function choose(quiet = false): Promise<void> {
      try {
        const picked = await pickAndSave("sfx");
        if (!picked || !alive) return;
        haltSync();
        config.folder = picked.path;
        config.folderToken = picked.token;
        persist();
        applyFolder();
        renderAll();
        if (quiet) return;
        context.setStatus(
          `Pasta escolhida: ${folderLabel(picked.path)}. Os sons que você ouvir ficam salvos nela, ` +
            "e “Baixar o pack” traz o resto.",
          "done"
        );
      } catch (cause) {
        context.setStatus(`A pasta não abriu: ${describe(cause)}`, "error");
      }
    }

    async function download(): Promise<void> {
      if (!catalog || sync?.running || !config.folder) return;
      const missing = allVariants(catalog).filter((variant) => localState(variant) === "drive").length;
      // Milhares de arquivos não saem num clique distraído: o primeiro arma, o segundo baixa.
      if (missing > CONFIRM_ABOVE && Date.now() > armedUntil) {
        armedUntil = Date.now() + 8000;
        renderFolder();
        context.setStatus(
          `São ${missing} sons (vários GB) para ${folderLabel(config.folder)}. Clique de novo em “Confirmar” para baixar tudo — ` +
            "ou abra uma categoria e baixe só ela.",
          "idle"
        );
        setTimeout(() => { if (alive) renderFolder(); }, 8100);
        return;
      }
      armedUntil = 0;
      context.setStatus(`Baixando o pack para ${folderLabel(config.folder)}…`, "idle");
      await runSync(catalog);
    }

    /** Uma categoria para a pasta dos SFX; sem pasta, pede uma antes. */
    async function downloadCategory(categoryId: string): Promise<void> {
      if (!catalog || sync?.running) return;
      const category = categoryById(categoryId);
      if (!category) return;
      if (!config.folder) await choose(true);
      if (!config.folder || !alive) return;
      context.setStatus(`Baixando ${category.label} para ${folderLabel(config.folder)}/${category.label}…`, "idle");
      await runSync(catalog, categoryId);
    }

    async function openFolder(): Promise<void> {
      if (!config.folder) return;
      const shell = shellModule();
      if (!shell?.openPath) {
        context.setStatus("Este Premiere não deixa o painel abrir pastas.", "error");
        return;
      }
      try {
        const refusal = await shell.openPath(config.folder, "Abrir a pasta dos efeitos sonoros");
        if (typeof refusal === "string" && refusal.trim()) {
          context.setStatus(`A pasta não abriu: ${refusal.trim()}`, "error");
        }
      } catch (cause) {
        context.setStatus(`A pasta não abriu: ${describe(cause)}`, "error");
      }
    }

    function reportSync(job: SyncJob): void {
      const where = config.folder ? folderLabel(config.folder) : "a pasta";
      const parts: string[] = [];
      if (job.cancelled) parts.push(`Download parado: ${job.done - job.failed - job.empty} de ${job.total} em ${where}`);
      else parts.push(`${plural(job.done - job.failed - job.empty, "som baixado", "sons baixados")} em ${where}: ${formatBytes(job.bytes)}`);
      if (job.empty > 0) parts.push(`${plural(job.empty, "arquivo está vazio", "arquivos estão vazios")} no próprio Drive`);
      if (job.failed > 0) parts.push(`${plural(job.failed, "não baixou", "não baixaram")} (${job.lastError ?? "erro"})`);
      context.setStatus(parts.join(" · "), job.failed > 0 ? "error" : "done");
    }

    folderActEl?.addEventListener("click", () => {
      switch (folderActEl.dataset.act) {
        case "pick":
          void choose();
          break;
        case "stop":
          haltSync();
          break;
        case "download":
          void download();
          break;
        default:
          void openFolder();
      }
    });
    folderPickEl?.addEventListener("click", () => void choose());
    folderOpenEl?.addEventListener("click", () => void openFolder());
    folderClearEl?.addEventListener("click", () => {
      if (sync?.running) return;
      stop();
      void clearCopy()
        .then((count) => {
          if (!alive) return;
          renderAll();
          context.setStatus(
            `${plural(count, "som apagado", "sons apagados")} da pasta. Eles voltam a vir do Drive.`,
            "done"
          );
        })
        .catch((cause) => context.setStatus(`Não consegui apagar: ${describe(cause)}`, "error"));
    });
    folderDropEl?.addEventListener("click", () => {
      if (sync?.running) return;
      stop();
      config.folder = "";
      config.folderToken = "";
      persist();
      applyFolder();
      renderAll();
      context.setStatus("Sem pasta: os sons voltam a vir do Drive. Nada foi apagado.", "done");
    });

    // ── eventos ──────────────────────────────────────────────────

    bodyEl?.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-retry]")) {
        void refreshPack(config.pack);
        return;
      }
      if (target?.closest("[data-home]")) {
        open(VIEW_HOME);
        return;
      }
      if (target?.closest("[data-more]")) {
        const top = bodyEl.scrollTop;
        limit += PAGE_SIZE;
        renderBody();
        bodyEl.scrollTop = top;
        return;
      }
      const getCategory = target?.closest<HTMLElement>("[data-get-category]");
      if (getCategory) {
        void downloadCategory(getCategory.dataset.getCategory ?? "");
        return;
      }
      const tile = target?.closest<HTMLElement>("[data-open]");
      if (tile?.dataset.open) {
        open(tile.dataset.open);
        return;
      }
      const row = target?.closest<HTMLElement>("[data-row]");
      const sound = findSound(row?.dataset.row ?? null);
      if (!sound) return;
      if (target?.closest("[data-insert]")) {
        void insertSound(sound, chosen.get(sound.key) ?? 0);
        return;
      }
      if (target?.closest("[data-fav]")) {
        toggleFavorite(sound);
        return;
      }
      const takeEl = target?.closest<HTMLElement>("[data-take]");
      if (takeEl) {
        toggle(sound, Number(takeEl.dataset.take));
        return;
      }
      toggle(sound);
    });

    bodyEl?.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Escape" && currentView() !== VIEW_HOME && !query) {
        event.preventDefault();
        open(VIEW_HOME);
        return;
      }
      const row = (event.target as Element | null)?.closest<HTMLElement>("[data-row]");
      const sound = findSound(row?.dataset.row ?? null);
      if (!sound) return;
      if (event.key === "i" || event.key === "I") {
        event.preventDefault();
        void insertSound(sound, chosen.get(sound.key) ?? 0);
        return;
      }
      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        toggleFavorite(sound);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const take = Number(event.key) - 1;
        if (take < sound.variants.length) {
          event.preventDefault();
          void play(sound, take);
        }
      }
    });

    bodyEl?.addEventListener("dragstart", (event) => onDragStart(event as DragEvent));
    bodyEl?.addEventListener("dragend", (event) => {
      const drag = event as DragEvent;
      dragNote(`terminou · dropEffect=${String(drag.dataTransfer?.dropEffect ?? "?")}`);
    });
    // Começa a trazer o som para a pasta assim que o editor aperta o
    // mouse na linha: se ele for arrastar, o arquivo chega antes da mão.
    bodyEl?.addEventListener("mousedown", (event) => {
      const target = event.target as Element | null;
      if (!config.folder || target?.closest("[data-fav],[data-take],[data-insert]")) return;
      const sound = findSound(target?.closest<HTMLElement>("[data-row]")?.dataset.row ?? null);
      const take = sound ? chosen.get(sound.key) ?? 0 : 0;
      const variant = sound?.variants[take];
      const category = sound ? categoryById(sound.category) : undefined;
      if (!sound || !variant || !category || localState(variant) !== "drive") return;
      void copyToDisk(variant, fileNameFor(category, sound, take))
        .then((saved) => {
          if (saved.kind === "ok" && saved.data) remember(variant, saved.data);
        })
        .catch(() => undefined);
    });

    /**
     * Redesenha a lista DEPOIS de a digitação dar uma pausa.
     *
     * ── Por que o campo comia letras ──────────────────────────────
     * Cada tecla redesenhava a lista inteira de forma síncrona: até 80
     * linhas ricas (ícones, selos, tomadas) reconstruídas por `innerHTML`
     * e redispostas de uma vez. No motor do UXP isso custa dezenas de
     * milissegundos, e é a thread do painel que paga — a mesma que
     * processa o teclado. Digitando devagar não dá para notar; digitando
     * rápido, as teclas chegam durante o trabalho e o campo perde
     * caracteres.
     *
     * O valor digitado nunca espera: `query`, o campo e o botão de
     * limpar seguem instantâneos. O que é adiado é só o desenho da
     * lista, e uma rajada de teclas vira UM desenho em vez de seis.
     */
    const QUERY_DEBOUNCE_MS = 120;
    let queryTimer: ReturnType<typeof setTimeout> | null = null;

    function applyQuery(value: string, immediate = false): void {
      limit = PAGE_SIZE;
      query = value;
      if (queryEl && queryEl.value !== value) {
        queryEl.value = value;
        caret?.sync();
      }
      if (clearEl) clearEl.hidden = value.length === 0;

      if (queryTimer !== null) {
        clearTimeout(queryTimer);
        queryTimer = null;
      }
      if (immediate) {
        renderBody();
        return;
      }
      queryTimer = setTimeout(() => {
        queryTimer = null;
        if (alive) renderBody();
      }, QUERY_DEBOUNCE_MS);
    }

    queryEl?.addEventListener("input", () => applyQuery(queryEl.value));
    queryEl?.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && query) {
        event.preventDefault();
        applyQuery("", true);
      } else if (event.key === "ArrowDown") {
        // Da busca direto para o primeiro resultado, já tocando.
        event.preventDefault();
        const before = selectedKey;
        selectedKey = null;
        paintRow(before);
        move(1);
      }
    });
    clearEl?.addEventListener("click", () => {
      applyQuery("", true);
      queryEl?.focus();
    });

    refreshEl?.addEventListener("click", () => void refreshPack(config.pack));

    advToggleEl?.addEventListener("click", () => {
      if (!advContentEl) return;
      advContentEl.hidden = !advContentEl.hidden;
      if (advIconEl) advIconEl.textContent = advContentEl.hidden ? "▾" : "▴";
    });

    packUseEl?.addEventListener("click", () => {
      const id = folderIdFrom(packInputEl?.value ?? "");
      if (!id) {
        if (packNoteEl) packNoteEl.textContent = "Não achei o id de uma pasta nesse link.";
        return;
      }
      if (packNoteEl) packNoteEl.textContent = PACK_NOTE;
      if (id === config.pack) {
        void refreshPack(id);
        return;
      }
      haltSync();
      stop();
      config.pack = id;
      config.view = VIEW_HOME;
      persist();
      snapshot = null;
      catalog = null;
      signature = "";
      renderAll();
      void (async () => {
        const held = await readSnapshot(id);
        if (!alive || config.pack !== id) return;
        if (held) adopt(held);
        renderAll();
        void refreshPack(id);
      })();
    });

    // ── o que vem de fora: listagem e cópia ──────────────────────

    const onOutside = (): void => {
      if (!alive) return;
      renderPack();
      if (signature !== drawnSignature || !catalog) {
        // O pack mudou no Drive, chegou pela primeira vez, ou falhou.
        renderBody();
      }
      syncActions();
      if (sync) {
        if (sync.running) {
          lastSyncRunning = true;
          context.setStatus(`Baixando o pack · ${sync.done} de ${sync.total} · ${formatBytes(sync.bytes)}`, "idle");
        } else if (lastSyncRunning) {
          lastSyncRunning = false;
          reportSync(sync);
          // As durações e os "vazio no Drive" chegaram com o download.
          renderBody();
        }
      }
    };
    listeners.add(onOutside);

    renderAll();
    if (sync?.running) {
      lastSyncRunning = true;
      onOutside();
    }

    void (async () => {
      if (!warm) {
        // O painel abriu antes de os ajustes chegarem do disco: sem isto
        // a pasta escolhida e os favoritos só voltariam na próxima vez.
        const stored = await settings.read();
        Object.assign(config, stored, { favorites: [...stored.favorites] });
        applyFolder();
      }
      await loadManifest();
      if (!catalog || snapshot?.rootId !== config.pack) {
        const held = await readSnapshot(config.pack);
        if (held) adopt(held);
      }
      if (!alive) return;
      renderAll();
      const stale = !lastRefresh || Date.now() - lastRefresh > REFRESH_MS || snapshot?.rootId !== config.pack;
      if (stale) void refreshPack(config.pack);
    })();

    teardown = () => {
      setHost(null);
      alive = false;
      if (queryTimer !== null) {
        clearTimeout(queryTimer);
        queryTimer = null;
      }
      listeners.delete(onOutside);
      ticket += 1;
      stopPlayback();
      letGo();
    };
  },

  unmount(): void {
    // O download para a pasta continua: ele mora fora do `mount`, e
    // voltar para a ferramenta mostra onde ele está.
    teardown?.();
    teardown = null;
    void settings.flush();
  },
};

const PACK_NOTE = "Pasta pública do Drive. Cada pasta dentro dela vira uma categoria.";

function markup(config: SfxSettings): string {
  return (
    '<div class="zones sfx">' +
    '<div class="zone sfx-top">' +
    '<div class="sfx-search">' +
    SEARCH_ICON +
    // Campo de busca de painel não é formulário: sem histórico, sem
    // correção e sem maiúscula automática. Não foi o que causava o
    // texto selecionado (ver caretGuard.ts), é só higiene do campo.
    '<input type="text" class="sfx-query" data-query spellcheck="false" ' +
    'autocomplete="off" autocorrect="off" autocapitalize="off" ' +
    'placeholder="Buscar — whoosh, impacto, clique…">' +
    `<span class="sfx-clear" ${CONTROL} data-clear aria-label="Limpar busca" hidden>×</span>` +
    "</div>" +
    '<div class="sfx-source">' +
    '<span class="sfx-dot" data-pack-dot></span>' +
    '<span class="sfx-source-text" data-pack-meta></span>' +
    // O palco do player: um <video> de áudio não desenha nada, mas uma
    // das maneiras de tocar precisa dele visível dentro do painel.
    '<span class="sfx-stage" data-stage aria-hidden="true"></span>' +
    `<span class="sfx-refresh" ${CONTROL} data-refresh title="Ver se o pack mudou no Drive">${REFRESH_ICON}</span>` +
    "</div>" +
    '<div class="sfx-folder">' +
    `<span class="sfx-folder-icon">${FOLDER_ICON}</span>` +
    '<span class="sfx-folder-text" data-folder-text></span>' +
    `<span class="sfx-folder-act" ${CONTROL} data-folder-act></span>` +
    "</div>" +
    "</div>" +
    '<div class="zone sfx-body" data-body></div>' +
    '<div class="sil-advanced">' +
    `<div class="sil-advanced-summary" ${CONTROL} data-adv-toggle>` +
    '<span class="sil-advanced-title">Ajustes avançados</span>' +
    '<span class="sil-advanced-icon" data-adv-icon>▾</span>' +
    "</div>" +
    '<div class="sil-advanced-content" data-adv-content hidden>' +
    '<div class="field">' +
    '<div class="field-head">' +
    '<span class="t-label" title="Onde os sons ficam quando você baixa o pack.">Pasta dos SFX</span>' +
    `<span class="field-action" ${CONTROL} data-folder-pick>Escolher…</span>` +
    "</div>" +
    '<p class="dl-dest" data-folder-path></p>' +
    '<p class="tt-note sfx-copy-info" data-folder-info></p>' +
    '<div class="sfx-copy-acts">' +
    `<span class="field-action" ${CONTROL} data-folder-open hidden>Abrir pasta</span>` +
    `<span class="field-action" ${CONTROL} data-folder-clear hidden>Apagar os sons baixados</span>` +
    `<span class="field-action" ${CONTROL} data-folder-drop hidden>Não usar pasta</span>` +
    "</div>" +
    "</div>" +
    '<div class="field">' +
    '<div class="field-head">' +
    '<span class="t-label" title="O link de uma pasta pública do Drive.">Link do pack</span>' +
    `<span class="field-action" ${CONTROL} data-pack-use>Usar</span>` +
    "</div>" +
    '<input type="text" class="sil-path" data-pack-input spellcheck="false" ' +
    `value="${escapeHtml(`https://drive.google.com/drive/folders/${config.pack}`)}">` +
    `<p class="tt-note" data-pack-note>${PACK_NOTE}</p>` +
    "</div>" +

    "</div>" +
    "</div>" +
    "</div>"
  );
}
