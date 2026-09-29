import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL, escapeHtml, setDisabled } from "../../shell/controls";
import { mountDropdown, type Dropdown } from "../../shell/dropdown";
import { mountSlider } from "../../shell/slider";
import { createToolSettings, clampNumber, warmToolSettings } from "../../bridge/settings";
import { sfxSettings } from "../sfx/config";
import { forgetOpenFolders, type SfxFolder } from "../sfx/folder";
import { destinationOf, pickAndSave, readDestination } from "../../bridge/destination";
import type { SfxCatalog } from "../sfx/pack";
import { knownSeconds, setFolder } from "../sfx/store";
import { previewSource, silenceUrl, warmSilence } from "../sfx/preview";
import { playUrl, prime, setHost, stopPlayback, warmPlayer } from "../sfx/player";
import { describe, workspace, write } from "../silence/workspace";
import { choiceById, DEFAULT_OPTIONS, FAMILY_CATEGORIES, FAMILY_LABELS, familyFor, LABELS, MAX_NEW_TRACKS, rankSounds, selectEvents, varietyPick, withRoom,
  type DetectionOptions, type EventKind, type Family, type SoundChoice, type VisualEvent } from "./plan";
import { activeTimeline, alreadyPlaced, readAudio, scanTimeline, type Scope, type TimelineScan } from "./scan";
import { anchorsOf, eventsFrom, presetFor, soundedAlready, templateKey, type Anchor, type TitleMode } from "./identity";
import { prepareSounds, soundLibrary } from "./assets";
import { applySounds, isPlaced, loadPlaced, readLastBatch, undoLastBatch } from "./apply";
import "./soundDesign.css";

/**
 * `sounds`: the take chosen for every event of a family ("auto" or absent = the ranking decides).
 * `version`: the event filters changed meaning in 3 (camera motion off by default); older saved filters are dropped.
 */
/** `titles`: what each title template asks for, keyed by its normalized name. */
/** `respect`: leave alone every moment that already has a sound effect of the editor. */
interface Settings { version: number; scope: Scope; options: DetectionOptions; level: number; sounds: Partial<Record<Family, string>>; titles: Record<string, TitleMode>; respect: boolean }
const FAMILIES = Object.keys(FAMILY_LABELS) as Family[];
const defaults: Settings = { version: 3, scope: "selection", options: DEFAULT_OPTIONS, level: 0, sounds: {}, titles: {}, respect: true };
const settings = createToolSettings<Settings>("sound-design-config.json", defaults, (raw) => ({
  version: 3,
  scope: raw.scope === "sequence" ? "sequence" : "selection",
  level: clampNumber(raw.level, -12, 6, 0),
  options: Object.fromEntries(Object.entries(DEFAULT_OPTIONS).map(([key, value]) => [key,
    key === "density" ? (["light", "balanced", "full"].includes(raw.options?.density ?? "") ? raw.options!.density : value)
      : raw.version === 3 && typeof raw.options?.[key as EventKind] === "boolean" ? raw.options[key as EventKind] : value,
  ])) as unknown as DetectionOptions,
  sounds: Object.fromEntries(FAMILIES.filter((f) => typeof raw.sounds?.[f] === "string").map((f) => [f, raw.sounds![f]!])),
  titles: Object.fromEntries(Object.entries(raw.titles ?? {}).filter(([, v]) => v === "words" || v === "entry" || v === "none")) as Record<string, TitleMode>,
  respect: raw.respect !== false,
}));
warmToolSettings(settings);
interface Row { event: VisualEvent; choices: SoundChoice[]; pick: number; enabled: boolean; placed: boolean }
let dispose: (() => void) | null = null;
/** A two-minute ad with word clicks is ~450 events; past this, analyse a selection. */
const MAX_BATCH = 1000;
const clock = (n: number): string => `${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toFixed(2).padStart(5, "0")}`;

