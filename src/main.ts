import "./styles/fonts.css";
import "./styles/shell.css";
import { ProductShell } from "./shell/ProductShell";

/**
 * Anything thrown here used to leave the panel a blank rectangle: the
 * Shell constructor and the first Tool's mount both run inside bootstrap,
 * and a UXP panel is the hardest place there is to reach a console. So
 * the failure gets painted where the panel would have been.
 */
function bootstrap(): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  try {
    new ProductShell(root).start();
  } catch (cause) {
    console.error("[Edit Toolbox] falha ao iniciar:", cause);
    renderFatal(root, cause);
  }
}

function renderFatal(root: HTMLElement, cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const stack = cause instanceof Error && cause.stack ? cause.stack : "";

  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "fatal";

  const title = document.createElement("p");
  title.className = "fatal-title";
  title.textContent = "O painel não conseguiu iniciar.";

  const message = document.createElement("p");
  message.className = "fatal-message";
  message.textContent = detail;

  const hint = document.createElement("p");
  hint.className = "fatal-hint";
  hint.textContent =
    "Recarregue o plugin no UXP Developer Tool. Se persistir, confira se a " +
    "versão do Premiere atende ao mínimo declarado no manifest.";

  panel.append(title, message, hint);

  if (stack) {
    const trace = document.createElement("pre");
    trace.className = "fatal-trace";
    trace.textContent = stack;
    panel.append(trace);
  }

  root.append(panel);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
