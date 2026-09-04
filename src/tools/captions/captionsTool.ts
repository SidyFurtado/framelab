/**
 * Legendas — a ferramenta.
 *
 * Substitui a transcrição do Premiere pela do whisper, que erra menos
 * em pontuação e acento. Trabalha por FAIXA de áudio, não por clipe
 * selecionado: numa edição real o áudio vem separado do vídeo, em
 * várias faixas, e o editor já organizou isso — pedir que ele
 * selecione clipe a clipe é pedir que refaça o trabalho.
 *
 * Duas camadas de precisão, nesta ordem:
 *   1. O GLOSSÁRIO vira `--prompt`, enviesando o modelo para os nomes
 *      e o jargão do projeto.
 *   2. O mesmo glossário corrige o texto depois, de forma
 *      determinística, para o que o viés não fechou.
 *
 * O glossário é a única coisa aqui que melhora com o tempo — e melhora
 * porque o editor o alimenta, ou porque o painel aprende com as
 * correções que ele já faz à mão.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL, setDisabled, escapeHtml } from "../../shell/controls";
import { mountDropdown, type Dropdown } from "../../shell/dropdown";
import { mountSlider, type SliderHandle } from "../../shell/slider";
import { describeError } from "../../bridge/premiere";
import {
  scanTracks,
  transcribeTracks,
  learnFromCorrections,
  rebuildSrt,
  clipsFor,
  type TrackScan,
  type AudioTrackInfo,
} from "./applyCaptions";
import { mergeIntoGlossary } from "./learn";
import { MODELS, findModel, LANGUAGES, findLanguage } from "./whisper";
import {
  readConfig,
  writeConfig,
  readLastRun,
  SRT_RANGE,
  type CaptionConfig,
  type LastRun,
} from "./config";
import {
  SRT_DEFAULTS,
  SRT_PRESETS,
  matchPreset,
  buildCues,
  measureCues,
  type SrtOptions,
} from "./srt";
import { demoTranscript, previewMarkup } from "./preview";

/**
 * Os controles da régua, na ordem em que importam.
 *
 * Os quatro primeiros nomes são os do Premiere em "Criar legendas" —
 * quem já configurou legenda lá reconhece o que cada um faz. Os outros
 * dois são o que faz falta lá: um teto de duração e a pausa que
 * encerra a legenda.
 */
interface CapSlider {
  key: keyof SrtOptions;
  label: string;
  step: number;
  format: (value: number) => string;
}

const asSeconds = (value: number): string => `${value.toFixed(1).replace(".", ",")}s`;

const CAP_SLIDERS: readonly CapSlider[] = [
  {
    key: "maxLineChars",
    label: "Comprimento máximo",
    step: 1,
    format: (value) => `${Math.round(value)} caracteres`,
  },
  {
    key: "minCueSeconds",
    label: "Duração mínima",
    step: 0.1,
    format: asSeconds,
  },
  {
    key: "gapFrames",
    label: "Intervalo entre legendas",
    step: 1,
    format: (value) => {
      const v = Math.round(value);
      return v === 0 ? "0 quadros (sem gap)" : `${v} ${v === 1 ? "quadro" : "quadros"}`;
    },
  },
  {
    key: "readingCps",
    label: "Velocidade de leitura",
    step: 1,
    // 0 não é "zero caracteres por segundo", é a regra desligada — e
    // mostrar "0 car/s" faria parecer defeito.
    format: (value) => (value <= 0 ? "desligada" : `${Math.round(value)} car/s`),
  },
  { key: "maxCueSeconds", label: "Duração máxima", step: 0.25, format: asSeconds },
  { key: "gapSeconds", label: "Pausa para silêncio", step: 0.05, format: asSeconds },
];

let cancelActiveRun: (() => void) | null = null;
/** Solta os listeners que os menus penduram em `document`. */
let releaseDocument: (() => void) | null = null;
/** Solta os ouvintes que os deslizadores penduram em `document`. */
let releaseSliders: (() => void) | null = null;