export const soundDesignTool: Tool = {
  id: "sound-design", name: "SFX Automático", category: "audio", glyph: "sfx-auto", available: true, usesSelection: false,
  summary: "O som do que está na tela",
  hint: "Cada elemento recebe o som do que ele é: títulos do Textos Animados ganham um clique por palavra no ritmo da animação, film burn ganha film burn, flash ganha obturador, glitch ganha glitch, gráfico curto ganha swoosh. O que não tem identidade clara (light leak, textura, B-roll, Adjustment Layer sem efeito reconhecido) fica em silêncio, e onde você já pôs SFX ele não mexe. Zoom e movimento de câmera só entram se você ligar. A trilha de legendas nunca recebe SFX.",
  mount(container: HTMLElement, context: ToolContext): void {
    const initial = settings.peek() ?? defaults;
    const config = { ...initial, options: { ...initial.options }, sounds: { ...initial.sounds }, titles: { ...initial.titles } };
    let alive = true, busy = false, cancelled = false, previewToken = 0, previewId = "", dirty = false;
    let release: (() => void) | null = null;
    let folder: SfxFolder | null = null, scan: TimelineScan | null = null, catalog: SfxCatalog | null = null;
    let rows: Row[] = [], hasUndo = false;
    /** What the review shows, before the filters: derived from what each element is. */
    let events: VisualEvent[] = [];
    let anchors: Anchor[] = [];
    let done = new Set<string>();
    let templateMenus: Array<{ key: string; menu: Dropdown }> = [];
    /** The editor's choice for a template, else what the preset's own animation asks for. */
    const modeOf = (template: string): TitleMode => config.titles[templateKey(template)] ?? presetFor(template).mode;
    const derive = (): void => { if (scan) events = eventsFrom(anchors, scan.frame, config.respect ? done : new Set(), modeOf); };
    /** One line per title template on the timeline: the editor says once what it asks for. */
    const mountTemplates = (): void => {
      const host = el("[data-templates]");
      const found = new Map<string, { name: string; count: number }>();
      for (const a of anchors) if (a.role === "title" && a.template) {
        const key = templateKey(a.template);
        found.set(key, { name: a.template, count: (found.get(key)?.count ?? 0) + 1 });
      }
      host.hidden = found.size === 0;
      host.innerHTML = found.size ? `<p class="sd-families-title">Títulos do Textos Animados</p>` + [...found].map(([, t], i) =>
        `<div class="sd-family"><span class="sd-family-label" title="${escapeHtml(t.name)}">${escapeHtml(t.name)} <span class="sd-count">${t.count}×</span></span>` +
        `<div class="sd-family-pick"><div data-template-pick="${i}"></div></div></div>`).join("") : "";
      templateMenus = [...found].map(([key, t], i) => ({ key, menu: mountDropdown(host.querySelector<HTMLElement>(`[data-template-pick="${i}"]`)!, {
        options: () => {
          const preset = presetFor(t.name);
          const mark = (mode: TitleMode): string | undefined => (preset.mode === mode ? `padrão · ${preset.look}` : undefined);
          return [{ id: "words", label: "Palavra por palavra", meta: mark("words") ?? "um som por palavra" },
            { id: "entry", label: "Um som na entrada", meta: mark("entry") ?? "swoosh" }, { id: "none", label: "Sem som", meta: mark("none") }];
        },
        selected: () => config.titles[key] ?? presetFor(t.name).mode,
        onPick: (id) => { if (busy) return; config.titles[key] = id as TitleMode; remember(); derive(); rebuild(); },
      }) }));
      menus = [scopeMenu, densityMenu, ...familyMenus, ...templateMenus.map((t) => t.menu)];
    };
    let menus: Dropdown[] = [];
    let page = 0;
    const PAGE = 30;
    container.innerHTML = markup();
    const el = (q: string): HTMLElement => container.querySelector<HTMLElement>(q)!;
    const status = (text: string, error = false): void => {
      if (!alive) return;
      context.setStatus(text, error ? "error" : "idle");
      el("[data-progress]").textContent = text;
    };
    const remember = (): void => { dirty = true; settings.save({ ...config, options: { ...config.options }, sounds: { ...config.sounds }, titles: { ...config.titles } }); };
    const choiceFor = (id: string): SoundChoice | null => {
      for (const row of rows) { const hit = row.choices.find((c) => c.id === id); if (hit) return hit; }
      return catalog ? choiceById(catalog, id) : null;
    };
    const stop = (): void => {
      previewToken++; previewId = ""; stopPlayback(); release?.(); release = null;
    };
    const optionsChanged = (): void => { if (busy) return; remember(); rebuild(); };
    const scopeMenu = mountDropdown(el("[data-scope]"), {
      options: () => [{ id: "selection", label: "Clipes selecionados" }, { id: "sequence", label: "Sequência inteira" }],
      selected: () => config.scope,
      onPick: (id) => { if (busy) return; config.scope = id as Scope; scan = null; rows = []; page = 0; remember(); render(); },
    });
    const densityMenu = mountDropdown(el("[data-density]"), {
      options: () => [{ id: "light", label: "Discreto", meta: "Mais espaço" }, { id: "balanced", label: "Equilibrado" }, { id: "full", label: "Detalhado", meta: "Cada evento" }],
      selected: () => config.options.density,
      onPick: (id) => { if (busy) return; config.options.density = id as DetectionOptions["density"]; optionsChanged(); },
    });

    /** The take the editor chose for a family, inserted into the row's list when the ranking left it out. */
    const preferred = (family: Family, choices: SoundChoice[]): number => {
      const id = config.sounds[family];
      if (!id || id === "auto" || !catalog) return -1;
      const at = choices.findIndex((c) => c.id === id);
      if (at >= 0) return at;
      const extra = choiceFor(id);
      if (!extra) return -1;
      choices.push(extra);
      return choices.length - 1;
    };
    /** Every suggestion for a family across the list, best first; then the rest of the pack. */
    const familyOptions = (family: Family): Array<{ id: string; label: string; meta?: string }> => {
      const best = new Map<string, SoundChoice>();
      for (const row of rows) if (familyFor(row.event) === family) for (const c of row.choices) {
        if (c.score > 0 && (best.get(c.id)?.score ?? -1) < c.score) best.set(c.id, c);
      }
      const ranked = [...best.values()].sort((a, b) => b.score - a.score);
      const out = [{ id: "auto", label: family === "whoosh" || family === "impact" ? "Automático · varia" : "Automático", meta: ranked[0]?.name }];
      for (const c of ranked.slice(0, 12)) out.push({ id: c.id, label: c.name, meta: "sugerido" });
      // The rest of the pack, from the categories this family lives in (not all 8.500 files).
      const homes = new Set([...FAMILY_CATEGORIES[family], "assinatura"]);
      if (catalog) for (const category of catalog.categories) for (const sound of category.sounds) {
        if (sound.loop || !homes.has(category.id)) continue;
        sound.variants.forEach((v, i) => {
          if (ranked.slice(0, 12).some((c) => c.id === v.id)) return;
          out.push({ id: v.id, label: `${sound.name}${sound.variants.length > 1 ? ` · ${i + 1}` : ""}`, meta: category.label });
        });
      }
      return out;
    };
    const setFamily = (family: Family, id: string): void => {
      stop();
      config.sounds[family] = id;
      remember();
      const seen = new Map<Family, number>();
      for (const row of rows) {
        if (familyFor(row.event) !== family) continue;
        const occurrence = seen.get(family) ?? 0;
        seen.set(family, occurrence + 1);
        if (row.placed) continue;
        const had = row.choices.length;
        const chosen = preferred(family, row.choices);
        row.pick = chosen >= 0 ? chosen : varietyPick(family, row.choices, occurrence);
        // A row that had no compatible sound becomes usable; one the editor unticked stays unticked.
        if (!had && row.choices.length) row.enabled = true;
      }
      familyMenus.forEach((menu) => menu.render());
      const name = config.sounds[family] === "auto" ? "o automático" : choiceFor(id)?.name ?? "o som escolhido";
      status(`${FAMILY_LABELS[family]}: ${name} em todos os eventos deste tipo.`);
      render();
    };
    const familyMenus = FAMILIES.map((family) => mountDropdown(el(`[data-family-pick="${family}"]`), {
      options: () => familyOptions(family),
      selected: () => config.sounds[family] ?? "auto",
      onPick: (id) => { if (!busy) setFamily(family, id); },
      search: { placeholder: "Buscar no pack…" },
    }));
    menus = [scopeMenu, densityMenu, ...familyMenus];
    const slider = mountSlider(el("[data-level]"), {
      min: -12, max: 6, step: 1, value: config.level, label: "Nível dos efeitos sonoros", output: el("[data-level-value]"),
      format: (n) => n === 0 ? "Padrão" : `${n > 0 ? "+" : ""}${n} dB`,
      onInput: (n) => { if (!busy) { config.level = n; remember(); } },
    });

    const ready = (): number => rows.filter((r) => r.enabled && !r.placed && r.choices.length).length;
    /** The main button is always the next step: analyse, apply, or analyse again once nothing is left. */
    const step = (): "analyze" | "apply" | "review" => {
      if (!scan) return "analyze";
      if (ready()) return "apply";
      return rows.some((r) => !r.placed && r.choices.length) ? "review" : "analyze";
    };
    function actions(): void {
      if (!alive) return;
      const count = ready();
      const next = step();
      context.setApplyLabel(busy ? "Processando…" : next === "apply" ? `Aplicar ${count} SFX` : next === "review" ? "Aplicar SFX"
        : scan ? "Analisar de novo" : "Analisar timeline");
      context.setApplyEnabled(!busy && (next === "analyze" || (next === "apply" && !!catalog && count <= MAX_BATCH)));
      // A disabled button always says why, where the eye already is.
      if (!busy && next === "apply" && count > MAX_BATCH) context.setStatus(`${count} eventos marcados: o limite é ${MAX_BATCH} por lote. Desmarque alguns ou analise uma seleção menor.`, "error");
      if (!busy && next === "review") context.setStatus("Nenhum evento marcado. Marque na lista os sons que quer aplicar.", "idle");
      el("[data-analyze-label]").textContent = scan ? "Analisar de novo" : "Analisar e sugerir sons";
      context.setResetLabel(busy ? "Cancelar" : "Remover último lote");
      context.setResetHandler(busy ? () => { cancelled = true; status("Cancelando antes da próxima etapa…"); }
        : hasUndo ? () => { void undo(); } : null);
      setDisabled(el("[data-analyze]"), busy);
      setDisabled(el("[data-folder]"), busy);
      el("[data-controls]").classList.toggle("is-disabled", busy);
      el("[data-controls]").setAttribute("aria-disabled", String(busy));
      container.setAttribute("aria-busy", String(busy));
      el("[data-respect]").setAttribute("aria-pressed", String(config.respect));
      setDisabled(el("[data-respect]"), busy);
      for (const key of Object.keys(LABELS) as EventKind[]) {
        const button = el(`[data-kind="${key}"]`);
        button.setAttribute("aria-pressed", String(config.options[key]));
        setDisabled(button, busy);
      }
    }
    function rebuild(): void {
      stop();
      const previous = new Map(rows.map((r) => [r.event.id, r]));
      const seen = new Map<string, number>();
      // Hundreds of word clicks rank the same way: one ranking per kind of moment, not per event.
      const ranked = new Map<string, SoundChoice[]>();
      const rank = (event: VisualEvent): SoundChoice[] => {
        const key = `${familyFor(event)}|${Math.round((event.end - event.start) * 10)}|${Math.round(event.intensity * 10)}`;
        let list = ranked.get(key);
        if (!list) { list = rankSounds(event, catalog!, knownSeconds).slice(0, 24); ranked.set(key, list); }
        return list.slice();
      };
      rows = scan && catalog ? selectEvents(events, config.options, scan.frame).map((event) => {
        const old = previous.get(event.id);
        const choices = rank(event);
        const placed = isPlaced(event.id, scan!.audio, scan!.frame) || alreadyPlaced(event.id, scan!.audio);
        const oldId = old?.choices[old.pick]?.id;
        const family = familyFor(event);
        const occurrence = seen.get(family) ?? 0;
        seen.set(family, occurrence + 1);
        const kept = oldId ? choices.findIndex((choice) => choice.id === oldId) : -1;
        const chosen = kept >= 0 ? -1 : preferred(family, choices);
        const pick = kept >= 0 ? kept : chosen >= 0 ? chosen : varietyPick(family, choices, occurrence);
        return { event, choices, pick, placed, enabled: !placed && !!choices.length && (old?.enabled ?? true) };
      }) : [];
      familyMenus.forEach((menu) => menu.render());
      page = 0; render();
    }
    function render(): void {
      if (!alive) return;
      const count = rows.filter((r) => r.enabled && !r.placed && r.choices.length).length;
      const placed = rows.filter((r) => r.placed).length;
      el("[data-summary]").textContent = scan ? `${count} prontos · ${placed} já na timeline` : "Encontre o ritmo da edição";
      el("[data-summary-detail]").textContent = scan ? `${scan.sequenceName} · ${scan.clips} clipes analisados` : "Cada elemento recebe o som do que ele é.";
      el("[data-folder-label]").textContent = folder ? folder.path.split(/[\\/]/).pop() || folder.path : "Nenhuma — escolha antes de aplicar";
      el("[data-folder-label]").title = folder?.path ?? "";
      el("[data-folder]").textContent = folder ? "Trocar…" : "Escolher…";
      const notes = [...(scan?.notes ?? [])];
      if (scan && !scan.lanes.some((l) => l.index >= 2 && !l.locked)) notes.unshift("Adicione uma faixa de áudio livre a partir da A3 para aplicar os sons.");
      if (count > MAX_BATCH) notes.unshift(`Selecione até ${MAX_BATCH} eventos por lote ou analise uma seleção menor.`);
      if (rows.some((r) => !r.choices.length)) notes.push("Sem som compatível: confira se o pack possui whooshes, clicks ou impactos e atualize a biblioteca de Efeitos Sonoros.");
      el("[data-notes]").innerHTML = notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("");
      el("[data-notes]").hidden = notes.length === 0;
      const present = new Set(rows.filter((r) => r.choices.length).map((r) => familyFor(r.event)));
      el("[data-families]").hidden = present.size === 0;
      for (const family of FAMILIES) {
        const line = el(`[data-family="${family}"]`);
        line.hidden = !present.has(family);
        el(`[data-family-play="${family}"]`).textContent = previewId === `family:${family}` ? "Parar" : "Ouvir";
      }
      const visible = rows.slice(page * PAGE, (page + 1) * PAGE);
      el("[data-cues]").innerHTML = visible.length ? visible.map((r) => {
        const choice = r.choices[r.pick];
        const id = r.event.id;
        return `<div class="sd-cue${r.placed ? " is-placed" : ""}" data-row="${id}">` +
          `<div class="sd-cue-top"><span class="sd-check" ${CONTROL} data-toggle="${id}" aria-label="Incluir ${escapeHtml(LABELS[r.event.kind])} aos ${clock(r.event.peak)}" aria-pressed="${r.enabled}" aria-disabled="${r.placed || !choice}">${r.placed ? "✓" : r.enabled ? "✓" : "−"}</span>` +
          `<span class="sd-time" ${CONTROL} data-seek="${id}" title="Ir a este ponto na timeline">${clock(r.event.peak)}</span>` +
          `<span class="sd-kind">${escapeHtml(LABELS[r.event.kind])}</span></div>` +
          `<p class="sd-detail">${escapeHtml(r.event.detail)}</p><p class="sd-clip" title="${escapeHtml(r.event.clip)}">${escapeHtml(r.event.clip)}</p>` +
          (r.event.why ? `<p class="sd-why">${escapeHtml(r.event.why)}</p>` : "") +
          `<div class="sd-sound"><span class="sd-sound-name" data-sound-name>${r.placed ? "Já aplicado" : choice ? escapeHtml(choice.name) : "Sem som compatível"}</span>` +
          `<span class="sd-small" ${CONTROL} data-play="${id}" aria-label="Ouvir som sugerido" aria-disabled="${!choice}">${previewId === id ? "Parar" : "Ouvir"}</span>` +
          (!r.placed && r.choices.length > 1 ? `<span class="sd-small" ${CONTROL} data-swap="${id}" title="Próximo som compatível">Trocar</span>` : "") + "</div></div>";
      }).join("") : `<div class="sd-empty"><p>${scan ? "Nenhum evento disponível" : "Comece pelos clipes que você quer sonorizar"}</p><span>${scan ? "Confira os filtros de eventos acima. A análise lê keyframes de escala, posição, rotação e opacidade, cortes com mudança de enquadramento e textos na timeline; movimento já renderizado dentro do vídeo não aparece." : "Selecione na timeline e clique em Analisar. Os sons aparecem aqui para você ouvir e revisar."}</span></div>`;
      el("[data-page]").textContent = rows.length ? `${page * PAGE + 1}–${Math.min(rows.length, (page + 1) * PAGE)} de ${rows.length}` : "";
      el("[data-pagination]").hidden = rows.length <= PAGE;
      setDisabled(el("[data-prev]"), page === 0 || busy);
      setDisabled(el("[data-next]"), (page + 1) * PAGE >= rows.length || busy);
      el("[data-bulk]").hidden = !rows.length;
      actions();
    }

    async function analyze(): Promise<void> {
      if (busy) return;
      busy = true; cancelled = false; stop(); scan = null; rows = []; events = []; render();
      try {
        status("Lendo a timeline…");
        const next = await scanTimeline(config.scope, status, () => cancelled || !alive);
        if (!next.clips) throw new Error(config.scope === "selection" ? "Nada selecionado: selecione os clipes na timeline (vídeo e legendas) ou escolha Sequência inteira em Analisar." : "Esta sequência não tem clipes de vídeo ativos.");
        status("Consultando o pack de SFX…");
        const sounds = await soundLibrary(false, status);
        await loadPlaced();
        if (cancelled || !alive) return;
        anchors = anchorsOf(next.elements, next.motion, next.frame, next.covers);
        // What the editor already sounded here stays theirs.
        done = soundedAlready(anchors, next.sfx);
        scan = next; catalog = sounds;
        derive();
        mountTemplates();
        rebuild();
        const count = ready();
        // Skipped moments are the first thing to say: it explains a short list.
        const skipped = config.respect && done.size ? ` · ${done.size} momentos já têm SFX seu e ficaram de fora (desligue “Respeitar meus SFX” para incluir)` : "";
        status(rows.length
          ? `${rows.length} eventos encontrados${count < rows.length ? ` · ${count} com som pronto` : ""}${skipped}.`
          : `Nenhum evento novo em ${next.clips} clipes${skipped}.`, !count);
        void report(ANALYSIS, "Análise", describeScan(next, rows, sounds, done.size));
      } catch (cause) {
        status(describe(cause), true);
        void report(ANALYSIS, "Análise falhou", [`escopo: ${config.scope}`, `erro: ${describe(cause)}`, String((cause as Error)?.stack ?? "")]);
      }
      finally { busy = false; if (alive) render(); }
    }
    /**
     * ⚠️ A pasta é a MESMA da biblioteca de Efeitos Sonoros, e isso é
     * intencional: grupo `audio` em `bridge/destination`. Escolher aqui
     * vale lá, escolher lá vale aqui, e não afeta nenhuma outra
     * ferramenta. Não "conserte" isto.
     */
    async function chooseFolder(): Promise<void> {
      const chosen = await pickAndSave("soundDesign");
      if (!chosen || !alive) return;
      folder = chosen; setFolder(folder); forgetOpenFolders();
      // Espelho, para a biblioteca desenhar a linha da pasta sem
      // esperar o disco. A verdade está no grupo.
      sfxSettings.patch({ folder: chosen.path, folderToken: chosen.token });
      await sfxSettings.flush();
      render();
    }
    async function apply(): Promise<void> {
      if (busy || !scan || !catalog) return;
      const chosen = rows.filter((r) => r.enabled && !r.placed && r.choices.length);
      if (!chosen.length || chosen.length > MAX_BATCH) return;
      busy = true; cancelled = false; stop(); actions();
      try {
        const timeline = await activeTimeline();
        if (timeline.id !== scan.sequenceId) throw new Error("A sequência mudou. Analise novamente.");
        if (!folder) await chooseFolder();
        if (!folder) { status("Escolha a pasta onde os SFX usados vão ficar: o Premiere precisa do arquivo no disco."); return; }
        // Today's lanes, not the analysis': a track added since then must count.
        const current = (await readAudio(timeline.ppro, timeline.sequence)).lanes;
        // Missing tracks are created by the batch, up to MAX_NEW_TRACKS.
        const lanes = withRoom(current, current.length - 1 + MAX_NEW_TRACKS);
        const { placements, dropped, files } = await prepareSounds(chosen.map((r) => ({ event: r.event, choice: r.choices[r.pick],
          fallbacks: r.choices.filter((c, i) => i !== r.pick && c.id !== r.choices[r.pick].id) })), catalog, folder, scan.frame, config.level, lanes, status, () => cancelled || !alive);
        const result = await applySounds(scan, placements, status, () => cancelled || !alive);
        hasUndo = !!(await readLastBatch())?.items.length;
        if (!alive) return;
        const left = new Set(dropped);
        for (const row of chosen) if (!left.has(row.event.id)) { row.placed = true; row.enabled = false; }
        const created = Math.max(0, Math.max(-1, ...placements.map((p) => p.track)) + 1 - current.length);
        const room = (created ? ` · ${created} faixa(s) de áudio criada(s)` : "") +
          (dropped.length ? ` · ${dropped.length} cliques de palavra ficaram de fora: mesmo com ${MAX_NEW_TRACKS} faixas novas não couberam.` : "");
        // Only the sounds used were downloaded: one file per sound, however many events use it.
        const where = folder.path.split(/[\\/]/).pop() || folder.path;
        const volume = result.volume ? ` Atenção: ${result.volume}.` : "";
        status(`${result.count} SFX na timeline · ${files.length} arquivo${files.length === 1 ? "" : "s"} de som em ${where} (só os usados)` +
          `${result.skipped ? ` · ${result.skipped} já existiam` : ""}${room}.${volume} Remover último lote desfaz esta aplicação.`, !!result.volume);
        void report(REPORT, "Aplicação", [`inseridos: ${result.count}`, `já existiam: ${result.skipped}`, `sem faixa livre: ${dropped.length}`,
          `pasta: ${folder.path}`, `volume: ${result.volume || "ajustado em cada clipe"}`, ...files.map((f) => `arquivo: ${f}`),
          ...placements.map((p) => `A${p.track + 1} ${clock(p.start)}–${clock(p.end)} in ${p.inPoint.toFixed(3)} out ${p.outPoint.toFixed(3)} ${p.gainDb.toFixed(1)} dB · ${p.path.split(/[\\/]/).pop()}`)]);
        if (!result.volume) context.setStatus(`${result.count} SFX na timeline · ${files.length} arquivos de som baixados em ${where}.`, "done");
      } catch (cause) {
        hasUndo = !!(await readLastBatch())?.items.length;
        // A failed host readback may have followed a successful write: never blindly retry.
        scan = null; rows = [];
        status(`${describe(cause)} Analise novamente antes de reaplicar.`, true);
        void report(REPORT, "Aplicação falhou", [`erro: ${describe(cause)}`, ...((cause as { details?: string[] })?.details ?? []), String((cause as Error)?.stack ?? "")]);
      } finally { busy = false; if (alive) render(); }
    }
    async function undo(): Promise<void> {
      if (busy) return;
      busy = true; actions(); stop();
      try {
        const result = await undoLastBatch();
        hasUndo = !!(await readLastBatch())?.items.length;
        scan = null; rows = [];
        status(`${result.count} SFX removidos.${result.preserved ? ` ${result.preserved} itens alterados, ausentes ou travados foram preservados.` : " Analise para gerar novas sugestões."}`);
      } catch (cause) { status(describe(cause), true); }
      finally { busy = false; if (alive) render(); }
    }
    async function preview(row: Row): Promise<void> {
      if (row.choices.length) await previewChoice(row.event.id, row.choices[row.pick]);
    }
    async function previewChoice(key: string, choice: SoundChoice): Promise<void> {
      if (previewId === key) { stop(); render(); return; }
      stop(); prime(silenceUrl());
      const ticket = previewToken;
      previewId = key;
      render();
      try {
        await warmPlayer();
        const source = await previewSource(choice.variant);
        if (!alive || ticket !== previewToken) { if (source.kind === "ready") source.release(); return; }
        if (source.kind !== "ready") throw new Error("Este som está vazio no pack. Troque a sugestão.");
        release = source.release;
        status("Prévia do som original. Na aplicação, o nível e o trecho são ajustados ao evento.");
        const ended = (): void => { if (ticket === previewToken) { stop(); render(); } };
        playUrl(source.url, { onStart: () => {}, onEnd: ended, onError: (message) => { ended(); status(message, true); } }, choice.name);
      } catch (cause) { if (ticket === previewToken) { stop(); render(); status(describe(cause), true); } }
    }

    container.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      menus.forEach((menu) => menu.closeUnless(target));
      const button = target?.closest<HTMLElement>("[role=button]");
      if (!button || button.getAttribute("aria-disabled") === "true" || busy) return;
      const data = button.dataset;
      if ("analyze" in data) { void analyze(); return; }
      if ("folder" in data) { void chooseFolder().catch((cause) => status(describe(cause), true)); return; }
      if ("respect" in data) { config.respect = !config.respect; remember(); derive(); rebuild(); return; }
      if (data.kind) { const kind = data.kind as EventKind; config.options[kind] = !config.options[kind]; optionsChanged(); return; }
      if (data.familyPlay) {
        const family = data.familyPlay as Family;
        const row = rows.find((r) => familyFor(r.event) === family && r.choices.length);
        const id = config.sounds[family];
        const choice = id && id !== "auto" ? choiceFor(id) : row ? row.choices[row.pick] : null;
        if (choice) void previewChoice(`family:${family}`, choice);
        return;
      }
      if ("prev" in data) { page = Math.max(0, page - 1); render(); return; }
      if ("next" in data) { page++; render(); return; }
      if ("all" in data || "none" in data) { rows.forEach((r) => { r.enabled = "all" in data && !r.placed && !!r.choices.length; }); render(); return; }
      const row = rows.find((r) => r.event.id === (data.toggle ?? data.play ?? data.swap ?? data.seek));
      if (!row) return;
      if (data.toggle) { row.enabled = !row.enabled; render(); }
      if (data.swap) { stop(); row.pick = (row.pick + 1) % row.choices.length; render(); }
      if (data.play) void preview(row);
      if (data.seek) void (async () => {
        const timeline = await activeTimeline();
        if (timeline.id !== scan?.sequenceId) throw new Error("Volte à sequência analisada ou analise novamente.");
        await timeline.sequence.setPlayerPosition(timeline.ppro.TickTime.createWithSeconds(row.event.peak));
      })().catch((cause) => status(describe(cause), true));
    });
    context.setApplyHandler(() => (step() === "apply" ? apply() : analyze()));
    context.setRefreshHandler(null);
    setHost(el("[data-player]"));
    void warmSilence();
    render();
    void (async () => {
      const shared = await sfxSettings.read();
      const held = await readDestination(
        "soundDesign",
        destinationOf(shared.folder, shared.folderToken)
      ).catch(() => null);
      const last = await readLastBatch();
      if (!alive) return;
      folder = held?.path ? held : null;
      hasUndo = !!last?.items.length;
      const stored = await settings.read();
      if (!alive) return;
      if (!dirty && !busy && !scan) {
        Object.assign(config, stored, { options: { ...stored.options }, sounds: { ...stored.sounds } });
        slider.set(config.level); scopeMenu.render(); densityMenu.render(); familyMenus.forEach((menu) => menu.render());
      }
      render();
    })();
    dispose = () => { alive = false; cancelled = true; stop(); slider.destroy(); setHost(null); void settings.flush(); };
  },
  unmount(): void { dispose?.(); dispose = null; },
};

