/**
 * Textos Animados — a ferramenta.
 *
 * Põe na timeline um texto que já nasce animado, a partir de um modelo
 * `.mogrt`, e troca o texto dele pelo que o editor escreveu. O que o
 * painel NÃO faz é animar: a animação é do modelo, feita por quem faz
 * motion, e é justamente por isso que o editor não precisa abrir o
 * After para ter aquele texto que salta.
 *
 * ── A lista vem de uma pasta ───────────────────────────────────────
 * Nada de coleção embutida no build: o editor aponta a pasta onde os
 * `.mogrt` moram e eles aparecem aqui. Modelo novo é um arquivo novo
 * na pasta, não uma versão nova do plugin.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL, escapeHtml, setDisabled } from "../../shell/controls";
import { mountDropdown, type Dropdown } from "../../shell/dropdown";
import { getPremiere, describeError } from "../../bridge/premiere";
import {
  clampNumber,
  createToolSettings,
  pickString,
  warmToolSettings,
} from "../../bridge/settings";
import { workspace, write } from "../silence/workspace";
import {
  destinationOf,
  openDestination,
  pickAndSave,
  readDestination,
  NO_PICKER,
} from "../../bridge/destination";
import { applyTitle } from "./applyTitles";
import { applyCaptions, MAX_PIECES } from "./applyCaptions";
import {
  cuesFromSrt,
  groupCues,
  withoutOverlap,
  wrapCues,
  type TimedCue,
} from "./cues";
import { findSrtInProject, pickSrtFile, readAnyPath } from "../translate/source";
import {
  framesFor,
  postersFor,
  readTemplateStyles,
  FRAME_MS,
  type TemplateStyle,
} from "./previews";
import { lastFontNote, listFonts } from "./fonts";
import {
  defaultLibrary,
  listTemplates,
  templatesFromEntry,
  type TitleTemplate,
} from "./library";

/**
 * Quanto tempo cabe numa peça de legenda.
 *
 * O padrão é "como está no .srt", e isso é uma correção: eu havia
 * posto o agrupamento como padrão por causa do peso, e o editor
 * percebeu na hora que os tempos não eram os do arquivo dele — porque
 * agrupar FUNDE blocos, e fundir muda onde cada legenda começa e
 * termina. Respeitar o arquivo é o comportamento que não surpreende;
 * o peso é escolha dele, com o aviso de peças na tela.
 */
const GROUPS: ReadonlyArray<{ id: string; label: string; seconds: number }> = [
  { id: "srt", label: "Do .srt", seconds: 0 },
  { id: "2", label: "≤ 2 s", seconds: 2 },
  { id: "25", label: "≤ 2,5 s", seconds: 2.5 },
  { id: "4", label: "≤ 4 s", seconds: 4 },
];

/** As durações que cobrem o uso real; 0 é "a do modelo". */
const DURATIONS: ReadonlyArray<{ id: string; label: string; seconds: number }> = [
  { id: "model", label: "Do modelo", seconds: 0 },
  { id: "2", label: "2 s", seconds: 2 },
  { id: "3", label: "3 s", seconds: 3 },
  { id: "5", label: "5 s", seconds: 5 },
];

interface TitlesSettings {
  /** Pasta dos modelos. */
  library: string;
  /** Caminho do último modelo usado — a lista o traz de volta selecionado. */
  template: string;
  duration: string;
  /** "titulo" = um texto só; "legenda" = um .srt inteiro. */
  modo: string;
  /** Nome PostScript da fonte. Vazio = a do modelo. */
  font: string;
  /** Segundos por peça ao agrupar as legendas. 0 = como está no .srt. */
  group: number;
  /**
   * Trilha de vídeo, base zero. -1 = automática.
   *
   * Automática é o padrão porque o certo quase sempre é "a de cima que
   * estiver livre", e essa conta o painel faz melhor que o editor: ele
   * teria de olhar trilha por trilha para não cobrir vídeo.
   */
  trackIndex: number;
  atPlayhead: boolean;
}

const DEFAULTS: TitlesSettings = {
  library: "",
  template: "",
  duration: "model",
  modo: "titulo",
  font: "",
  group: 0,
  trackIndex: -1,
  atPlayhead: true,
};

const settings = createToolSettings<TitlesSettings>(
  "titles-config.json",
  DEFAULTS,
  (raw) => ({
    library: pickString(raw.library, ""),
    template: pickString(raw.template, ""),
    duration: DURATIONS.some((item) => item.id === raw.duration)
      ? (raw.duration as string)
      : "model",
    modo: raw.modo === "legenda" ? "legenda" : "titulo",
    font: pickString(raw.font, ""),
    group: GROUPS.some((item) => item.seconds === raw.group)
      ? (raw.group as number)
      : 0,
    trackIndex: Math.round(clampNumber(raw.trackIndex, -1, 98, -1)),
    atPlayhead: raw.atPlayhead !== false,
  })
);

warmToolSettings(settings);

/** Os menus vivem em `document`; sem isto cada visita deixa um par. */
let releaseDocument: (() => void) | null = null;

/**
 * O laço da prévia.
 *
 * Fora do `mount` porque ele sobrevive à troca de ferramenta: sem
 * parar aqui, o painel ficava trocando imagens de um cartão que já
 * não está na tela, para sempre.
 */
