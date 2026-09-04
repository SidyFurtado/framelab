/**
 * Traduzir Legenda — a ferramenta.
 *
 * Entra um .srt, sai o mesmo .srt com o texto noutro idioma e os
 * carimbos de tempo INTACTOS. A invariante está em `applyTranslate.ts`
 * e é checada em teste: o relógio atravessa como texto, sem virar
 * número em momento nenhum.
 *
 * ── As duas portas de entrada ──────────────────────────────────────
 * Importar pelo seletor do sistema, e buscar nas bins do projeto
 * aberto.
 *
 * Havia uma terceira, arrastar do Finder para o painel. A
 * documentação da Adobe diz que arrastar de fora "não é suportado",
 * com relatos de funcionar no Photoshop e não no InDesign; no Premiere
 * foi testado e NÃO funciona. Uma área tracejada que não recebe nada é
 * pior que não existir, então saiu.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL, setDisabled, escapeHtml } from "../../shell/controls";
import { mountDropdown, type Dropdown } from "../../shell/dropdown";
import { describeError, getPremiere } from "../../bridge/premiere";
import { nativePath, workspace, write } from "../silence/workspace";
import { parseSrt } from "./srtFile";
import { translateSrt, previewPairs } from "./applyTranslate";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, labelOf } from "./languages";
import { findSrtInProject, pickSrtFile, readAnyPath } from "./source";

let releaseDocument: (() => void) | null = null;
let cancelActive: (() => void) | null = null;

interface Carregada {
  name: string;
  text: string;
  cues: number;
}

export const translateTool: Tool = {
  id: "translate",
  name: "Traduzir Legenda",
  summary: "Traduz um .srt mantendo os tempos",
  hint:
    "Traga um .srt do disco ou do projeto aberto. A frase é traduzida " +
    "inteira, e os tempos saem idênticos aos que entraram.",
  category: "texto",
  glyph: "text",
  available: true,
  usesSelection: false,

  mount(container: HTMLElement, context: ToolContext): void {
    let carregada: Carregada | null = null;
    let from = "auto";
    let to = "pt";
    let busy = false;
    let ultimoSrt: { nome: string; conteudo: string } | null = null;

    container.innerHTML = markup();

    const vazioEl = container.querySelector<HTMLElement>("[data-empty]");
    const arquivoEl = container.querySelector<HTMLElement>("[data-file]");
    const importarEl = container.querySelector<HTMLElement>("[data-import]");
    const projetoEl = container.querySelector<HTMLElement>("[data-project]");
    const listaEl = container.querySelector<HTMLElement>("[data-list]");
    const fromEl = container.querySelector<HTMLElement>("[data-from]");
    const toEl = container.querySelector<HTMLElement>("[data-to]");
    const previaEl = container.querySelector<HTMLElement>("[data-preview]");

    context.setApplyLabel("TRADUZIR");
    context.setApplyEnabled(false);
    context.setResetLabel("LIMPAR");
    context.setResetHandler(null);
    context.setRefreshHandler(null);

    // ── os menus ──────────────────────────────────────────────

    const fromPick: Dropdown | null = fromEl
      ? mountDropdown(fromEl, {
          options: () => SOURCE_LANGUAGES.map((l) => ({ id: l.id, label: l.label })),
          selected: () => from,
          onPick: (id) => {
            from = id;
            fromPick?.render();
          },
        })
      : null;

    const toPick: Dropdown | null = toEl
      ? mountDropdown(toEl, {
          options: () => TARGET_LANGUAGES.map((l) => ({ id: l.id, label: l.label })),
          selected: () => to,
          onPick: (id) => {
            to = id;
            toPick?.render();
          },
        })
      : null;

    const fechar = (alvo: Element | null): void => {
      fromPick?.closeUnless(alvo);
      toPick?.closeUnless(alvo);
    };
    const noPonteiro = (e: Event): void => fechar(e.target as Element | null);
    const naTecla = (e: KeyboardEvent): void => {
      if (e.key === "Escape") fechar(null);
    };
    document.addEventListener("click", noPonteiro, true);
    document.addEventListener("keydown", naTecla, true);
    releaseDocument = () => {
      document.removeEventListener("click", noPonteiro, true);
      document.removeEventListener("keydown", naTecla, true);
    };

    // ── receber a legenda ─────────────────────────────────────

    function carregar(nome: string, texto: string): void {
      const doc = parseSrt(texto);
      if (doc.cues.length === 0) {
        context.setStatus(
          `"${nome}" não parece uma legenda — não achei nenhum bloco com tempo.`,
          "error"
        );
        return;
      }
      carregada = { name: nome, text: texto, cues: doc.cues.length };
      ultimoSrt = null;
      renderArquivo();
      esconderLista();
      renderPrevia([]);
      context.setApplyEnabled(true);
      context.setResetHandler(() => limpar());
      context.setStatus(
        `${doc.cues.length} ${doc.cues.length === 1 ? "bloco" : "blocos"} lidos de "${nome}".`,
        "done"
      );
    }

    importarEl?.addEventListener("click", () => {
      void (async () => {
        try {
          const escolhido = await pickSrtFile();
          if (escolhido) carregar(escolhido.name, escolhido.text);
        } catch (cause) {
          context.setStatus(describeError(cause), "error");
        }
      })();
    });

    projetoEl?.addEventListener("click", () => void listarProjeto());

    async function listarProjeto(): Promise<void> {
      if (busy) return;
      busy = true;
      if (projetoEl) {
        setDisabled(projetoEl, true);
        projetoEl.textContent = "Procurando…";
      }
      try {
        const achados = await findSrtInProject();
        if (achados.length === 0) {
          esconderLista();
          context.setStatus(
            "Nenhum .srt no projeto aberto. Use Importar para trazer do disco.",
            "idle"
          );
          return;
        }
        if (listaEl) {
          listaEl.hidden = false;
          listaEl.innerHTML =
            '<p class="tr-list-title">No projeto</p>' +
            achados
              .map(
                (a) =>
                  `<div class="tr-list-item" ${CONTROL} data-path="${escapeHtml(a.path)}" ` +
                  `data-name="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>`
              )
              .join("");
        }
        context.setStatus(
          `${achados.length} ${achados.length === 1 ? "legenda" : "legendas"} no projeto.`,
          "done"
        );
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        busy = false;
        if (projetoEl) {
          setDisabled(projetoEl, false);
          projetoEl.textContent = "Buscar no projeto";
        }
      }
    }

    listaEl?.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[data-path]");
      const caminho = item?.dataset.path;
      const nome = item?.dataset.name ?? "legenda.srt";
      if (!caminho || busy) return;
      void (async () => {
        busy = true;
        context.setStatus("Lendo a legenda…");
        try {
          carregar(nome, await readAnyPath(caminho));
        } catch (cause) {
          context.setStatus(describeError(cause), "error");
        } finally {
          busy = false;
        }
      })();
    });

    // ── traduzir ──────────────────────────────────────────────

    context.setApplyHandler(async () => {
      if (!carregada || busy) return;
      busy = true;
      let cancelado = false;
      cancelActive = () => {
        cancelado = true;
      };
      context.setApplyEnabled(false);
      context.setApplyLabel("TRADUZINDO…");

      try {
        const resultado = await translateSrt(carregada.text, {
          from,
          to,
          cancelled: () => cancelado,
          onProgress: (feitos, total) =>
            context.setStatus(`Traduzindo… ${feitos} de ${total}`),
        });

        if (!resultado.ok || !resultado.content) {
          context.setStatus(descreveFalha(resultado.error), "error");
          return;
        }

        const nome = nomeTraduzido(carregada.name, to);
        const espaco = await workspace();
        await write(espaco, nome, resultado.content);
        ultimoSrt = { nome, conteudo: resultado.content };
        renderPrevia(previewPairs(carregada.text, resultado.content, 3));

        const caminho = nativePath(espaco, nome);
        let noProjeto = false;
        try {
          const ppro = getPremiere();
          const project = ppro ? await ppro.Project.getActiveProject() : null;
          if (project) {
            noProjeto = (await project.importFiles([caminho], true)) === true;
          }
        } catch {
          // Entrar no projeto é conveniência; o arquivo já está no disco.
        }

        const origem =
          from === "auto" && resultado.detected
            ? `${labelOf(resultado.detected)} → ${labelOf(to)}`
            : `${labelOf(from)} → ${labelOf(to)}`;
        context.setStatus(
          `${resultado.translated} de ${resultado.total} blocos traduzidos · ${origem} · ` +
            (noProjeto
              ? "o .srt está no seu projeto"
              : `salvo em ${caminho}`),
          "done"
        );
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        busy = false;
        cancelActive = null;
        context.setApplyLabel("TRADUZIR");
        context.setApplyEnabled(!!carregada);
      }
    });

    function limpar(): void {
      carregada = null;
      ultimoSrt = null;
      renderArquivo();
      renderPrevia([]);
      esconderLista();
      context.setApplyEnabled(false);
      context.setResetHandler(null);
      context.setStatus("", "idle");
    }

    // ── desenho ───────────────────────────────────────────────

    function renderArquivo(): void {
      if (!arquivoEl) return;
      if (!carregada) {
        arquivoEl.hidden = true;
        arquivoEl.innerHTML = "";
        if (vazioEl) vazioEl.hidden = false;
        return;
      }
      if (vazioEl) vazioEl.hidden = true;
      arquivoEl.hidden = false;
      arquivoEl.innerHTML =
        `<span class="tr-file-name">${escapeHtml(carregada.name)}</span>` +
        `<span class="tr-file-meta">${carregada.cues} blocos</span>` +
        `<span class="tr-file-swap" ${CONTROL} data-swap>trocar</span>`;
      arquivoEl
        .querySelector<HTMLElement>("[data-swap]")
        ?.addEventListener("click", () => limpar());
    }

    function renderPrevia(pares: { antes: string; depois: string }[]): void {
      if (!previaEl) return;
      if (pares.length === 0) {
        previaEl.hidden = true;
        previaEl.innerHTML = "";
        return;
      }
      previaEl.hidden = false;
      previaEl.innerHTML =
        '<p class="tr-prev-title">Como ficou</p>' +
        pares
          .map(
            (p) =>
              '<div class="tr-prev-pair">' +
              `<span class="tr-prev-a">${escapeHtml(p.antes)}</span>` +
              `<span class="tr-prev-b">${escapeHtml(p.depois)}</span>` +
              "</div>"
          )
          .join("");
    }

    function esconderLista(): void {
      if (listaEl) {
        listaEl.hidden = true;
        listaEl.innerHTML = "";
      }
    }

    void ultimoSrt;
  },

  unmount(): void {
    cancelActive?.();
    cancelActive = null;
    releaseDocument?.();
    releaseDocument = null;
  },
};

/**
 * `entrevista.srt` + pt → `[PT] entrevista.srt`.
 *
 * O marcador vai na FRENTE, não no fim.
 *
 * No painel de projeto do Premiere o nome é cortado à direita, e um
 * sufixo `.pt` some justamente aí: `legendas-2026-09-04-mtnamedz.pt.srt`
 * aparece como `legendas-2026-09-04-mtn…` e não dá para saber qual é o
 * original e qual é o traduzido. Na frente, sobrevive a qualquer corte
 * e ainda agrupa os traduzidos na ordenação por nome.
 */