/** What the last analysis and the last application saw, on disk (separate files: one never erases the other). */
const ANALYSIS = "sfx-auto-analysis.txt";
const REPORT = "sfx-auto-report.txt";
async function report(file: string, title: string, lines: readonly string[]): Promise<void> {
  try {
    await write(await workspace(), file, [`Framelab — SFX Automático · ${new Date().toISOString()}`, title, ...lines].join("\n") + "\n");
  } catch { /* The report is a courtesy; the tool works without it. */ }
}
function describeScan(scan: TimelineScan, rows: readonly Row[], catalog: SfxCatalog, done: number): string[] {
  const kinds = new Map<string, number>();
  for (const element of scan.elements) kinds.set(element.role, (kinds.get(element.role) ?? 0) + 1);
  const elements = scan.elements.filter((e) => e.role !== "footage").map((e) =>
    `elemento: ${clock(e.start)}–${clock(e.end)} V${e.track + 1} ${e.role}${e.identity ? `/${e.identity}` : ""} · ${e.clip}${e.effects.length ? ` · efeitos: ${e.effects.join(", ")}` : ""}`);
  const free = scan.lanes.filter((l) => l.index >= 2 && !l.locked).map((l) => `A${l.index + 1}`);
  return [
    `escopo: ${scan.scope} · sequência: ${scan.sequenceName} · quadro: ${scan.frame.toFixed(5)} s`,
    `clipes lidos: ${scan.clips} · elementos: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ") || "nenhum"} · movimentos: ${scan.motion.length} · seus SFX aqui: ${scan.sfx.length} (${done} momentos já sonorizados)`,
    ...elements,
    `na lista: ${rows.length} · prontos: ${rows.filter((r) => r.enabled && !r.placed && r.choices.length).length} · sem som compatível: ${rows.filter((r) => !r.choices.length).length} · já na timeline: ${rows.filter((r) => r.placed).length}`,
    `pack: ${catalog.sounds} sons · faixas livres a partir da A3: ${free.join(", ") || "nenhuma"}`,
    ...scan.notes.map((note) => `nota: ${note}`),
    ...rows.slice(0, 300).map((r) => `som: ${clock(r.event.peak)} ${r.event.kind} · ${r.event.detail} · ${r.event.clip} → ${r.choices[r.pick]?.name ?? "sem som"}${r.enabled ? "" : " (desmarcado)"}`),
  ];
}

