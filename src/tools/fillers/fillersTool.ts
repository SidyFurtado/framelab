/**
 * Cortar Muletas — a ferramenta.
 *
 * Corta SÓ os "ééé", "aaamm", "hum" da fala, deixando silêncio e
 * frase em paz. É o inverso de escopo do Corte de Silêncios — e por
 * baixo é a MESMA máquina: o scan da seleção, o executor de cortes e
 * o desfazer vêm de applySilence.ts; o que esta ferramenta traz de
 * seu é o planejador (planFillers.ts), que decide o que cai por
 * texto, tag e duração em vez de por pausa.
 *
 * A leitura vem da transcrição do Premiere, então o clipe precisa
 * estar transcrito (janela Texto → Transcrever). Sem transcrição não
 * há o que ler — a linha do clipe diz isso em vez de fingir que não
 * havia muleta.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL, setDisabled, escapeHtml } from "../../shell/controls";
import {
  applyCuts,
  scanSelection,
  undoCuts,
  type ClipTarget,
  type CutSnapshot,
  type SilenceScan,
} from "../silence/applySilence";
import { formatSeconds } from "../silence/detect";
import { defaultParams } from "../silence/presets";
import {
  FILLER_DEFAULTS,
  planFillers,
  type FillerParams,
  type FillerPlan,
  type FillerReason,
} from "./planFillers";

const REASON_LABELS: Record<FillerReason, string> = {
  tag: "tag da transcrição",
  sound: "som de hesitação",
  stretched: "esticado",
};

/** Deixa `unmount` desligar uma varredura que ainda roda. */
let cancelActiveScan: (() => void) | null = null;

