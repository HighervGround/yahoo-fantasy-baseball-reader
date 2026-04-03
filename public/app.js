function $(id) {
  return document.getElementById(id);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${name}`);
  });
}

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

function renderNews(entries) {
  const el = $("news-body");
  if (!entries || entries.length === 0) {
    el.innerHTML = '<p class="empty">No player entries. Run <code>npm run web-context</code>.</p>';
    return;
  }
  el.innerHTML = entries
    .map((e) => {
      const results = e.results || [];
      const err = e.error ? `<p class="err">${esc(e.error)}</p>` : "";
      const blocks =
        results.length === 0
          ? '<p class="empty">No results (or API error).</p>'
          : results
              .map(
                (r) => `
        <div class="result">
          <a class="title" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a>
          <div class="snippet">${esc(r.snippet || "")}</div>
        </div>`,
              )
              .join("");
      return `
      <article class="player-card">
        <h3>${esc(e.name || e.player || "Player")}</h3>
        <div class="role">${esc(e.role || "")}</div>
        ${err}
        ${blocks}
      </article>`;
    })
    .join("");
}

function renderStream(entries) {
  const el = $("stream-body");
  if (!entries || entries.length === 0) {
    el.innerHTML = '<p class="empty">No streaming queries.</p>';
    return;
  }
  el.innerHTML = entries
    .map((e) => {
      const results = e.results || [];
      const blocks =
        results.length === 0
          ? '<p class="empty">No results.</p>'
          : results
              .map(
                (r) => `
        <div class="result">
          <a class="title" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a>
          <div class="snippet">${esc(r.snippet || "")}</div>
        </div>`,
              )
              .join("");
      return `
      <article class="player-card">
        <h3>${esc(e.name || "Pitcher")}</h3>
        <div class="role">${esc(e.role || "")}</div>
        ${blocks}
      </article>`;
    })
    .join("");
}

function renderWeather(entries) {
  const el = $("weather-body");
  if (!entries || entries.length === 0) {
    el.innerHTML = '<p class="empty">No weather queries.</p>';
    return;
  }
  el.innerHTML = entries
    .map((e) => {
      const results = e.results || [];
      const blocks =
        results.length === 0
          ? '<p class="empty">No results.</p>'
          : results
              .map(
                (r) => `
        <div class="result">
          <a class="title" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a>
          <div class="snippet">${esc(r.snippet || "")}</div>
        </div>`,
              )
              .join("");
      return `
      <article class="player-card">
        <h3>${esc(e.label || "Team")}</h3>
        ${blocks}
      </article>`;
    })
    .join("");
}

function renderMlb(mlb) {
  const el = $("mlb-body");
  if (!mlb) {
    el.innerHTML = '<p class="empty">No MLB block. Enable FETCH_MLB_STATS_API and run <code>npm run web-context</code>.</p>';
    return;
  }
  if (mlb.error) {
    el.innerHTML = `<p class="err">MLB API: ${esc(mlb.error)}</p>`;
    return;
  }
  const games = mlb.games || [];
  if (games.length === 0) {
    el.innerHTML = `<p class="empty">No games in range ${esc(mlb.start_date)} – ${esc(mlb.end_date)} for tracked teams.</p>`;
    return;
  }
  const rows = games
    .map((g) => {
      const awayP = g.away?.probable_pitcher || "—";
      const homeP = g.home?.probable_pitcher || "—";
      return `<tr>
        <td>${esc(g.official_date)}</td>
        <td>${esc(g.status)}</td>
        <td>${esc(g.away?.abbr)} @ ${esc(g.home?.abbr)}</td>
        <td>${esc(awayP)}</td>
        <td>${esc(homeP)}</td>
        <td>${esc(g.venue || "")}</td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `
    <p class="sub" style="margin:0 0 1rem;color:var(--muted);font-size:0.9rem;">
      ${esc(mlb.start_date)} → ${esc(mlb.end_date)} · ${games.length} games shown (cap in API) · ${esc(mlb.game_count_returned || games.length)} total fetched
    </p>
    <div style="overflow-x:auto">
      <table class="schedule">
        <thead><tr><th>Date</th><th>Status</th><th>Matchup</th><th>Away SP</th><th>Home SP</th><th>Venue</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function load() {
  const sub = $("header-sub");
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    const data = await res.json();

    const parts = [];
    if (data.files?.advice_md) parts.push("advice.md");
    else parts.push("missing advice.md");
    if (data.files?.web_context) parts.push("web-context.json");
    else parts.push("missing web-context.json");
    sub.textContent = parts.join(" · ");

    if (data.adviceHtml) {
      $("advice-body").innerHTML = data.adviceHtml;
    } else {
      $("advice-body").innerHTML =
        '<p class="empty">No <code>advice.md</code> yet. Run <code>npm run advise</code> (after context files exist).</p>';
    }

    const meta = data.webContext?.meta || {};
    if (meta.generated_at) {
      sub.textContent += ` · web data: ${meta.generated_at}`;
    }

    const nb = $("news-banner");
    if (meta.player_news_tavily_start_date && meta.player_news_query_display) {
      nb.hidden = false;
      $("news-start").textContent = meta.player_news_tavily_start_date;
      $("news-display").textContent = meta.player_news_query_display;
    }

    renderNews(data.webContext?.entries);
    renderStream(data.webContext?.streaming_matchup_entries);
    renderWeather(data.webContext?.team_weather_entries);
    renderMlb(data.webContext?.mlb_schedule);
  } catch (e) {
    sub.textContent = "Failed to load /api/data";
    $("advice-body").innerHTML = `<p class="err">${esc(e.message || e)}</p>`;
  }
}

load();
