/**
 * UXP paints native chrome for <button>: a grey rounded widget that
 * ignores background, border and border-radius, and that `appearance`
 * cannot switch off. So none of the panel's controls are <button>
 * elements — they are divs we draw ourselves, with the button role and
 * keyboard behaviour restored here.
 *
 * <input> is still a real input; only its own chrome is reset in CSS.
 */

/** Attributes that turn an element into a control, for string markup. */
export const CONTROL = 'role="button" tabindex="0"';

export function createControl(className: string, label?: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.setAttribute("role", "button");
  element.tabIndex = 0;
  if (label !== undefined) {
    element.textContent = label;
  }
  return element;
}

export function setDisabled(element: HTMLElement, disabled: boolean): void {
  element.classList.toggle("is-disabled", disabled);
  element.setAttribute("aria-disabled", String(disabled));
  element.tabIndex = disabled ? -1 : 0;
}

export function isDisabled(element: HTMLElement): boolean {
  return element.getAttribute("aria-disabled") === "true";
}

/**
 * Enter and Space activate a control, the way a real button would.
 * One listener on the shell root covers every control, including the
 * ones rendered later from HTML strings.
 */
export function bindKeyboard(root: HTMLElement): void {
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const control = target.closest<HTMLElement>('[role="button"]');
    if (!control || isDisabled(control)) {
      return;
    }
    event.preventDefault();
    control.click();
  });
}

/**
 * O escapador de HTML do painel inteiro.
 *
 * Vivia copiado em sete arquivos, e sete cópias de código de escape
 * são sete lugares para uma correção não chegar. Todo texto vindo do
 * host — nome de clipe, título de vídeo, caminho — passa por aqui
 * antes de entrar em innerHTML. A aspa simples entra no conjunto
 * porque atributo com aspas simples existe e a cópia que não escapava
 * era exatamente o buraco.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