export const fillersTool: Tool = {
  id: "fillers",
  name: "Cortar Muletas",
  summary: "Remove os ééé e aaamm da fala",
  hint:
    "Selecione os clipes falados e analise. Usa a transcrição do Premiere " +
    "(janela Texto → Transcrever) — só as muletas caem, o resto da fala e " +
    "as pausas ficam como estão.",
  category: "edicao",
  glyph: "speech",
  available: true,

  mount(container: HTMLElement, context: ToolContext): void {
    const params: FillerParams = { ...FILLER_DEFAULTS };
    let scan: SilenceScan | null = null;
    /** Planos por clipe, paralelos a scan.clips. */
    let plans = new Map<string, FillerPlan>();
    let snapshot: CutSnapshot | null = null;
    let scanning = false;

    container.innerHTML = markup(params);

    const scanBtn = container.querySelector<HTMLElement>("[data-scan]");
    const emptyEl = container.querySelector<HTMLElement>("[data-empty]");
    const reportEl = container.querySelector<HTMLElement>("[data-report]");
    const padInput = container.querySelector<HTMLInputElement>("[data-pad]");
    const padOut = container.querySelector<HTMLElement>("[data-out-pad]");
    const stretchInput = container.querySelector<HTMLInputElement>("[data-stretch]");
    const stretchOut = container.querySelector<HTMLElement>("[data-out-stretch]");
    const tagSeg = container.querySelector<HTMLElement>("[data-tag-seg]");

    context.setApplyLabel("CORTAR MULETAS");
    context.setApplyEnabled(false);
    context.setResetLabel("DESFAZER");
    context.setResetHandler(null);

    // ── parâmetros ────────────────────────────────────────────

    function syncOutputs(): void {
      if (padOut) padOut.textContent = `${params.padSeconds.toFixed(2)}s`;
      if (stretchOut) {
        stretchOut.textContent =
          params.stretchedSeconds > 0
            ? `${params.stretchedSeconds.toFixed(2)}s`
            : "desligado";
      }
      for (const item of tagSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        item.setAttribute(
          "aria-pressed",
          String((item.dataset.tag === "on") === params.useTags)
        );
      }
    }

    padInput?.addEventListener("input", () => {
      params.padSeconds = Number.parseFloat(padInput.value) || 0;
      syncOutputs();
      rebuild();
    });
    stretchInput?.addEventListener("input", () => {
      params.stretchedSeconds = Number.parseFloat(stretchInput.value) || 0;
      syncOutputs();
      rebuild();
    });
    tagSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[data-tag]");
      if (!item) return;
      params.useTags = item.dataset.tag === "on";
      syncOutputs();
      rebuild();
    });

    // ── varredura ─────────────────────────────────────────────

    scanBtn?.addEventListener("click", () => void runScan());

    async function runScan(): Promise<void> {
      if (scanning) return;
      scanning = true;
      let cancelled = false;
      cancelActiveScan = () => {
        cancelled = true;
      };
      context.setApplyEnabled(false);
      if (scanBtn) {
        setDisabled(scanBtn, true);
        scanBtn.textContent = "Analisando…";
      }

      try {
        // Os parâmetros do Corte de Silêncios só alimentam o plano
        // DELE, que é descartado no rebuild logo abaixo. O que esta
        // varredura devolve de útil são os clipes com as palavras.
        const result = await scanSelection(defaultParams(), {
          mode: "transcript",
          ffmpegPath: "",
          onStage: (text) => context.setStatus(text),
          cancelled: () => cancelled,
        });
        if (cancelled) return;
        scan = result;
        rebuild();
      } catch (cause) {
        scan = null;
        plans = new Map();
        context.setStatus(cause instanceof Error ? cause.message : String(cause), "error");
      } finally {
        scanning = false;
        cancelActiveScan = null;
        if (scanBtn) {
          setDisabled(scanBtn, false);
          scanBtn.textContent = "Analisar Seleção";
        }
      }
    }

    /**
     * Reconta o plano de cada clipe a partir das palavras já lidas.
     * É o que roda a cada movimento de slider — puro, sem host.
     */
    function rebuild(): void {
      if (!scan) return;
      plans = new Map();
      let cuts = 0;
      let removed = 0;
      let ready = 0;

      for (const clip of scan.clips) {
        if (
          clip.status === "error" ||
          clip.status === "speed" ||
          clip.status === "no-media" ||
          clip.status === "no-transcript"
        ) {
          clip.plan = null;
          continue;
        }
        const plan = planFillers(
          clip.words,
          { start: clip.sourceStart, end: clip.sourceEnd },
          params,
          scan.frameSeconds
        );
        plans.set(clip.key, plan);

        if (plan.drop.length === 0) {
          clip.plan = null;
          clip.status = "nothing";
          continue;
        }
        // Um plano que apagaria o clipe inteiro é um plano errado —
        // um clipe 100% muleta se resolve deletando na mão, não por
        // uma ferramenta que promete cortar só o excesso. Mesma
        // guarda do recomputePlans do Corte de Silêncios.
        if (plan.keep.length === 0) {
          clip.plan = null;
          clip.status = "no-speech";
          plans.delete(clip.key);
          continue;
        }
        clip.plan = plan;
        clip.status = "ready";
        ready += 1;
        cuts += plan.drop.length;
        removed += plan.removedSeconds;
      }

      scan.cuts = cuts;
      scan.removedSeconds = removed;
      scan.readyCount = ready;

      renderReport();
      context.setApplyEnabled(ready > 0);
      const total = totalHits();
      context.setStatus(
        total > 0
          ? `${total} ${total === 1 ? "muleta encontrada" : "muletas encontradas"} · ` +
            `${formatSeconds(removed)} a remover`
          : "Nenhuma muleta encontrada na seleção.",
        total > 0 ? "done" : "idle"
      );
    }

    function totalHits(): number {
      let count = 0;
      for (const plan of plans.values()) {
        count += plan.hits.length;
      }
      return count;
    }

    // ── aplicar e desfazer ────────────────────────────────────

    context.setApplyHandler(async () => {
      if (!scan || scan.readyCount === 0) return;
      context.setStatus("Cortando…");
      context.setApplyEnabled(false);

      const result = await applyCuts(scan, (done, total) => {
        context.setStatus(`Cortando… ${done}/${total}`);
      });
      context.setStatus(result.message, result.ok ? "done" : "error");

      // O snapshot vale MESMO na falha parcial: é ele que recupera os
      // clipes originais quando o corte parou no meio — a mensagem do
      // executor manda usar o Desfazer, então o botão tem que existir.
      if (result.snapshot) {
        snapshot = result.snapshot;
        context.setResetHandler(() => void runUndo());
      }
      if (result.ok && result.snapshot) {
        // O corte moveu tudo: o plano antigo aponta para uma timeline
        // que não existe mais. Análise nova ou desfazer — nada de
        // aplicar duas vezes o mesmo plano.
        scan = null;
        plans = new Map();
        renderReport();
        context.refreshSelection();
      } else if (!result.ok && !result.snapshot && scan.readyCount > 0) {
        // Recusa seca, nada escrito: o plano segue válido e o botão
        // segue vivo.
        context.setApplyEnabled(true);
      }
    });

    async function runUndo(): Promise<void> {
      if (!snapshot) return;
      context.setStatus("Desfazendo…");
      const result = await undoCuts(snapshot);
      context.setStatus(result.message, result.ok ? "done" : "error");
      if (result.ok) {
        snapshot = null;
        context.setResetHandler(null);
        context.refreshSelection();
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

      let html = "";
      for (const clip of scan.clips) {
        html += clipRow(clip, plans.get(clip.key) ?? null);
      }
      reportEl.innerHTML = html;
    }

    function clipRow(clip: ClipTarget, plan: FillerPlan | null): string {
      const hits = plan?.hits ?? [];
      let meta: string;
      if (clip.status === "no-transcript") {
        meta = '<span class="sil-row-skip">sem transcrição</span>';
      } else if (clip.status === "error") {
        meta = `<span class="sil-row-skip">${escapeHtml(clip.detail ?? "erro")}</span>`;
      } else if (clip.status === "speed") {
        meta = '<span class="sil-row-skip">velocidade alterada</span>';
      } else if (clip.status === "no-media") {
        meta = '<span class="sil-row-skip">sem arquivo</span>';
      } else if (clip.status === "no-speech") {
        meta = '<span class="sil-row-skip">clipe inteiro é muleta — corte na mão</span>';
      } else if (hits.length === 0) {
        meta = '<span class="sil-row-skip">sem muletas</span>';
      } else {
        meta =
          `<span class="sil-row-cuts">${hits.length} ` +
          `${hits.length === 1 ? "muleta" : "muletas"}</span>` +
          `<span class="sil-row-time">−${formatSeconds(plan?.removedSeconds ?? 0)}</span>`;
      }

      let html =
        '<div class="sil-row-group">' +
        `<div class="sil-row${hits.length > 0 ? " is-ready" : ""}">` +
        `<span class="sil-row-name" title="${escapeHtml(clip.name)}">${escapeHtml(
          clip.name
        )}</span>${meta}</div>`;

      if (hits.length > 0) {
        // O tempo mostrado é dentro do clipe, que é onde o editor vai
        // olhar — segundo de source não diz nada para quem edita.
        html += '<div class="fl-hits">';
        for (const hit of hits) {
          const at = formatSeconds(Math.max(0, hit.start - clip.sourceStart));
          html +=
            `<span class="fl-hit is-${hit.reason}" ` +
            `title="${REASON_LABELS[hit.reason]}">` +
            `<b>${escapeHtml(hit.text || "(sem texto)")}</b>${at}</span>`;
        }
        html += "</div>";
      }
      return html + "</div>";
    }

    syncOutputs();
    context.setRefreshHandler(null);
  },

  unmount(): void {
    cancelActiveScan?.();
    cancelActiveScan = null;
  },
};