let flipTimer: ReturnType<typeof setInterval> | null = null;

/** Quanto o mouse precisa ficar parado antes de ler os quadros. */
const HOVER_MS = 140;

let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function stopFlip(): void {
  if (flipTimer !== null) {
    clearInterval(flipTimer);
    flipTimer = null;
  }
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

function secondsFor(id: string): number {
  return DURATIONS.find((item) => item.id === id)?.seconds ?? 0;
}

export const titlesTool: Tool = {
  id: "titles",
  name: "Textos Animados",
  summary: "Título ou legenda .srt que já entram animados",
  hint:
    "Um título na agulha, ou um .srt inteiro virando legenda animada. O painel " +
    "usa a trilha de cima que estiver livre no trecho — nunca por cima de um " +
    "vídeo — e preserva a tipografia do modelo, trocando só a frase.",
  category: "texto",
  glyph: "title",
  available: true,
  usesSelection: false,

  mount(container: HTMLElement, context: ToolContext): void {
    const saved = settings.peek() ?? DEFAULTS;
    let config: TitlesSettings = { ...saved };
    if (!config.library) {
      config.library = defaultLibrary();
    }
    let templates: TitleTemplate[] = [];
    /** O .srt carregado: nome para a tela, legendas para a timeline. */
    let srt: { name: string; cues: TimedCue[] } | null = null;
    /**
     * Quantas peças deste arquivo já foram para a timeline.
     *
     * ── Por que o lote é picado ───────────────────────────────────
     * Acima de umas quarenta peças o Premiere põe as mídias offline e
     * trava o preview (ver MAX_PIECES). Um teto seco transformava um
     * `.srt` de 164 legendas num botão desabilitado — troca ruim: o
     * editor perdia o trabalho inteiro em vez de parte dele.
     *
     * Então o lote vai em partes de quarenta, e este contador é o que
     * lembra onde parou. Entre uma parte e outra o host respira e o
     * editor confere — que é exatamente o que ninguém consegue fazer
     * quando 164 peças entram de uma vez.
     */
    let applied = 0;
    let trackCount = 0;
    let busy = false;
    /** O editor desistiu do lote. Lido pelo laço das legendas. */
    let cancelled = false;
    /** As fontes instaladas, como sugestão. Vazio = só a do modelo. */
    let fonts: string[] = [];

    container.innerHTML = markup(config);

    const textEl = container.querySelector<HTMLTextAreaElement>("[data-text]");
    const modeSeg = container.querySelector<HTMLElement>("[data-mode-seg]");
    const textField = container.querySelector<HTMLElement>("[data-text-field]");
    const srtField = container.querySelector<HTMLElement>("[data-srt-field]");
    const srtInfoEl = container.querySelector<HTMLElement>("[data-srt-info]");
    const pickSrtEl = container.querySelector<HTMLElement>("[data-pick-srt]");
    const projectSrtEl = container.querySelector<HTMLElement>("[data-project-srt]");
    const srtListEl = container.querySelector<HTMLElement>("[data-srt-list]");
    const srtWarnEl = container.querySelector<HTMLElement>("[data-srt-warn]");
    const groupSeg = container.querySelector<HTMLElement>("[data-group-seg]");
    const galleryEl = container.querySelector<HTMLElement>("[data-gallery]");
    const stageImgEl = container.querySelector<HTMLImageElement>("[data-stage-img]");
    const stageNameEl = container.querySelector<HTMLElement>("[data-stage-name]");
    const fontHost = container.querySelector<HTMLElement>("[data-font-pick]");
    const fontEl = container.querySelector<HTMLInputElement>("[data-font]");
    const fieldsNoteEl = container.querySelector<HTMLElement>("[data-fields-note]");
    const trackHost = container.querySelector<HTMLElement>("[data-track-pick]");
    const durationSeg = container.querySelector<HTMLElement>("[data-duration-seg]");
    const whereSeg = container.querySelector<HTMLElement>("[data-where-seg]");
    const libEl = container.querySelector<HTMLElement>("[data-library]");
    const pickLibEl = container.querySelector<HTMLElement>("[data-pick-library]");
    const reloadEl = container.querySelector<HTMLElement>("[data-reload]");
    const reportEl = container.querySelector<HTMLElement>("[data-report]");
    const advToggleEl = container.querySelector<HTMLElement>("[data-adv-toggle]");
    const advContentEl = container.querySelector<HTMLElement>("[data-adv-content]");
    const advIconEl = container.querySelector<HTMLElement>("[data-adv-icon]");

    const dropdowns: Dropdown[] = [];

    /** Cartaz de cada modelo, por nome. Vazio enquanto não há prévia. */
    let posters = new Map<string, string>();
    /** A tipografia de fábrica de cada modelo, para a tela já dizer qual é. */
    let styles = new Map<string, TemplateStyle>();
    /** Quadros já lidos, para ir e voltar entre modelos sem reler disco. */
    const frameCache = new Map<string, string[]>();
    /** Quem está tocando no palco. */
    let staged = "";

    /**
     * O palco: a animação do modelo, grande e rodando.
     *
     * ── Por que ele existe ────────────────────────────────────────
     * A primeira versão só animava o cartão ESCOLHIDO, de 84px — ou
     * seja, para ver como uma animação era, você tinha que escolhê-la
     * primeiro, e ainda assim via um selo. O palco inverte: passar o
     * mouse por cima de um cartão já mostra aquela animação em
     * tamanho de verdade, sem escolher nada. Tirou o mouse, ele
     * volta para a escolhida.
     */
    function showStage(name: string): void {
      if (!stageImgEl || staged === name) {
        return;
      }
      staged = name;
      stopFlip();
      if (stageNameEl) stageNameEl.textContent = name;
      // O cartaz é imediato: ele já está na memória, e trocar a imagem
      // na hora é o que faz o palco parecer instantâneo.
      const poster = posters.get(name) ?? "";
      if (poster) {
        stageImgEl.src = poster;
      }
      stageImgEl.hidden = !poster;
      // Os quadros, não: são até trinta arquivos lidos do disco. Passar
      // o mouse correndo por trinta e cinco cartões lia mil imagens que
      // ninguém chegou a ver. Só carrega quem o mouse resolveu ficar.
      if (hoverTimer !== null) {
        clearTimeout(hoverTimer);
      }
      hoverTimer = setTimeout(() => void playStage(name), HOVER_MS);
    }

    async function playStage(name: string): Promise<void> {
      if (!stageImgEl || staged !== name) {
        return;
      }
      const poster = posters.get(name) ?? "";
      let frames = frameCache.get(name);
      if (!frames) {
        frames = await framesFor(name);
        frameCache.set(name, frames);
      }
      // O mouse pode ter andado enquanto o disco respondia.
      if (staged !== name || frames.length === 0) {
        return;
      }
      if (!poster) {
        stageImgEl.hidden = false;
      }
      let at = 0;
      flipTimer = setInterval(() => {
        if (!stageImgEl.isConnected) {
          stopFlip();
          return;
        }
        // Os quatro passos a mais são a pausa no fim do laço: sem ela
        // a animação reinicia no susto e ninguém vê onde ela termina.
        at = (at + 1) % (frames.length + 4);
        stageImgEl.src = at < frames.length ? frames[at] : poster || frames[0];
      }, FRAME_MS);
    }

    /** Volta o palco para o modelo escolhido. */
    function stageSelected(): void {
      const chosen = templates.find((item) => item.path === config.template);
      if (chosen) {
        showStage(chosen.name);
      }
    }

    /**
     * A grade de modelos.
     *
     * Uma linha por modelo, com o cartaz à esquerda: o painel é
     * estreito e duas colunas deixariam o cartaz do tamanho de um
     * selo — que é justamente o que a lista anterior, só de nomes,
     * já não resolvia. O escolhido ANIMA, passando os quadros que a
     * prévia guardou; os outros ficam parados, porque vinte laços
     * simultâneos seriam vinte trocas de imagem por quadro.
     */
    function renderGallery(): void {
      if (!galleryEl) return;
      stopFlip();
      if (templates.length === 0) {
        galleryEl.innerHTML =
          '<p class="tt-empty">Nenhum modelo nesta pasta. Escolha outra em ' +
          "Ajustes avançados.</p>";
        return;
      }
      galleryEl.innerHTML = templates
        .map((item, index) => {
          const poster = posters.get(item.name);
          const on = item.path === config.template;
          const style = styles.get(item.name);
          return (
            `<div class="tt-card" ${CONTROL} data-card="${index}" ` +
            `aria-pressed="${on ? "true" : "false"}">` +
            (poster
              ? `<img class="tt-thumb" src="${poster}" alt="">`
              : '<span class="tt-thumb is-empty"></span>') +
            '<span class="tt-card-text">' +
            `<span class="tt-name">${escapeHtml(item.name)}</span>` +
            (style?.fonte
              ? `<span class="tt-font">${escapeHtml(style.fonte)}</span>`
              : "") +
            "</span></div>"
          );
        })
        .join("");
      stageSelected();
    }

    // Delegação em vez de um ouvinte por cartão: são até 35 deles, e
    // `mouseover` sobe do filho — o `closest` reencontra o cartão.
    galleryEl?.addEventListener("mouseover", (event) => {
      const card = (event.target as Element)?.closest<HTMLElement>("[data-card]");
      const item = card ? templates[Number(card.dataset.card)] : null;
      if (item) {
        showStage(item.name);
      }
    });
    galleryEl?.addEventListener("mouseleave", () => stageSelected());

    galleryEl?.addEventListener("click", (event) => {
      const card = (event.target as Element)?.closest<HTMLElement>("[data-card]");
      if (!card) return;
      const index = Number(card.dataset.card);
      const chosen = templates[index];
      if (!chosen) return;
      config.template = chosen.path;
      persist();
      renderGallery();
      fontPick?.render();
      renderFontHint();
      syncApply();
    });

    const trackPick = trackHost
      ? mountDropdown(trackHost, {
          options: () => [
            { id: "-1", label: "Automática", meta: "a de cima que estiver livre" },
            ...Array.from({ length: Math.max(trackCount, 1) }, (_, index) => ({
              id: String(index),
              label: `V${index + 1}`,
              meta: index === trackCount - 1 ? "topo" : "",
            })),
          ],
          selected: () => String(config.trackIndex),
          onPick: (id) => {
            config.trackIndex = Number(id);
            persist();
            trackPick?.render();
          },
        })
      : null;
    if (trackPick) dropdowns.push(trackPick);

    /** O rótulo da fonte de fábrica do modelo escolhido. */
    function templateFont(): string {
      const chosen = templates.find((item) => item.path === config.template);
      return (chosen && styles.get(chosen.name)?.fonte) || "";
    }

    /**
     * O campo mostra, sem preencher, a fonte que o modelo já usa.
     *
     * Preencher seria mentir: campo vazio quer dizer "não mexa na
     * tipografia do modelo", e um valor escrito ali vira uma troca de
     * fonte que ninguém pediu.
     */
    function renderFontHint(): void {
      const model = templateFont();
      if (fontEl) {
        fontEl.placeholder = model ? `${model} (do modelo)` : "a do modelo";
        // O campo de texto separado morreu: a busca do menu já aceita
        // texto digitado, e dois lugares para dizer a mesma coisa é
        // um a mais para discordarem entre si.
        fontEl.hidden = true;
      }
      if (fieldsNoteEl) {
        const fields = templateFields();
        fieldsNoteEl.hidden = fields < 2;
        fieldsNoteEl.textContent =
          fields >= 2
            ? `Este modelo tem ${fields} campos de texto — uma linha para cada. ` +
              "Linha a menos deixa o campo vazio; linha a mais vai no último."
            : "";
      }
    }

    /** Quantos campos de texto o modelo escolhido tem. 1 quando não se sabe. */
    function templateFields(): number {
      const chosen = templates.find((item) => item.path === config.template);
      return (chosen && styles.get(chosen.name)?.campos) || 1;
    }

    /**
     * A fonte se escolhe da lista — e a lista se busca.
     *
     * Nome PostScript é coisa de arquivo ("Montserrat-ExtraBold", não
     * "Montserrat Bold"), então digitar de cabeça é errar; mas rolar
     * quase trezentas fontes é pior. Daí o menu com busca: clica,
     * digita "popp", Enter. Quem quiser mandar um nome que não está na
     * lista — fonte cujo arquivo tem outro nome — ainda pode: a última
     * linha aceita o que foi digitado como valor.
     */
    const fontPick = fontHost
      ? mountDropdown(fontHost, {
          options: () => [
            { id: "", label: "A do modelo", meta: templateFont() },
            ...fonts.map((name) => ({ id: name, label: name })),
          ],
          selected: () => config.font,
          search: {
            placeholder: "Buscar fonte…",
            useTyped: (typed) => `Usar "${typed}"`,
          },
          onPick: (id) => {
            config.font = id;
            if (fontEl) fontEl.value = id;
            persist();
            fontPick?.render();
          },
        })
      : null;
    if (fontPick) dropdowns.push(fontPick);

    function closeMenus(target: Element | null): void {
      for (const dropdown of dropdowns) {
        dropdown.closeUnless(target);
      }
    }
    const onPointer = (event: Event): void => closeMenus(event.target as Element | null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeMenus(null);
    };
    document.addEventListener("click", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    releaseDocument = () => {
      document.removeEventListener("click", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };

    context.setApplyLabel("INSERIR");
    context.setApplyEnabled(false);
    context.setResetLabel("LIMPAR");
    context.setResetHandler(null);
    context.setRefreshHandler(() => void readTracks());

    void (async () => {
      config = { ...(await settings.read()) };
      // A pasta vem do grupo `titles` (grupo de um — ver
      // `bridge/destination`). O `titles-config.json` segue como
      // espelho e como origem da migração de quem já tinha escolhido.
      const held = await readDestination("titles", destinationOf(config.library)).catch(
        () => null
      );
      if (held?.path) {
        config.library = held.path;
      }
      if (!config.library) {
        config.library = defaultLibrary();
      }
      if (fontEl) fontEl.value = config.font;
      renderLibrary();
      await Promise.all([loadTemplates(), readTracks(), loadFonts()]);
    })();

    function persist(): void {
      settings.save(config);
    }

    async function loadFonts(): Promise<void> {
      fonts = await listFonts();
      fontPick?.render();
      // Lista vazia é bug em potencial, não fato da vida: o relatório
      // em disco diz qual pasta recusou e por quê, sem depender do
      // console de dentro do Premiere.
      if (fonts.length === 0) {
        try {
          const space = await workspace();
          await write(
            space,
            "fonts-diag.txt",
            `Framelab — fontes · ${new Date().toISOString()}\n${lastFontNote()}\n`
          );
          console.warn("[Textos] nenhuma fonte listada:", lastFontNote());
        } catch {
          /* sem disco, sem diagnóstico: o campo de texto ainda serve */
        }
      }
    }

    fontEl?.addEventListener("change", () => {
      config.font = (fontEl.value ?? "").trim();
      persist();
    });

    function renderLibrary(): void {
      if (libEl) {
        libEl.textContent = config.library || "(nenhuma pasta escolhida)";
        libEl.title = config.library;
      }
    }

    /**
     * Relê a pasta.
     *
     * O modelo lembrado da sessão passada só continua selecionado se
     * ainda estiver lá — apontar para um arquivo que foi movido era
     * mostrar um nome na tela e falhar na hora de inserir.
     */
    async function loadTemplates(): Promise<void> {
      templates = await listTemplates(config.library);
      await afterTemplates();
    }

    async function afterTemplates(): Promise<void> {
      if (!templates.some((item) => item.path === config.template)) {
        config.template = templates[0]?.path ?? "";
        persist();
      }
      posters = await postersFor(templates.map((item) => item.name));
      styles = await readTemplateStyles();
      frameCache.clear();
      staged = "";
      renderGallery();
      fontPick?.render();
      renderFontHint();
      syncApply();
      if (templates.length > 0 && posters.size === 0) {
        // Prévia é o ponto inteiro da grade: quando nenhuma carrega, a
        // tela diz — em vez de parecer que os modelos é que sumiram.
        context.setStatus(
          "Modelos achados, mas sem prévia: rode \"Reler pasta\" ou gere as " +
            "miniaturas.",
          "error"
        );
      }
      if (templates.length === 0 && config.library) {
        context.setStatus(
          "Nenhum .mogrt nesta pasta — escolha outra em Ajustes avançados.",
          "error"
        );
      }
    }

    /** Quantas trilhas de vídeo a sequência tem, para o menu não mentir. */
    async function readTracks(): Promise<void> {
      const ppro = getPremiere();
      if (!ppro) return;
      try {
        const project = await ppro.Project.getActiveProject();
        const sequence = project ? await project.getActiveSequence() : null;
        trackCount = sequence ? await sequence.getVideoTrackCount() : 0;
      } catch {
        trackCount = 0;
      }
      if (trackCount > 0 && config.trackIndex > trackCount - 1) {
        // Trilha lembrada que não existe mais nesta sequência: volta
        // para a automática, que é sempre válida.
        config.trackIndex = -1;
        persist();
      }
      trackPick?.render();
    }

    function syncApply(): void {
      const total = pieces().length;
      const batch = nextBatch();
      const pronto =
        config.modo === "legenda"
          ? batch.length > 0
          : (textEl?.value ?? "").trim().length > 0;
      context.setApplyEnabled(!busy && pronto && config.template !== "");

      if (config.modo !== "legenda") {
        context.setApplyLabel("INSERIR");
      } else if (batch.length === 0) {
        context.setApplyLabel("ANIMAR LEGENDAS");
      } else if (total <= MAX_PIECES) {
        // Cabe numa tacada: o rótulo não precisa falar de partes.
        context.setApplyLabel(`ANIMAR ${total}`);
      } else {
        context.setApplyLabel(`ANIMAR ${applied + 1}–${applied + batch.length}`);
      }
      // Lote terminado com o botão apagado tem de DIZER que terminou,
      // senão parece defeito.
      if (config.modo === "legenda" && total > 0 && batch.length === 0 && !busy) {
        context.setStatus(
          `As ${total} legendas de ${srt?.name ?? "o arquivo"} já foram aplicadas. ` +
            "Escolha outro arquivo, ou mude o agrupamento para começar de novo.",
          "done"
        );
      }
    }

    /** Mostra o campo do modo escolhido e esconde o do outro. */
    function renderMode(): void {
      const legenda = config.modo === "legenda";
      if (textField) textField.hidden = legenda;
      if (srtField) srtField.hidden = !legenda;
      if (srtInfoEl) {
        const total = pieces().length;
        srtInfoEl.textContent = srt
          ? `${srt.name} · ${srt.cues.length} legendas` +
            (total !== srt.cues.length ? ` → ${total} peças` : "") +
            (applied > 0 ? ` · ${applied} aplicadas` : "")
          : "nenhum arquivo escolhido";
      }
      if (srtWarnEl) {
        // O aviso vem ANTES de apertar o botão — e agora ele é um
        // impedimento, não um conselho: acima do teto o Premiere põe as
        // mídias como offline e trava. Ver MAX_PIECES em applyCaptions.
        const total = pieces().length;
        srtWarnEl.hidden = total <= MAX_PIECES;
        srtWarnEl.textContent =
          total > MAX_PIECES
            ? `${total} peças vão em partes de ${MAX_PIECES}: cada legenda é um ` +
              "modelo importado, e de uma vez só o Premiere põe as mídias " +
              "offline e trava. Aplique, confira, e clique de novo para a " +
              "parte seguinte."
            : "";
      }
      for (const item of Array.from(
        container.querySelectorAll<HTMLElement>("[data-mode]")
      )) {
        item.setAttribute(
          "aria-pressed",
          item.dataset.mode === config.modo ? "true" : "false"
        );
      }
      syncApply();
    }

    modeSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element)?.closest<HTMLElement>("[data-mode]");
      if (!item || busy) return;
      config.modo = item.dataset.mode === "legenda" ? "legenda" : "titulo";
      persist();
      renderMode();
    });

    pickSrtEl?.addEventListener("click", () => void loadSrtFromDisk());
    projectSrtEl?.addEventListener("click", () => void listProjectSrt());

    /**
     * O .srt lido, de onde quer que tenha vindo, vira legendas.
     *
     * A sobreposição é resolvida AQUI, antes da timeline: dois blocos
     * que se encostam viram duas peças brigando pela mesma trilha, e
     * a segunda come o fim da primeira.
     */
    function acceptSrt(name: string, text: string): void {
      const cues = withoutOverlap(cuesFromSrt(text));
      if (cues.length === 0) {
        context.setStatus(`${name} não tem nenhuma legenda legível.`, "error");
        return;
      }
      srt = { name, cues };
      applied = 0;
      hideSrtList();
      renderMode();
      context.setStatus(`${cues.length} legendas lidas de ${name}.`, "done");
    }

    /** A parte que o próximo clique vai aplicar. */
    function nextBatch(): TimedCue[] {
      return pieces().slice(applied, applied + MAX_PIECES);
    }

    /** As peças que vão de fato para a timeline, já agrupadas. */
    function pieces(): TimedCue[] {
      if (!srt) {
        return [];
      }
      // Sem agrupar, o arquivo manda: nem tempo nem quebra de linha
      // são tocados — foi assim que o editor pediu, e um .srt já vem
      // quebrado por quem o gerou. Agrupando, a quebra é refeita,
      // porque a frase nova não tem mais as quebras de nenhuma das
      // antigas.
      if (config.group <= 0) {
        return withoutOverlap(srt.cues);
      }
      return wrapCues(withoutOverlap(groupCues(srt.cues, config.group)));
    }

    async function loadSrtFromDisk(): Promise<void> {
      if (busy) return;
      try {
        const source = await pickSrtFile();
        if (source) {
          acceptSrt(source.name, source.text);
        }
      } catch (cause) {
        context.setStatus(`Não deu para abrir o .srt: ${describeError(cause)}`, "error");
      }
    }

    function hideSrtList(): void {
      if (srtListEl) {
        srtListEl.hidden = true;
        srtListEl.innerHTML = "";
      }
    }

    /**
     * Os .srt que já estão no projeto — o mesmo gesto da Traduzir
     * Legenda, com a mesma busca: a legenda que o editor acabou de
     * gerar está numa bin, e ir buscá-la no disco é um caminho a mais
     * para um arquivo que o Premiere já sabe onde está.
     */
    async function listProjectSrt(): Promise<void> {
      if (busy) return;
      busy = true;
      if (projectSrtEl) {
        setDisabled(projectSrtEl, true);
        projectSrtEl.textContent = "Procurando…";
      }
      try {
        const found = await findSrtInProject();
        if (found.length === 0) {
          hideSrtList();
          context.setStatus(
            "Nenhum .srt no projeto aberto. Use Importar para trazer do disco.",
            "idle"
          );
          return;
        }
        if (srtListEl) {
          srtListEl.hidden = false;
          srtListEl.innerHTML =
            '<p class="tr-list-title">No projeto</p>' +
            found
              .map(
                (item) =>
                  `<div class="tr-list-item" ${CONTROL} data-path="${escapeHtml(item.path)}" ` +
                  `data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>`
              )
              .join("");
        }
        context.setStatus(
          `${found.length} ${found.length === 1 ? "legenda" : "legendas"} no projeto.`,
          "done"
        );
      } catch (cause) {
        context.setStatus(
          `Não deu para procurar no projeto: ${describeError(cause)}`,
          "error"
        );
      } finally {
        busy = false;
        if (projectSrtEl) {
          setDisabled(projectSrtEl, false);
          projectSrtEl.textContent = "Buscar no projeto";
        }
        syncApply();
      }
    }

    srtListEl?.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[data-path]");
      const path = item?.dataset.path;
      const name = item?.dataset.name ?? "legenda.srt";
      if (!path || busy) return;
      void (async () => {
        busy = true;
        context.setStatus("Lendo a legenda…");
        try {
          acceptSrt(name, await readAnyPath(path));
        } catch (cause) {
          context.setStatus(`Não deu para ler ${name}: ${describeError(cause)}`, "error");
        } finally {
          busy = false;
          syncApply();
        }
      })();
    });

    textEl?.addEventListener("input", syncApply);

    groupSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element)?.closest<HTMLElement>("[data-group]");
      if (!item || busy) return;
      config.group = Number(item.dataset.group);
      // Agrupar muda as peças: o que já entrou não corresponde mais à
      // lista nova, então a contagem volta ao começo.
      applied = 0;
      persist();
      renderSegs();
      renderMode();
    });

    durationSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element)?.closest<HTMLElement>("[data-duration]");
      if (!item) return;
      config.duration = item.dataset.duration ?? "model";
      persist();
      renderSegs();
    });

    whereSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element)?.closest<HTMLElement>("[data-where]");
      if (!item) return;
      config.atPlayhead = item.dataset.where !== "clip";
      persist();
      renderSegs();
    });

    function renderSegs(): void {
      for (const item of Array.from(
        container.querySelectorAll<HTMLElement>("[data-duration]")
      )) {
        item.setAttribute(
          "aria-pressed",
          item.dataset.duration === config.duration ? "true" : "false"
        );
      }
      for (const item of Array.from(
        container.querySelectorAll<HTMLElement>("[data-group]")
      )) {
        item.setAttribute(
          "aria-pressed",
          Number(item.dataset.group) === config.group ? "true" : "false"
        );
      }
      for (const item of Array.from(
        container.querySelectorAll<HTMLElement>("[data-where]")
      )) {
        const on = (item.dataset.where === "clip") !== config.atPlayhead;
        item.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    renderSegs();
    renderMode();

    reloadEl?.addEventListener("click", () => {
      if (busy) return;
      void loadTemplates().then(() => {
        if (templates.length > 0) {
          context.setStatus(
            `${templates.length} ${templates.length === 1 ? "modelo" : "modelos"} na pasta.`,
            "done"
          );
        }
      });
    });

    advToggleEl?.addEventListener("click", () => {
      if (!advContentEl) return;
      const open = advContentEl.hidden;
      advContentEl.hidden = !open;
      if (advIconEl) advIconEl.textContent = open ? "▴" : "▾";
    });

    pickLibEl?.addEventListener("click", () => void pickLibrary());

    /**
     * O diálogo nativo da pasta.
     *
     * É também o plano B da leitura: builds em que o `fs` do UXP recusa
     * caminho nativo devolvem as entradas por aqui, porque a escolha
     * concede o acesso junto.
     */
    async function pickLibrary(): Promise<void> {
      /*
       * O mesmo seletor de todas as ferramentas (`bridge/destination`).
       *
       * Esta era a quarta cópia. A pasta dos modelos é só de LEITURA —
       * o plugin não escreve nela —, mas ela é guardada no grupo
       * `titles`, que é grupo de um: trocar o modelo aqui não mexe na
       * pasta de nenhuma outra ferramenta, e nenhuma outra mexe nesta.
       */
      try {
        const picked = await pickAndSave("titles");
        if (!picked) return;
        config.library = picked.path;
        persist();
        renderLibrary();
        templates = await listTemplates(config.library);
        if (templates.length === 0) {
          /*
           * Plano B: ler pela entry de storage.
           *
           * Nas builds em que o `fs` do UXP recusa caminho nativo, a
           * leitura só sai por aqui. Antes a entry vinha direto do
           * seletor e valia por um instante; agora ela é reaberta pelo
           * token guardado, então o plano B vale também na SESSÃO
           * SEGUINTE, sem o editor reescolher a pasta.
           */
          try {
            const opened = await openDestination(picked);
            templates = await templatesFromEntry(opened.folder as never);
          } catch (cause) {
            console.warn("[Textos] a pasta não abriu pela entry:", cause);
          }
        }
        await afterTemplates();
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        context.setStatus(
          reason === NO_PICKER
            ? "Este build do Premiere não abre o seletor de pastas."
            : `Não deu para ler a pasta: ${reason}`,
          "error"
        );
      }
    }

    function showReport(lines: readonly string[]): void {
      if (!reportEl) return;
      const text = lines.join("\n").trim();
      reportEl.hidden = text.length === 0;
      reportEl.textContent = text;
    }

    context.setApplyHandler(async () => {
      const text = (textEl?.value ?? "").trim();
      const legenda = config.modo === "legenda";
      if (busy || !config.template || (legenda ? !srt : !text)) {
        return;
      }
      if (legenda && srt) {
        const batch = nextBatch();
        const total = pieces().length;
        await runCaptions(srt.name, batch, total);
        return;
      }
      busy = true;
      context.setApplyEnabled(false);
      context.setStatus("Inserindo o título…");
      showReport([]);
      try {
        const result = await applyTitle({
          templatePath: config.template,
          text,
          trackIndex: config.trackIndex,
          durationSeconds: secondsFor(config.duration),
          atPlayhead: config.atPlayhead,
          style: { font: config.font },
        });
        // O relatório aparece quando algo deu errado — com tudo certo
        // ele é ruído. No console ele fica sempre, para o caso de o
        // "certo" ter saído torto na timeline.
        console.log("[Textos]", result.report.join("\n"));
        showReport(result.ok ? [] : result.report);
        context.setStatus(result.message, result.ok ? "done" : "error");
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        busy = false;
        syncApply();
      }
    });

    /** O lote inteiro do .srt, com o mesmo contorno de erro do título. */
    async function runCaptions(
      name: string,
      list: TimedCue[],
      total: number
    ): Promise<void> {
      busy = true;
      cancelled = false;
      context.setApplyEnabled(false);
      context.setStatus(
        total > list.length
          ? `Animando as legendas ${applied + 1} a ${applied + list.length} de ${total}…`
          : `Animando ${list.length} legendas de ${name}…`
      );
      // Cancelar é obrigatório num laço que pode levar minutos: sem
      // isso, a única saída do editor seria fechar o Premiere.
      context.setResetLabel("CANCELAR");
      context.setResetHandler(() => {
        cancelled = true;
        context.setStatus("Cancelando…");
      });
      showReport([]);
      try {
        const result = await applyCaptions({
          templatePath: config.template,
          cues: list,
          trackIndex: config.trackIndex,
          style: { font: config.font },
          onProgress: (done, total) => {
            context.setStatus(`Legenda ${done} de ${total}…`);
          },
          cancelled: () => cancelled,
        });
        console.log("[Legendas]", result.report.join("\n"));
        showReport(result.ok ? [] : result.report);
        // Avança pelo que ENTROU, não pelo que foi pedido: peça que
        // falhou continua na fila da próxima parte.
        applied += result.inserted;
        renderMode();
        const faltam = total - applied;
        context.setStatus(
          result.ok && faltam > 0
            ? `${result.message} Faltam ${faltam} — confira a timeline e clique de novo.`
            : result.message,
          result.ok ? "done" : "error"
        );
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        busy = false;
        cancelled = false;
        context.setResetLabel("LIMPAR");
        context.setResetHandler(null);
        syncApply();
      }
    }
  },

  unmount(): void {
    stopFlip();
    releaseDocument?.();
    releaseDocument = null;
    void settings.flush();
  },
};

