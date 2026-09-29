/*
 * O catálogo da página conversa com o painel de verdade (app/, no iframe).
 *
 * Os nomes e os resumos saem de cada ferramenta em src/tools/ e as
 * categorias de src/shell/catalog.ts. Os ícones não são copiados: vêm
 * do próprio painel, lidos do iframe depois que ele abre. Ferramenta
 * nova no plugin = uma linha nova aqui.
 */

var CATEGORIES = [
  { id: "edicao", name: "Edição" },
  { id: "texto", name: "Texto" },
  { id: "audio", name: "Áudio" },
  { id: "midia", name: "Mídia" },
  { id: "projeto", name: "Projeto" }
];

/* `since` marca a versão em que a ferramenta chegou; as da última aparecem como novas. */
var TOOLS = [
  { id: "zoom", cat: "edicao", name: "Zoom In / Out", summary: "Punch-in animado no clipe selecionado" },
  { id: "silence", cat: "edicao", name: "Corte de Silêncios", summary: "Remove pausas e fecha o corte automaticamente" },
  { id: "fillers", cat: "edicao", name: "Cortar Muletas", summary: "Remove os ééé e aaamm da fala" },
  { id: "flow", cat: "edicao", name: "Curvas de velocidade", summary: "Assa easing entre keyframes existentes" },
  { id: "captions", cat: "texto", name: "Legendas", summary: "Transcrição mais precisa, por faixa de áudio" },
  { id: "titles", cat: "texto", name: "Textos Animados", summary: "Título ou legenda .srt que já entram animados", since: "0.5.0" },
  { id: "translate", cat: "texto", name: "Traduzir Legenda", summary: "Traduz um .srt mantendo os tempos" },
  { id: "sfx", cat: "audio", name: "Efeitos Sonoros", summary: "O pack de SFX da equipe, organizado e com prévia", since: "0.5.0" },
  { id: "sound-design", cat: "audio", name: "SFX Automático", summary: "O som do que está na tela", since: "0.5.0" },
  { id: "download", cat: "midia", name: "Baixar Vídeos", summary: "Download de YouTube, TikTok e Instagram" },
  { id: "organize", cat: "projeto", name: "Organizar Pastas", summary: "Organização automática do projeto por tipo" }
];

var LATEST = "0.5.0";

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

(function catalog() {
  var host = document.querySelector("[data-catalog]");
  var frame = document.querySelector("[data-panel]");
  if (!host || !frame) return;

  host.innerHTML = CATEGORIES.map(function (category) {
    var list = TOOLS.filter(function (tool) { return tool.cat === category.id; });
    if (list.length === 0) return "";
    return (
      '<div class="drawer">' +
      '<h3 class="drawer-name"><b>' + category.name + "</b> · " + list.length + "</h3>" +
      '<ul class="drawer-list">' +
      list.map(function (tool) {
        return (
          "<li>" +
          '<button type="button" class="tool" data-open="' + tool.id + '">' +
          '<span class="tool-glyph" data-glyph="' + tool.id + '" aria-hidden="true"></span>' +
          '<span class="tool-text">' +
          '<span class="tool-name">' + escapeHtml(tool.name) +
          (tool.since === LATEST ? '<span class="tool-new">novo</span>' : "") +
          "</span>" +
          '<span class="tool-summary">' + escapeHtml(tool.summary) + "</span>" +
          "</span>" +
          '<span class="tool-open" aria-hidden="true">abrir ↑</span>' +
          "</button></li>"
        );
      }).join("") +
      "</ul></div>"
    );
  }).join("");

  function panelDoc() {
    try {
      return frame.contentDocument;
    } catch (_) {
      return null; // outra origem: o catálogo continua, só não aciona o painel
    }
  }

  function mark(id) {
    var buttons = host.querySelectorAll("[data-open]");
    for (var i = 0; i < buttons.length; i += 1) {
      var on = buttons[i].getAttribute("data-open") === id;
      buttons[i].classList.toggle("is-on", on);
      buttons[i].setAttribute("aria-pressed", String(on));
    }
  }

  /* Os ícones e a ferramenta aberta vêm do painel, depois que ele monta. */
  function adopt() {
    var doc = panelDoc();
    if (!doc || !doc.querySelector(".nav-tool[data-tool]")) return false;

    var slots = host.querySelectorAll("[data-glyph]");
    for (var i = 0; i < slots.length; i += 1) {
      var svg = doc.querySelector('[data-tool="' + slots[i].getAttribute("data-glyph") + '"] svg');
      if (svg) slots[i].innerHTML = svg.outerHTML;
    }

    function syncActive() {
      var active = doc.querySelector(".nav-tool.is-active[data-tool]");
      mark(active ? active.getAttribute("data-tool") : null);
    }
    new MutationObserver(syncActive).observe(doc.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
    syncActive();
    return true;
  }

  function waitForPanel() {
    var tries = 0;
    (function poll() {
      if (adopt() || (tries += 1) > 60) return;
      setTimeout(poll, 100);
    })();
  }
  frame.addEventListener("load", waitForPanel);
  if (panelDoc() && panelDoc().readyState === "complete") waitForPanel();

  host.addEventListener("click", function (event) {
    var button = event.target.closest("[data-open]");
    if (!button) return;
    var doc = panelDoc();
    var target = doc && doc.querySelector('.nav-tool[data-tool="' + button.getAttribute("data-open") + '"]');
    if (target) target.click();
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    frame.closest(".dock").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  });
})();

/*
 * A versão vem do version.json do repositório, então a página não
 * mente sobre o que está publicado quando sai uma release nova.
 */
(function readVersion() {
  var url = "https://raw.githubusercontent.com/SidyFurtado/framelab/main/version.json";
  fetch(url + "?t=" + Date.now()).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (data) {
    if (!data || !data.version) return;
    var chips = document.querySelectorAll("[data-version-chip]");
    for (var i = 0; i < chips.length; i += 1) chips[i].textContent = "v" + data.version;
    var full = document.querySelector("[data-version-full]");
    if (full) full.textContent = data.version + " · beta" + (data.releaseDate ? " · " + formatDate(data.releaseDate) : "");
  }).catch(function () {
    /* Offline: os valores do HTML seguem valendo. */
  });

  function formatDate(iso) {
    var parts = String(iso).split("-");
    return parts.length === 3 ? parts[2] + "/" + parts[1] + "/" + parts[0] : iso;
  }
})();
