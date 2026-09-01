/*
 * A réplica do painel — o elemento que carrega a página.
 *
 * Tudo aqui é copiado do plugin, não inventado: os nomes, os resumos,
 * o texto do callout, os rótulos dos controles e o do botão Aplicar
 * saem de src/shell/catalog.ts e de src/tools/. O estado mostrado é o
 * de ABERTURA — sem clipe selecionado, Aplicar desligado — que é
 * exatamente o que o editor vê ao abrir o painel. Um mockup que
 * mostrasse o resultado pronto estaria vendendo o que ninguém viu.
 *
 * Ao mexer numa ferramenta do plugin, atualize a entrada dela aqui.
 */

/* Os mesmos traços de src/shell/glyphs.ts. */
var GLYPHS = {
  zoom: '<circle cx="6.2" cy="6.2" r="3.8"/><path d="M9.2 9.2 12 12"/><path d="M4.7 6.2h3M6.2 4.7v3"/>',
  cut: '<path d="M2 7h10"/><path d="M4.5 3v8M9.5 3v8"/>',
  curve: '<path d="M2 11c3.4 0 3.4-8 5-8s2.6 4.5 5 4.5"/>',
  download: '<path d="M7 2.4v6.4"/><path d="M4.2 6.2 7 9l2.8-2.8"/><path d="M2.6 11.4h8.8"/>',
  folder: '<path d="M2 4.2h3.6l1 1.4H12v5.2H2z"/>'
};

function glyph(name) {
  return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.1" stroke-linecap="square">' +
    (GLYPHS[name] || "") + "</svg>";
}

function seg(items) {
  return '<div class="p-seg">' + items.map(function (item, index) {
    return '<span class="p-seg-item"' + (index === 0 ? ' data-on' : "") + ">" +
      item + "</span>";
  }).join("") + "</div>";
}

/*
 * Uma linha de fader. O valor e a posição do punho são os padrões
 * reais de applyZoom.ts — 120% numa faixa de 105 a 150, 1,6s numa de
 * 0,4 a 4,0 — e não números escolhidos por serem bonitos.
 */
function slider(label, value, percent) {
  return '<div class="p-field"><div class="p-field-head">' +
    '<span class="p-t-label">' + label + "</span>" +
    '<span class="p-val">' + value + "</span></div>" +
    '<div class="p-slider"><span class="p-slider-fill" style="width:' +
    percent + '%"></span>' +
    '<span class="p-slider-knob" style="left:' + percent + '%"></span></div>' +
    "</div>";
}

function field(label, inner) {
  return '<div class="p-field"><span class="p-t-label">' + label + "</span>" +
    inner + "</div>";
}

var CATEGORIES = [
  { id: "edicao", name: "Edição" },
  { id: "midia", name: "Mídia" },
  { id: "projeto", name: "Projeto" }
];

var TOOLS = [
  {
    id: "zoom",
    cat: "edicao",
    glyph: "zoom",
    name: "Zoom In / Out",
    summary: "Punch-in animado no clipe selecionado",
    hint: "Selecione um ou mais clipes na timeline e escolha a direção. " +
      "Os keyframes de escala entram num efeito Transform novo — o Motion " +
      "original não é tocado.",
    apply: "APLICAR ZOOM",
    body: field("Direção", seg(["Zoom In", "Zoom Out"])) +
      field("Comportamento", seg(["Punch Smooth", "Clipe inteiro"])) +
      slider("Intensidade (Escala Alvo)", "120%", 33) +
      slider("Duração do Punch", "1.6s", 33)
  },
  {
    id: "silence",
    cat: "edicao",
    glyph: "cut",
    name: "Corte de Silêncios",
    summary: "Remove pausas e fecha o corte automaticamente",
    hint: "Selecione os clipes falados na timeline e analise. " +
      "Os trechos com fala são mantidos e encostados na timeline.",
    apply: "CORTAR SILÊNCIOS",
    body: '<div class="p-empty">' +
      '<p class="p-empty-title">Pronto para analisar</p>' +
      '<p class="p-empty-desc">Selecione os clipes na timeline e analise ' +
      "para visualizar o corte.</p></div>" +
      '<span class="p-scan">Analisar Seleção</span>'
  },
  {
    id: "flow",
    cat: "edicao",
    glyph: "curve",
    name: "Curvas de velocidade",
    summary: "Assa easing entre keyframes existentes",
    hint: "Selecione o clipe animado na timeline. A lista relê sozinha " +
      "quando você volta ao painel — escolha um trecho, a curva e a " +
      "densidade.",
    apply: "Aplicar curva",
    body: field("Curva",
      '<div class="p-curves">' +
        curveCell("Punch", "M3,29 C7,29 9,5 30,5 C44,5 45,5 57,5", true) +
        curveCell("Ease Out", "M3,29 C20,29 34,5 57,5") +
        curveCell("Expo Out", "M3,29 C10,29 20,5 57,5") +
      "</div>") +
      '<div class="p-draw"><span class="p-draw-mark"></span>' +
      "<span>Desenhar a minha</span></div>"
  },
  {
    id: "download",
    cat: "midia",
    glyph: "download",
    name: "Baixar Vídeos",
    summary: "Download de YouTube e TikTok",
    hint: "Cole um ou mais links do YouTube ou do TikTok. O TikTok vem " +
      "sempre sem marca d'água, e o arquivo pode entrar direto no projeto " +
      "aberto.",
    apply: "BAIXAR",
    body: field("Links",
      '<span class="p-textarea">Cole os links do YouTube ou do TikTok — ' +
      "um por linha</span>") +
      '<span class="p-scan">Analisar links</span>' +
      field("Qualidade",
        '<span class="p-pick"><b>1080p</b><span>571 MB</span>' +
        '<i aria-hidden="true">▾</i></span>') +
      field("Destino",
        '<span class="p-path">~/Movies/Framelab</span>')
  },
  {
    id: "organize",
    cat: "projeto",
    glyph: "folder",
    name: "Organizar Pastas",
    summary: "Organização automática do projeto por tipo",
    hint: "Organiza apenas os arquivos e sequências soltos na raiz do " +
      "projeto. Suas pastas pessoais e pastas criadas por plugins " +
      "(Animation Composer, etc.) são 100% preservadas e intocadas.",
    apply: "ORGANIZAR PROJETO",
    body: '<div class="p-empty">' +
      '<p class="p-empty-title">Organização do Projeto</p>' +
      '<p class="p-empty-desc">Escaneia apenas os arquivos e sequências ' +
      "soltos na raiz do projeto. Suas pastas pessoais e pastas de plugins " +
      "são preservadas e intocadas.</p></div>" +
      '<span class="p-scan">Escanear Projeto</span>'
  }
];