export function nomeTraduzido(original: string, para: string): string {
  const semExt = original.replace(/\.(srt|vtt)$/i, "");
  // Traduzir duas vezes não empilha marcadores.
  const limpo = semExt
    .replace(/^\[[A-Za-z]{2}(-[A-Za-z]{2,4})?\]\s*/, "")
    .replace(/\.[a-z]{2}(-[A-Za-z]{2,4})?$/i, "");
  return `[${para.toUpperCase()}] ${limpo}.srt`;
}

function descreveFalha(code: string | null): string {
  switch (code) {
    case "empty":
      return "Esse arquivo não tem nenhum bloco de legenda.";
    case "cancelled":
      return "Tradução cancelada.";
    case "engine-failed":
      return "O tradutor não respondeu. Confira a internet e tente de novo.";
    case "both-engines-failed":
      return (
        "Os dois tradutores recusaram. Pode ser limite de uso — espere alguns " +
        "minutos e tente de novo."
      );
    default:
      return "A tradução não terminou.";
  }
}

// ── markup ─────────────────────────────────────────────────────────

export function markup(): string {
  return (
    '<div class="zones">' +
      '<div class="zone">' +
        '<div class="field">' +
          '<span class="t-label">A legenda</span>' +
          // Sem zona de arrasto: o Premiere não entrega o evento de
          // soltar arquivo num painel UXP — testado, não funciona. Uma
          // área tracejada que não recebe nada é pior que não existir.
          '<div class="tr-acts" data-empty>' +
            `<div class="tr-btn" ${CONTROL} data-import>Importar arquivo…</div>` +
            `<div class="tr-btn" ${CONTROL} data-project>Buscar no projeto</div>` +
          "</div>" +
          '<div class="tr-file" data-file hidden></div>' +
          '<div class="tr-list" data-list hidden></div>' +
        "</div>" +
      "</div>" +

      '<div class="zone">' +
        '<div class="field">' +
          '<span class="t-label">Traduzir de</span>' +
          "<div data-from></div>" +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Para</span>' +
          "<div data-to></div>" +
          '<p class="field-note">Os tempos de cada bloco saem idênticos aos que ' +
          "entraram — só o texto muda. O arquivo novo entra no seu projeto ao lado " +
          "do original.</p>" +
        "</div>" +
      "</div>" +

      '<div class="zone is-wide">' +
        '<div class="tr-prev" data-preview hidden></div>' +
      "</div>" +
    "</div>"
  );
}