export const captionsTool: Tool = {
  id: "captions",
  name: "Legendas",
  summary: "Transcrição mais precisa, por faixa de áudio",
  hint:
    "Escolha a faixa de áudio e transcreva — não precisa selecionar clipe. " +
    "Sai um .srt já dentro do seu projeto: arraste da janela do projeto para " +
    "a timeline e a legenda aparece.",
  category: "texto",
  glyph: "caption",
  available: true,
  usesSelection: false,

  mount(container: HTMLElement, context: ToolContext): void {
    let config: CaptionConfig = {
      model: "turbo",
      language: "pt",
      glossary: "",
      track: "all",
      srt: { ...SRT_DEFAULTS },
    };
    let scan: TrackScan | null = null;
    const capSliders = new Map<keyof SrtOptions, SliderHandle>();
    /** A última transcrição guardada — a fonte real da prévia. */
    let lastRun: LastRun | null = null;
    let busy = false;

    container.innerHTML = markup();

    const scanBtn = container.querySelector<HTMLElement>("[data-scan]");
    const learnBtn = container.querySelector<HTMLElement>("[data-learn]");
    const reportEl = container.querySelector<HTMLElement>("[data-report]");
    const emptyEl = container.querySelector<HTMLElement>("[data-empty]");
    const trackHost = container.querySelector<HTMLElement>("[data-track-pick]");
    const langHost = container.querySelector<HTMLElement>("[data-lang-pick]");
    const modelSeg = container.querySelector<HTMLElement>("[data-model-seg]");
    const glossaryEl = container.querySelector<HTMLTextAreaElement>("[data-glossary]");
    const glossaryNote = container.querySelector<HTMLElement>("[data-glossary-note]");
    const manualEl = container.querySelector<HTMLElement>("[data-manual]");
    const progressEl = container.querySelector<HTMLElement>("[data-progress]");
    const srtRail = container.querySelector<HTMLElement>("[data-srt-rail]");
    const srtNote = container.querySelector<HTMLElement>("[data-srt-note]");
    const linesSeg = container.querySelector<HTMLElement>("[data-lines-seg]");
    const capPreview = container.querySelector<HTMLElement>("[data-cap-preview]");
    const redoBtn = container.querySelector<HTMLElement>("[data-redo]");
    const capAdvToggle = container.querySelector<HTMLElement>("[data-cap-adv-toggle]");
    const capAdvContent = container.querySelector<HTMLElement>("[data-cap-adv-content]");
    const capAdvIcon = container.querySelector<HTMLElement>("[data-cap-adv-icon]");

    let timerInterval: number | null = null;
    let startTime = 0;

    // ── os menus ──────────────────────────────────────────────

    /**
     * As faixas viram opções só depois da leitura — antes disso o
     * painel não sabe quantas existem, e inventar A1..A4 seria mentir
     * sobre a sequência do editor.
     */
    const trackPick: Dropdown | null = trackHost
      ? mountDropdown(trackHost, {
          options: () => {
            if (!scan) {
              return [{ id: "all", label: "Todas as faixas" }];
            }
            const total = clipsFor(scan, "all").length;
            return [
              {
                id: "all",
                label: "Todas as faixas",
                meta: `${total} ${total === 1 ? "clipe" : "clipes"}`,
              },
              ...scan.tracks.map((track) => ({
                id: String(track.index),
                label: track.label,
                meta:
                  track.usable === 0
                    ? "vazia"
                    : `${track.usable} ${track.usable === 1 ? "clipe" : "clipes"}`,
              })),
            ];
          },
          selected: () => String(config.track),
          onPick: (id) => {
            config.track = id === "all" ? "all" : Number.parseInt(id, 10);
            persist();
            trackPick?.render();
            renderReport();
          },
        })
      : null;

    const langPick: Dropdown | null = langHost
      ? mountDropdown(langHost, {
          options: () =>
            LANGUAGES.map((language) => ({
              id: language.id,
              label: language.label,
            })),
          selected: () => config.language,
          onPick: (id) => {
            config.language = id;
            persist();
            langPick?.render();
          },
        })
      : null;

    const closeMenus = (target: Element | null): void => {
      trackPick?.closeUnless(target);
      langPick?.closeUnless(target);
    };
    const onDocumentPointer = (event: Event): void => closeMenus(event.target as Element | null);
    const onDocumentKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeMenus(null);
    };
    document.addEventListener("click", onDocumentPointer, true);
    document.addEventListener("keydown", onDocumentKey, true);
    releaseDocument = () => {
      document.removeEventListener("click", onDocumentPointer, true);
      document.removeEventListener("keydown", onDocumentKey, true);
    };

    context.setApplyLabel("TRANSCREVER");
    context.setApplyEnabled(false);
    context.setResetLabel("LIMPAR");
    context.setResetHandler(null);

    void (async () => {
      config = await readConfig();
      if (glossaryEl) glossaryEl.value = config.glossary;
      lastRun = await readLastRun();
      trackPick?.render();
      langPick?.render();
      syncModel();
      syncGlossaryNote();
      syncCaptionFormat();
      // A sequência é lida sozinha ao abrir: sem isso o editor tinha de
      // apertar um botão antes de poder escolher a faixa, e a escolha é
      // a primeira decisão da ferramenta.
      await runScan(true);
    })();

    function persist(): void {
      void writeConfig(config);
    }

    // ── qualidade ─────────────────────────────────────────────

    function syncModel(): void {
      for (const item of modelSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        item.setAttribute("aria-pressed", String(item.dataset.model === config.model));
      }
    }

    modelSeg?.addEventListener("click", (event) => {
      const id = (event.target as Element | null)
        ?.closest<HTMLElement>("[data-model]")?.dataset.model;
      if (!id) return;
      config.model = id;
      persist();
      syncModel();
    });

    // ── formato da legenda ────────────────────────────────────

    /**
     * Todo ajuste da régua passa por aqui: prende ao intervalo, salva,
     * e redesenha a prévia. Sem o redesenho o controle seria um número
     * sem consequência visível, que é o que ele já era.
     */
    function setSrt(key: keyof SrtOptions, value: number): void {
      if (!Number.isFinite(value)) return;
      const [low, high] = SRT_RANGE[key];
      const next: SrtOptions = { ...config.srt, [key]: Math.min(high, Math.max(low, value)) };

      // Piso e teto de duração se empurram em vez de se contradizerem:
      // um teto abaixo do piso produziria uma legenda por palavra, e o
      // editor nunca entenderia por quê.
      if (key === "minCueSeconds") {
        next.maxCueSeconds = Math.max(next.maxCueSeconds, next.minCueSeconds + 0.5);
      } else if (key === "maxCueSeconds") {
        next.minCueSeconds = Math.min(next.minCueSeconds, next.maxCueSeconds - 0.5);
      }

      config.srt = next;
      persist();
      syncCaptionFormat();
    }

    srtRail?.addEventListener("click", (event) => {
      const id = (event.target as Element | null)
        ?.closest<HTMLElement>("[data-preset]")?.dataset.preset;
      const preset = SRT_PRESETS.find((entry) => entry.id === id);
      if (!preset) return;
      config.srt = { ...preset.options };
      persist();
      syncCaptionFormat();
    });

    linesSeg?.addEventListener("click", (event) => {
      const raw = (event.target as Element | null)
        ?.closest<HTMLElement>("[data-lines]")?.dataset.lines;
      if (raw) setSrt("maxLines", Number.parseInt(raw, 10));
    });

    for (const spec of CAP_SLIDERS) {
      const rail = container.querySelector<HTMLElement>(`[data-cap="${spec.key}"]`);
      if (!rail) continue;
      const [low, high] = SRT_RANGE[spec.key];
      capSliders.set(
        spec.key,
        mountSlider(rail, {
          min: low,
          max: high,
          step: spec.step,
          value: SRT_DEFAULTS[spec.key],
          label: spec.label,
          format: spec.format,
          output: container.querySelector<HTMLElement>(`[data-cap-out="${spec.key}"]`),
          onInput: (value) => setSrt(spec.key, value),
        })
      );
    }

    capAdvToggle?.addEventListener("click", () => {
      if (!capAdvContent) return;
      const willOpen = capAdvContent.hidden;
      capAdvContent.hidden = !willOpen;
      if (capAdvIcon) capAdvIcon.style.transform = willOpen ? "rotate(180deg)" : "";
    });

    function syncCaptionFormat(): void {
      const active = matchPreset(config.srt);
      for (const pill of srtRail?.querySelectorAll<HTMLElement>(".preset-pill") ?? []) {
        pill.classList.toggle("is-active", pill.dataset.preset === active);
      }
      if (srtNote) {
        srtNote.textContent =
          SRT_PRESETS.find((entry) => entry.id === active)?.note ??
          "Personalizado — estes números já não são os de nenhum preset.";
      }

      for (const item of linesSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        item.setAttribute(
          "aria-pressed",
          String(Number(item.dataset.lines) === config.srt.maxLines)
        );
      }

      // `set` não dispara `onInput`, então o acerto entre duração
      // mínima e máxima não vira laço.
      for (const spec of CAP_SLIDERS) {
        capSliders.get(spec.key)?.set(config.srt[spec.key]);
      }

      renderCapPreview();
    }

    /** `23,976` — o relógio como o editor o vê nos ajustes da sequência. */
    function showFps(value: number): string {
      return String(Number(value.toFixed(3))).replace(".", ",");
    }

    function renderCapPreview(): void {
      if (!capPreview) return;
      const fps = scan?.fps || lastRun?.fps || 0;
      const source = lastRun?.transcript ?? demoTranscript();
      const cues = buildCues(source, config.srt, fps);
      capPreview.innerHTML = previewMarkup(
        cues,
        measureCues(cues, config.srt),
        config.srt,
        lastRun
          ? `da sua última transcrição · ${lastRun.label}` +
              (fps > 0 ? ` · ${showFps(fps)} fps` : "")
          : "fala de demonstração — transcreva uma vez e a prévia passa a " +
            "usar o seu material"
      );
      if (redoBtn) redoBtn.hidden = !lastRun;
    }

    redoBtn?.addEventListener("click", () => void runRebuild());

    /**
     * Refaz o .srt com a régua atual, sem ouvir nada de novo.
     *
     * É o que torna os controles utilizáveis: a resposta a "e se fossem
     * 32 caracteres?" custa um segundo, não uma transcrição inteira.
     */
    async function runRebuild(): Promise<void> {
      if (busy || !lastRun) return;
      busy = true;
      if (redoBtn) {
        setDisabled(redoBtn, true);
        redoBtn.textContent = "Gerando…";
      }
      try {
        const result = await rebuildSrt(config.srt);
        context.setStatus(result.message, result.ok ? "done" : "error");
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        busy = false;
        if (redoBtn) {
          setDisabled(redoBtn, false);
          redoBtn.textContent = "Refazer o .srt com estes ajustes";
        }
      }
    }

    // ── glossário ─────────────────────────────────────────────

    glossaryEl?.addEventListener("input", () => {
      config.glossary = glossaryEl.value;
      syncGlossaryNote();
    });
    glossaryEl?.addEventListener("change", () => persist());

    function syncGlossaryNote(): void {
      if (!glossaryNote) return;
      const count = config.glossary
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.startsWith("#")).length;
      glossaryNote.textContent =
        count === 0
          ? "Um termo por linha: nomes, marcas, jargão. Já vem com o vocabulário de edição de fábrica."
          : `${count} ${count === 1 ? "termo seu" : "termos seus"}, mais o vocabulário de fábrica.`;
    }

    // ── ler a sequência ───────────────────────────────────────

    scanBtn?.addEventListener("click", () => void runScan());

    async function runScan(silent = false): Promise<void> {
      if (busy) return;
      busy = true;
      if (scanBtn) {
        setDisabled(scanBtn, true);
        scanBtn.textContent = "Lendo…";
      }
      try {
        scan = await scanTracks();
        // A faixa guardada pode não existir nesta sequência.
        if (
          config.track !== "all" &&
          !scan.tracks.some((track) => track.index === config.track)
        ) {
          config.track = "all";
        }
        trackPick?.render();
        renderReport();
        // A grade de quadros veio com a leitura: a prévia estava
        // desalinhada até aqui.
        renderCapPreview();
        const chosen = clipsFor(scan, config.track).length;
        context.setApplyEnabled(chosen > 0);
        context.setStatus(
          scan.usable === 0
            ? "Nenhum clipe de áudio com arquivo nesta sequência."
            : `${scan.tracks.length} ${scan.tracks.length === 1 ? "faixa" : "faixas"} · ` +
              `${chosen} ${chosen === 1 ? "clipe" : "clipes"} na escolha atual.`,
          scan.usable > 0 ? "done" : "idle"
        );
      } catch (cause) {
        scan = null;
        // A leitura automática da abertura não grita: o painel pode ter
        // sido aberto sem projeto, e isso não é erro do editor.
        if (!silent) {
          context.setStatus(describeError(cause), "error");
        }
      } finally {
        busy = false;
        if (scanBtn) {
          setDisabled(scanBtn, false);
          scanBtn.textContent = "Reler a sequência";
        }
      }
    }

    // ── progresso e carregamento ─────────────────────────────

    function showProgress(stage: string | null): void {
      if (!progressEl) return;
      if (stage === null) {
        if (timerInterval !== null) {
          window.clearInterval(timerInterval);
          timerInterval = null;
        }
        progressEl.hidden = true;
        progressEl.innerHTML = "";
        return;
      }

      progressEl.hidden = false;
      if (timerInterval === null) {
        startTime = Date.now();
        timerInterval = window.setInterval(updateElapsed, 500);
      }

      function formatElapsed(): string {
        const total = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
      }

      function updateElapsed(): void {
        const timeEl = progressEl?.querySelector<HTMLElement>("[data-elapsed]");
        if (timeEl) timeEl.textContent = formatElapsed();
      }

      const stageText = escapeHtml(stage || "Transcrevendo áudio…");
      const elapsed = formatElapsed();

      progressEl.innerHTML =
        '<div class="cc-progress-head">' +
          `<span class="cc-progress-title"><span class="cc-progress-spinner"></span><span>${stageText}</span></span>` +
          `<span class="cc-progress-time" data-elapsed>${elapsed}</span>` +
        '</div>' +
        '<div class="cc-progress-track"><span class="cc-progress-fill"></span></div>' +
        '<p class="cc-progress-desc">Processando áudio com Whisper. O resultado vira um arquivo .srt pronto para uso.</p>';
    }

    // ── transcrever ───────────────────────────────────────────

    context.setApplyHandler(async () => {
      if (!scan || busy) return;
      if (clipsFor(scan, config.track).length === 0) return;
      busy = true;
      let cancelled = false;
      cancelActiveRun = () => {
        cancelled = true;
      };
      context.setApplyEnabled(false);
      context.setApplyLabel("TRANSCREVENDO…");
      hideManual();
      showProgress("Iniciando transcrição…");

      try {
        const result = await transcribeTracks(scan, {
          model: findModel(config.model),
          language: config.language,
          glossaryText: config.glossary,
          track: config.track,
          srt: config.srt,
          onStage: (text: string) => {
            showProgress(text);
            context.setStatus(`${findLanguage(config.language).label} · ${text}`);
          },
          cancelled: () => cancelled,
          onManual: showManual,
        });
        showProgress(null);
        renderReport();
        // A prévia deixa a fala de demonstração e passa a mostrar o
        // material do editor — é a partir daqui que os controles
        // respondem sobre o vídeo dele.
        lastRun = await readLastRun();
        syncCaptionFormat();
        context.setStatus(result.message, result.ok ? "done" : "error");
        showStages(result.ok ? [] : result.stages);
        if (result.imported > 0) {
          context.setResetHandler(() => clearAll());
        } else {
          context.setApplyEnabled(true);
        }
      } catch (cause) {
        showProgress(null);
        context.setStatus(describeError(cause), "error");
        context.setApplyEnabled(true);
      } finally {
        showProgress(null);
        busy = false;
        cancelActiveRun = null;
        context.setApplyLabel("TRANSCREVER");
      }
    });

    function clearAll(): void {
      scan = null;
      trackPick?.render();
      renderReport();
      context.setResetHandler(null);
      context.setApplyEnabled(false);
      context.setStatus("", "idle");
    }

    // ── aprender com as correções ─────────────────────────────

    learnBtn?.addEventListener("click", () => void runLearn());

    async function runLearn(): Promise<void> {
      if (busy) return;
      busy = true;
      if (learnBtn) {
        setDisabled(learnBtn, true);
        learnBtn.textContent = "Comparando…";
      }
      try {
        const fresh = scan ?? (await scanTracks());
        scan = fresh;
        const { candidates, checked } = await learnFromCorrections(fresh, config.track);

        if (checked === 0) {
          context.setStatus(
            "Nada para comparar — transcreva pelo painel, corrija à mão, e volte aqui.",
            "idle"
          );
          return;
        }
        if (candidates.length === 0) {
          context.setStatus(
            `${checked} ${checked === 1 ? "clipe conferido" : "clipes conferidos"} — nenhuma correção nova.`,
            "done"
          );
          return;
        }
        const { text, added } = mergeIntoGlossary(config.glossary, candidates);
        if (added.length === 0) {
          context.setStatus("As correções encontradas já estão no glossário.", "done");
          return;
        }
        config.glossary = text;
        if (glossaryEl) glossaryEl.value = text;
        syncGlossaryNote();
        persist();
        context.setStatus(
          `${added.length} ${added.length === 1 ? "termo aprendido" : "termos aprendidos"}: ` +
            added.slice(0, 4).join(", ") +
            (added.length > 4 ? "…" : "") +
            " — já valem na próxima.",
          "done"
        );
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        busy = false;
        if (learnBtn) {
          setDisabled(learnBtn, false);
          learnBtn.textContent = "Aprender com minhas correções";
        }
      }
    }

    // ── relatório ─────────────────────────────────────────────

    function renderReport(): void {
      if (!reportEl) return;
      if (!scan) {
        reportEl.innerHTML = "";
        if (emptyEl) emptyEl.hidden = false;
        return;
      }
      if (emptyEl) emptyEl.hidden = true;

      const shown =
        config.track === "all"
          ? scan.tracks
          : scan.tracks.filter((track) => track.index === config.track);
      reportEl.innerHTML = shown.map(trackRow).join("");
    }

    function trackRow(track: AudioTrackInfo): string {
      const words = track.clips.reduce((total, clip) => total + clip.words, 0);
      const meta =
        words > 0
          ? `<span class="sil-row-cuts">${words} palavras</span>`
          : track.usable === 0
            ? '<span class="sil-row-skip">vazia</span>'
            : `<span class="sil-row-time">${track.usable} ${track.usable === 1 ? "clipe" : "clipes"}</span>`;

      let html =
        '<div class="sil-row-group"><div class="sil-row' +
        (words > 0 ? " is-ready" : "") +
        `"><span class="sil-row-name">${track.label}</span>${meta}</div>`;

      // As correções do glossário, quando houve — é o que mostra ao
      // editor que o vocabulário dele está trabalhando.
      const fixes = track.clips.flatMap((clip) => clip.corrections).slice(0, 8);
      if (fixes.length > 0) {
        html += '<div class="fl-hits">';
        for (const fix of fixes) {
          html +=
            '<span class="fl-hit is-tag" title="corrigido pelo glossário">' +
            `<b>${escapeHtml(fix.to)}</b>${escapeHtml(fix.from)}</span>`;
        }
        html += "</div>";
      }
      return html + "</div>";
    }

    function showManual(scriptPath: string, reason: string): void {
      if (!manualEl) return;
      manualEl.hidden = false;
      manualEl.innerHTML =
        `<p class="sil-manual-why">O sistema não executou o script (${escapeHtml(reason)}). ` +
        "Dê um duplo clique nele e volte — o painel continua esperando.</p>" +
        `<p class="sil-manual-path">${escapeHtml(scriptPath)}</p>`;
    }

    /**
     * As etapas da última tentativa, quando ela falhou.
     *
     * "A legenda não aconteceu" pode ser cinco coisas diferentes; esta
     * lista diz qual, e é o que o editor copia para eu consertar sem
     * adivinhar.
     */
    function showStages(stages: readonly string[]): void {
      if (!manualEl) return;
      if (stages.length === 0) {
        manualEl.hidden = true;
        manualEl.innerHTML = "";
        return;
      }
      manualEl.hidden = false;
      manualEl.innerHTML =
        '<p class="sil-manual-why">Onde parou:</p>' +
        `<p class="sil-manual-path">${stages.map(escapeHtml).join("\n")}</p>`;
    }

    function hideManual(): void {
      if (manualEl) {
        manualEl.hidden = true;
        manualEl.innerHTML = "";
      }
    }

    context.setRefreshHandler(null);
    releaseSliders = () => {
      for (const handle of capSliders.values()) handle.destroy();
      capSliders.clear();
    };
  },

  unmount(): void {
    cancelActiveRun?.();
    cancelActiveRun = null;
    releaseDocument?.();
    releaseDocument = null;
    releaseSliders?.();
    releaseSliders = null;
  },
};