// ── markup ─────────────────────────────────────────────────────────

function markup(params: FillerParams): string {
  return (
    '<div class="zones">' +
      '<div class="zone">' +
        '<div class="field">' +
          '<div class="field-head">' +
            '<span class="t-label">Margem ao redor</span>' +
            `<span class="field-val" data-out-pad>${params.padSeconds.toFixed(2)}s</span>` +
          "</div>" +
          '<div class="slider-row">' +
            `<input type="range" min="0" max="0.4" step="0.01" value="${params.padSeconds}" ` +
            'data-pad aria-label="Margem ao redor de cada muleta">' +
          "</div>" +
          '<p class="field-note">Quanto de ar cai junto com cada muleta. A margem ' +
          "avança pelo silêncio vizinho e para na palavra ao lado — nunca morde fala.</p>" +
        "</div>" +
        '<div class="field">' +
          '<div class="field-head">' +
            '<span class="t-label">Esticado a partir de</span>' +
            `<span class="field-val" data-out-stretch>${params.stretchedSeconds.toFixed(2)}s</span>` +
          "</div>" +
          '<div class="slider-row">' +
            `<input type="range" min="0" max="1" step="0.05" value="${params.stretchedSeconds}" ` +
            'data-stretch aria-label="Duração a partir da qual é e ah contam como muleta">' +
          "</div>" +
          '<p class="field-note">Um "é" ou "ah" mais longo que isso é hesitação, não ' +
          "palavra. Zero desliga — aí só sons inequívocos (ééé, hum) e a tag cortam.</p>" +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Tag da transcrição (né, tipo…)</span>' +
          '<div class="seg" data-tag-seg>' +
            `<div class="seg-item" ${CONTROL} data-tag="on">Cortar</div>` +
            `<div class="seg-item" ${CONTROL} data-tag="off">Manter</div>` +
          "</div>" +
          '<p class="field-note">O que o próprio Premiere marcou como muleta. Desligue ' +
          'se o "né" faz parte do jeito de falar do vídeo.</p>' +
        "</div>" +
      "</div>" +

      '<div class="zone is-wide">' +
        '<div class="sil-empty" data-empty>' +
          '<p class="sil-empty-title">Pronto para analisar</p>' +
          '<p class="sil-empty-desc">Selecione os clipes falados na timeline. É preciso ' +
          "que estejam transcritos (janela Texto → Transcrever sequência).</p>" +
        "</div>" +
        `<div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar Seleção</div></div>` +
        '<div class="sil-report" data-report></div>' +
      "</div>" +
    "</div>"
  );
}