function markup(): string {
  return `<div class="zones sd-workspace"><div class="zone" data-controls>` +
    `<div class="field"><div class="field-head"><span class="t-label">Analisar</span><span class="sd-local">TIMELINE</span></div><div data-scope></div></div>` +

    `<div class="field"><div class="field-head"><span class="t-label">Eventos</span></div><div class="sd-kinds">` +
    (Object.keys(LABELS) as EventKind[]).map((kind) => `<span class="sd-filter" ${CONTROL} data-kind="${kind}" aria-pressed="false">${escapeHtml(LABELS[kind])}</span>`).join("") +
    `</div><p class="sd-hint">Palavra por palavra: títulos do Textos Animados, um clique por palavra no ritmo da animação. Overlays e efeitos: film burn, flash, glitch e VHS pelo nome do arquivo. Zoom e movimento vêm desligados: ligue se quiser whoosh nos movimentos de câmera.</p></div>` +
    `<div class="field"><div class="field-head"><span class="t-label">Densidade</span></div><div data-density></div>` +
    `<div class="sd-kinds"><span class="sd-filter" ${CONTROL} data-respect aria-pressed="true">Respeitar meus SFX</span></div>` +
    `<p class="sd-hint">Ligado: onde você já pôs um SFX à mão, ele não põe outro.</p></div>` +
    `<div class="field"><div class="field-head"><span class="t-label">SFX baixados em</span></div>` +
    `<div class="sd-folder"><span class="sd-folder-name" data-folder-label>Nenhuma pasta escolhida</span><span class="sd-small" ${CONTROL} data-folder>Trocar…</span></div>` +
    `<p class="sd-hint">Só os sons que entram na timeline são baixados: um arquivo por som, mesmo que ele toque em cem palavras, numa subpasta por categoria. É a mesma pasta dos Efeitos Sonoros.</p></div>` +
    `<div class="field"><div class="field-head"><span class="t-label">Nível dos SFX</span><span class="field-value" data-level-value></span></div><div data-level></div><p class="sd-hint">Níveis suaves para conviver com a fala. Ouça o resultado na timeline.</p></div></div>` +
    `<div class="zone is-wide sd-run">` +
    `<div class="sd-analyze" ${CONTROL} data-analyze><span data-analyze-label>Analisar e sugerir sons</span> <span aria-hidden="true">→</span></div>` +
    `<p class="sd-progress" data-progress role="status" aria-live="polite"></p>` +
    `<div class="sd-notes" data-notes hidden></div>` +

    `<div class="sd-review"><div class="sd-review-head"><p class="sd-summary" data-summary></p><p class="sd-hint" data-summary-detail></p></div>` +
    `<div class="sd-families" data-templates hidden></div>` +
    `<div class="sd-families" data-families hidden><p class="sd-families-title">Som de cada tipo</p>` +
    FAMILIES.map((family) => `<div class="sd-family" data-family="${family}" hidden><span class="sd-family-label">${escapeHtml(FAMILY_LABELS[family])}</span>` +
      `<div class="sd-family-pick"><div data-family-pick="${family}"></div></div><span class="sd-small" ${CONTROL} data-family-play="${family}">Ouvir</span></div>`).join("") +
    `</div>` +
    `<div class="sd-bulk" data-bulk hidden><span class="sd-small" ${CONTROL} data-all>Selecionar todos</span><span class="sd-small" ${CONTROL} data-none>Limpar seleção</span></div>` +
    `<div data-cues></div><div class="sd-pagination" data-pagination hidden><span class="sd-small" ${CONTROL} data-prev>Anterior</span><span data-page></span><span class="sd-small" ${CONTROL} data-next>Próxima</span></div></div>` +
    `<span class="sfx-stage" data-player aria-hidden="true"></span></div></div>`;
}