// ── markup ─────────────────────────────────────────────────────────

/**
 * Exportado para poder ser RENDERIZADO fora do Premiere.
 *
 * O painel tem 320px de largura e os rótulos são longos em português;
 * a única forma de saber se um botão quebra em duas linhas ou se a
 * prévia empurra os controles para fora da tela é desenhar isto com o
 * CSS de verdade e olhar. Já pegou um botão quebrado antes de o editor
 * ver.
 */
export function markup(): string {
  const models = MODELS.map(
    (model) =>
      `<div class="seg-item" ${CONTROL} data-model="${model.id}" ` +
      `title="${escapeHtml(model.note)}">${escapeHtml(model.label)}</div>`
  ).join("");

  const srtPresets = SRT_PRESETS.map(
    (preset) =>
      `<div class="preset-pill" ${CONTROL} data-preset="${preset.id}">` +
      `${escapeHtml(preset.name)}</div>`
  ).join("");

  const lineCounts = [1, 2, 3]
    .map(
      (count) =>
        `<div class="seg-item" ${CONTROL} data-lines="${count}">` +
        `${count} ${count === 1 ? "linha" : "linhas"}</div>`
    )
    .join("");

  const capSlider = (key: keyof SrtOptions): string => {
    const spec = CAP_SLIDERS.find((entry) => entry.key === key);
    if (!spec) return "";
    return (
      '<div class="field">' +
      '<div class="field-head">' +
      `<span class="t-label">${spec.label}</span>` +
      `<span class="field-val" data-cap-out="${key}">${spec.format(SRT_DEFAULTS[key])}</span>` +
      "</div>" +
      `<div class="slider-row"><div data-cap="${key}"></div></div>` +
      "</div>"
    );
  };

  return (
    '<div class="zones">' +
      '<div class="zone">' +
        '<div class="field">' +
          '<span class="t-label">Faixa de áudio</span>' +
          '<div data-track-pick></div>' +
          '<p class="field-note">A faixa vai inteira para o motor, com os silêncios ' +
          "entre os clipes — é o que faz uma frase cortada no meio sair inteira.</p>" +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Idioma</span>' +
          '<div data-lang-pick></div>' +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Qualidade</span>' +
          `<div class="seg" data-model-seg>${models}</div>` +
          '<p class="field-note">O modelo baixa sozinho na primeira vez.</p>' +
        "</div>" +
      "</div>" +

      // ── a régua da legenda ────────────────────────────────────
      // Vem logo depois de o QUE transcrever, porque é o COMO sai — e
      // porque a prévia abaixo responde sem esperar o motor.
      '<div class="zone">' +
        '<div class="field">' +
          '<span class="t-label">Formato da legenda</span>' +
          `<div class="preset-rail" data-srt-rail>${srtPresets}</div>` +
          '<p class="field-note" data-srt-note></p>' +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Linhas</span>' +
          `<div class="seg" data-lines-seg>${lineCounts}</div>` +
        "</div>" +
        capSlider("maxLineChars") +
        capSlider("minCueSeconds") +
        capSlider("gapFrames") +
        '<p class="field-note">Com 0 quadros de intervalo, a legenda seguinte entra ' +
        "imediatamente sem piscar tela preta, exceto quando houver momento de silêncio na fala.</p>" +

        // A prévia fica ENCOSTADA nos controles principais. Mais
        // abaixo, num painel de 320px, ela sai da tela justamente
        // enquanto o deslizador está sendo arrastado — que é o único
        // momento em que ela serve para alguma coisa.
        '<div data-cap-preview></div>' +
        `<div class="cc-redo" ${CONTROL} data-redo hidden>` +
        "Refazer o .srt com estes ajustes</div>" +

        '<div class="sil-advanced">' +
          `<div class="sil-advanced-summary" ${CONTROL} data-cap-adv-toggle>` +
            '<span class="sil-advanced-title">Ajustes adicionais</span>' +
            '<span class="sil-advanced-icon" data-cap-adv-icon>▾</span>' +
          "</div>" +
          '<div class="sil-advanced-content" data-cap-adv-content hidden>' +
            capSlider("readingCps") +
            capSlider("maxCueSeconds") +
            capSlider("gapSeconds") +
            '<p class="field-note"><b>Pausa para silêncio</b> é o tempo de silêncio na fala que ' +
            "encerra uma legenda em vez de emendar na próxima. " +
            "<b>Velocidade de leitura</b> garante tempo de leitura aos olhos.</p>" +
          "</div>" +
        "</div>" +
      "</div>" +

      '<div class="zone">' +
        '<div class="field">' +
          '<div class="field-head"><span class="t-label">Glossário do projeto</span></div>' +
          '<textarea class="dl-urls" data-glossary spellcheck="false" rows="4" ' +
          'placeholder="Framelab&#10;Sidy Furtado&#10;nome do cliente"></textarea>' +
          '<p class="field-note" data-glossary-note></p>' +
        "</div>" +
      "</div>" +

      '<div class="zone">' +
        /*
         * O aviso vem ANTES, não como surpresa.
         *
         * O painel roda o ffmpeg por dentro de um pequeno aplicativo
         * que ele mesmo escreve, e esse aplicativo não é assinado.
         * O macOS então pergunta duas coisas na primeira vez — acesso
         * à pasta da mídia (necessário) e microfone (não). Ser
         * emboscado por esses diálogos é assustador e parece malware;
         * dizer antes o que vai aparecer e o que responder é o mínimo.
         */
        '<div class="cc-heads-up">' +
          '<p class="cc-heads-up-title">Na primeira vez o macOS vai perguntar duas coisas</p>' +
          '<p class="cc-heads-up-body"><b>Pasta da sua mídia</b> (Google Drive, Documentos…): ' +
          "<b>permita</b> — é de onde o áudio é lido.<br>" +
          "<b>Microfone</b>: <b>pode negar</b>. O plugin nunca grava áudio; " +
          "o pedido vem de uma biblioteca que o conversor de áudio carrega e não usa. " +
          "Negando, tudo funciona igual.</p>" +
        "</div>" +
      "</div>" +

      '<div class="zone is-wide">' +
        '<div class="sil-empty" data-empty>' +
          '<p class="sil-empty-title">Pronto para transcrever</p>' +
          '<p class="sil-empty-desc">Escolha a faixa acima e transcreva. ' +
          "O resultado vira um .srt no seu projeto, pronto para arrastar " +
          "para a timeline.</p>" +
        "</div>" +
        '<div class="cc-actions">' +
          `<div class="org-scan" ${CONTROL} data-scan>Reler a sequência</div>` +
          `<div class="cc-learn" ${CONTROL} data-learn ` +
          'title="Compara o que o plugin escreveu com o que você corrigiu à mão">' +
          "Aprender com minhas correções</div>" +
        "</div>" +
        '<div class="sil-manual" data-manual hidden></div>' +
        '<div class="cc-progress" data-progress hidden></div>' +
        '<div class="sil-report" data-report></div>' +
      "</div>" +
    "</div>"
  );
}
