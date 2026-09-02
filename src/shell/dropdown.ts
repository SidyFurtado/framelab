/**
 * Um botão que abre uma lista de opções.
 *
 * Nasceu no Baixar Vídeos e mora aqui porque a segunda ferramenta a
 * precisar dele provou que é vocabulário do painel, não de uma
 * ferramenta: a alternativa — uma barra de segmentos com muitos
 * degraus — enche a tela para responder uma pergunta que se responde
 * uma vez. Fechado ocupa uma linha e diz a escolha; aberto mostra a
 * informação que de fato decide.
 *
 * Também resolve listas longas: o UXP não honra `flex-wrap`, então uma
 * fila de dez idiomas não quebraria linha — espremeria todos até
 * ninguém conseguir ler.
 */
import { CONTROL, escapeHtml } from "./controls";

export interface MenuOption {
  readonly id: string;
  readonly label: string;
  /** Direita da linha: tamanho, resolução. Vazio some. */
  readonly meta?: string;
}

export interface Dropdown {
  /** Relê as opções e o selecionado. */
  render(): void;
  /** Fecha, a menos que o clique tenha sido dentro dele. */
  closeUnless(target: Element | null): void;
}

export function mountDropdown(
  host: HTMLElement,
  source: {
    options(): MenuOption[];
    selected(): string;
    onPick(id: string): void;
  }
): Dropdown {
  host.className = "dl-pick-wrap";
  host.innerHTML =
    `<div class="dl-pick" ${CONTROL} data-pick-button aria-expanded="false">` +
      '<span class="dl-pick-value" data-pick-value></span>' +
      '<span class="dl-pick-meta" data-pick-meta></span>' +
      '<span class="dl-pick-caret" aria-hidden="true">▾</span>' +
    "</div>" +
    '<div class="dl-menu" data-pick-menu hidden></div>';

  const button = host.querySelector<HTMLElement>("[data-pick-button]")!;
  const valueEl = host.querySelector<HTMLElement>("[data-pick-value]")!;
  const metaEl = host.querySelector<HTMLElement>("[data-pick-meta]")!;
  const menu = host.querySelector<HTMLElement>("[data-pick-menu]")!;

  function setOpen(open: boolean): void {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }

  function render(): void {
    const options = source.options();
    const selected = source.selected();
    const current = options.find((option) => option.id === selected);

    valueEl.textContent = current?.label ?? "—";
    metaEl.textContent = current?.meta ?? "";

    menu.innerHTML = options
      .map(
        (option) =>
          `<div class="dl-menu-item" ${CONTROL} data-value="${escapeHtml(option.id)}" ` +
          `aria-pressed="${option.id === selected}">` +
          `<span class="dl-menu-name">${escapeHtml(option.label)}</span>` +
          `<span class="dl-menu-meta">${escapeHtml(option.meta ?? "")}</span>` +
          "</div>"
      )
      .join("");
  }

  button.addEventListener("click", () => setOpen(menu.hidden));

  menu.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>("[data-value]");
    const id = item?.dataset.value;
    if (!id) return;
    setOpen(false);
    source.onPick(id);
  });

  render();

  return {
    render,
    closeUnless(target) {
      if (!menu.hidden && !host.contains(target)) {
        setOpen(false);
      }
    },
  };
}