/* Um traço de curva no mesmo desenho do curve-cell do plugin. */
function curveCell(name, path, on) {
  return '<span class="p-curve"' + (on ? " data-on" : "") + ">" +
    '<svg viewBox="0 0 60 34" preserveAspectRatio="none" aria-hidden="true">' +
    '<path class="p-curve-track" d="M4,30 L56,30"/>' +
    '<path class="p-curve-line" d="' + path + '"/></svg>' +
    '<span class="p-curve-name">' + name + "</span></span>";
}

function categoryName(id) {
  for (var i = 0; i < CATEGORIES.length; i += 1) {
    if (CATEGORIES[i].id === id) return CATEGORIES[i].name;
  }
  return "";
}

(function mountPanel() {
  var rail = document.querySelector("[data-rail]");
  if (!rail) return;

  var slots = {
    title: document.querySelector("[data-title]"),
    chip: document.querySelector("[data-chip]"),
    state: document.querySelector("[data-state]"),
    callout: document.querySelector("[data-callout]"),
    body: document.querySelector("[data-body]"),
    apply: document.querySelector("[data-apply]"),
    status: document.querySelector("[data-status]")
  };

  var active = TOOLS[0].id;

  rail.innerHTML = CATEGORIES.map(function (category) {
    var list = TOOLS.filter(function (tool) { return tool.cat === category.id; });
    if (list.length === 0) return "";
    return '<div class="p-cat"><span class="p-caret" aria-hidden="true"></span>' +
      "<span>" + category.name + "</span></div>" +
      list.map(function (tool) {
        return '<button type="button" class="p-tool" data-tool="' + tool.id +
          '" aria-pressed="false">' +
          '<span class="p-glyph">' + glyph(tool.glyph) + "</span>" +
          '<span class="p-text"><span class="p-name">' + tool.name + "</span>" +
          '<span class="p-summary">' + tool.summary + "</span></span></button>";
      }).join("");
  }).join("");

  function show(id) {
    var tool = null;
    for (var i = 0; i < TOOLS.length; i += 1) {
      if (TOOLS[i].id === id) tool = TOOLS[i];
    }
    if (!tool) return;
    active = id;

    var buttons = rail.querySelectorAll("[data-tool]");
    for (var j = 0; j < buttons.length; j += 1) {
      var on = buttons[j].getAttribute("data-tool") === id;
      buttons[j].setAttribute("aria-pressed", String(on));
      buttons[j].classList.toggle("is-active", on);
    }

    slots.title.textContent = tool.name;
    slots.chip.textContent = categoryName(tool.cat);
    // O painel escreve esta linha em toda ferramenta, mesmo nas que não
    // agem sobre a seleção. A réplica mente se "arrumar" isso.
    slots.state.innerHTML =
      '<span class="p-dot"></span><span>Nenhum clipe de vídeo selecionado</span>';
    slots.callout.textContent = tool.hint;
    slots.body.innerHTML = tool.body;
    slots.apply.textContent = tool.apply;
    slots.status.textContent = tool.name;
  }

  rail.addEventListener("click", function (event) {
    var button = event.target.closest("[data-tool]");
    if (button) show(button.getAttribute("data-tool"));
  });

  show(active);
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
    for (var i = 0; i < chips.length; i += 1) {
      chips[i].textContent = "v" + data.version;
    }
    var full = document.querySelector("[data-version-full]");
    if (full) full.textContent = data.version + " · beta";
  }).catch(function () {
    /* Offline ou repositório privado: os valores do HTML seguem valendo. */
  });
})();
