/*
 * O painel de verdade, fora do Premiere.
 *
 * Este arquivo roda antes do bundle do plugin e só mexe na rede:
 *
 * - A listagem do pack de SFX vem do Drive, que recusa a leitura vinda
 *   de outro site. Aqui ela é respondida com uma amostra do pack real
 *   (demo-drive.json, gerada por scripts/build-site.cjs), no mesmo
 *   formato da página `embeddedfolderview` que o plugin lê.
 * - Baixar um som não acontece na prévia: a resposta é uma recusa, e o
 *   painel mostra a mensagem dele.
 */
(function () {
  var realFetch = window.fetch.bind(window);
  var FOLDER_VIEW = "https://drive.google.com/embeddedfolderview?id=";
  var DOWNLOAD = "https://drive.usercontent.google.com/";
  var sample = null;

  function loadSample() {
    if (!sample) {
      sample = realFetch("demo-drive.json").then(function (response) {
        return response.ok ? response.json() : { folders: {} };
      });
    }
    return sample;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function folderView(entries) {
    return (
      '<div class="flip-entries">' +
      entries
        .map(function (entry) {
          var href = entry.folder
            ? "https://drive.google.com/drive/folders/" + entry.id
            : "https://drive.google.com/file/d/" + entry.id + "/view";
          return (
            '<div class="flip-entry" id="entry-' + entry.id + '">' +
            '<a href="' + href + '">' +
            '<div class="flip-entry-title">' + escapeHtml(entry.name) + "</div>" +
            '<div class="flip-entry-last-modified"><div>' + escapeHtml(entry.stamp || "") + "</div></div>" +
            "</a></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    if (url && url.indexOf(FOLDER_VIEW) === 0) {
      var id = decodeURIComponent(url.slice(FOLDER_VIEW.length).split("&")[0]);
      return loadSample().then(function (data) {
        var entries = data.folders[id];
        if (!entries) return new Response("", { status: 404 });
        return new Response(folderView(entries), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
    }
    if (url && url.indexOf(DOWNLOAD) === 0) {
      return Promise.resolve(new Response("", { status: 503, statusText: "prévia" }));
    }
    return realFetch(input, init);
  };
})();