function markup(config: TitlesSettings): string {
  return (
    '<div class="zones">' +
      '<div class="zone is-wide">' +
        '<div class="field">' +
          '<span class="t-label">O que animar</span>' +
          '<div class="seg" data-mode-seg>' +
            `<div class="seg-item" ${CONTROL} data-mode="titulo">Um título</div>` +
            `<div class="seg-item" ${CONTROL} data-mode="legenda">Legenda (.srt)</div>` +
          "</div>" +
        "</div>" +
        '<div class="field" data-text-field>' +
          '<div class="field-head"><span class="t-label">Texto</span></div>' +
          '<textarea class="tt-text" data-text spellcheck="false" rows="2" ' +
          'placeholder="O texto do título — uma linha por quebra"></textarea>' +
          '<p class="tt-note" data-fields-note hidden></p>' +
        "</div>" +
        '<div class="field" data-srt-field hidden>' +
          '<span class="t-label">Arquivo</span>' +
          '<div class="tr-acts">' +
            `<div class="tr-btn" ${CONTROL} data-pick-srt>Importar arquivo…</div>` +
            `<div class="tr-btn" ${CONTROL} data-project-srt>Buscar no projeto</div>` +
          "</div>" +
          '<div class="tr-list" data-srt-list hidden></div>' +
          '<p class="dl-dest" data-srt-info>nenhum arquivo escolhido</p>' +
          '<div class="field-head"><span class="t-label" title="Junta legendas vizinhas numa frase só, sem atravessar pausa da fala. Menos peças, menos trabalho para o Premiere.">Agrupar</span></div>' +
          '<div class="seg" data-group-seg>' +
            GROUPS.map(
              (item) =>
                `<div class="seg-item" ${CONTROL} data-group="${item.seconds}">` +
                `${escapeHtml(item.label)}</div>`
            ).join("") +
          "</div>" +
          '<p class="tt-note" data-srt-warn hidden></p>' +
        "</div>" +
      "</div>" +

      '<div class="zone">' +
        '<div class="field">' +
          '<div class="field-head">' +
            '<span class="t-label">Modelo</span>' +
            `<span class="field-action" ${CONTROL} data-reload>Reler pasta</span>` +
          "</div>" +
          '<div class="tt-stage">' +
            '<img class="tt-stage-img" data-stage-img alt="" hidden>' +
            '<span class="tt-stage-name" data-stage-name></span>' +
          "</div>" +
          '<div class="tt-grid" data-gallery></div>' +
          '<p class="tt-tip">Passe o mouse para ver a animação; clique para escolher.</p>' +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label" title="As fontes instaladas nesta máquina. Vazio mantém a do modelo.">Fonte</span>' +
          '<div data-font-pick></div>' +
          '<input type="text" class="sil-path tt-font-typed" data-font spellcheck="false" ' +
          'placeholder="a do modelo" hidden>' +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Duração</span>' +
          '<div class="seg" data-duration-seg>' +
            DURATIONS.map(
              (item) =>
                `<div class="seg-item" ${CONTROL} data-duration="${item.id}">` +
                `${escapeHtml(item.label)}</div>`
            ).join("") +
          "</div>" +
        "</div>" +
      "</div>" +

      '<div class="zone">' +
        '<div class="field">' +
          '<span class="t-label">Trilha</span>' +
          '<div data-track-pick></div>' +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Onde começa</span>' +
          '<div class="seg" data-where-seg>' +
            `<div class="seg-item" ${CONTROL} data-where="playhead">Na agulha</div>` +
            `<div class="seg-item" ${CONTROL} data-where="clip">No clipe selecionado</div>` +
          "</div>" +
        "</div>" +
        '<pre class="dl-log" data-report hidden></pre>' +
      "</div>" +

      '<div class="sil-advanced">' +
        `<div class="sil-advanced-summary" ${CONTROL} data-adv-toggle>` +
          '<span class="sil-advanced-title">Ajustes avançados</span>' +
          '<span class="sil-advanced-icon" data-adv-icon>▾</span>' +
        "</div>" +
        '<div class="sil-advanced-content" data-adv-content hidden>' +
          '<div class="field">' +
            '<div class="field-head">' +
              '<span class="t-label" title="A pasta onde os .mogrt moram. Modelo novo é arquivo novo nela.">Pasta dos modelos</span>' +
              `<span class="field-action" ${CONTROL} data-pick-library>Escolher…</span>` +
            "</div>" +
            `<p class="dl-dest" data-library>${escapeHtml(config.library)}</p>` +
          "</div>" +
        "</div>" +
      "</div>" +
    "</div>"
  );
}
