const fs = require("fs");
const axios = require("axios");
const { loadRootConfig, parseInOut, readJsonFile, getTavilyApiKey, sleep } = require("./pipelineUtil");
const { getEasternYmd, getEasternDisplayDate, subtractCalendarDaysFromYmd } = require("./easternTime");
const { fetchMlbScheduleForAdvice } = require("./mlbStatsApi");

const TAVILY_SEARCH = "https://api.tavily.com/search";
const SNIPPET_MAX = 700;

function num(cfgVal, envVal, fallback) {
  const n = envVal !== undefined && envVal !== "" ? Number(envVal) : Number(cfgVal);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function mlbStatsApiEnabled(cfg) {
  const e = process.env.FETCH_MLB_STATS_API;
  if (e === "0" || e === "false") return false;
  if (cfg && cfg.FETCH_MLB_STATS_API === false) return false;
  return true;
}

function collectPlayers(adviceContext, maxQueries) {
  const roster = adviceContext.my_roster || [];
  const fas = adviceContext.free_agents || [];
  const out = [];
  const seen = new Set();
  for (const p of roster) {
    const name = (p.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, role: "roster" });
  }
  for (const p of fas) {
    if (out.length >= maxQueries) break;
    const name = (p.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, role: "free_agent" });
  }
  return out.slice(0, maxQueries);
}

function collectStreamingTargets(advice, max) {
  const pool = advice.streaming_pitcher_pool || {};
  const roster = pool.from_my_roster || [];
  const fa = pool.from_waiver_wire || [];
  const out = [];
  const seen = new Set();
  const push = (p, role) => {
    const name = (p.name || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, role });
  };
  for (const p of fa) {
    if (out.length >= max) break;
    push(p, "streaming_fa_sp");
  }
  for (const p of roster) {
    if (out.length >= max) break;
    push(p, "streaming_roster_sp");
  }
  return out;
}

function buildStreamingSearchQuery(m) {
  const today = m.streamDatePhrase;
  const week = m.streamWeekPhrase || "this fantasy baseball week";
  return ({ name }) =>
    `"${name}" MLB starting pitcher probable ${today} ${week} next start opponent two-start stream`;
}

function collectTeamsForWeather(advice, maxTeams) {
  const roster = advice.lineup_start_sit || advice.my_roster || [];
  const seen = new Set();
  const out = [];
  for (const p of roster) {
    const abbr = (p.team_abbr || "").trim();
    const full = (p.team_name || "").trim();
    const dedupe = (abbr || full).toLowerCase();
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    const label = full && abbr ? `${full} (${abbr})` : full || abbr;
    out.push({ team_abbr: abbr || null, team_name: full || null, label });
    if (out.length >= maxTeams) break;
  }
  return out;
}

function trimSnippet(text) {
  if (!text || typeof text !== "string") return "";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= SNIPPET_MAX ? t : `${t.slice(0, SNIPPET_MAX)}…`;
}

async function tavilySearch(apiKey, query, topic = "news", extra = {}) {
  const { data } = await axios({
    method: "post",
    url: TAVILY_SEARCH,
    headers: { "Content-Type": "application/json" },
    data: {
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 4,
      topic,
      include_answer: false,
      ...extra,
    },
    timeout: 45000,
  });
  const results = (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: trimSnippet(r.content || r.raw_content || ""),
  }));
  return { results, response_time: data.response_time };
}

async function runSearchSeries(apiKey, items, buildQuery, label, delayMs, topic = "news", tavilyExtra = {}) {
  const entries = [];
  let i = 0;
  for (const item of items) {
    i += 1;
    const query = buildQuery(item);
    process.stderr.write(`[${label} ${i}/${items.length}] ${query.slice(0, 60)}… `);
    try {
      const { results } = await tavilySearch(apiKey, query, topic, tavilyExtra);
      entries.push({ ...item, query, results });
      console.error(`ok (${results.length})`);
    } catch (err) {
      const msg = err.response?.data?.detail || err.response?.data?.error || err.message || String(err);
      entries.push({ ...item, query, error: msg, results: [] });
      console.error(`err: ${msg}`);
    }
    if (i < items.length && delayMs > 0) await sleep(delayMs);
  }
  return entries;
}

async function main() {
  const cfg = loadRootConfig();
  const apiKey = getTavilyApiKey(cfg);
  if (!apiKey) {
    console.error("Missing Tavily API key. Set TAVILY_API_KEY in the environment or TAVILY_API_KEY in config.json.");
    process.exit(1);
  }

  const maxPlayerQueries = num(cfg.WEB_SEARCH_MAX_PLAYERS, process.env.WEB_SEARCH_MAX_PLAYERS, 28);
  const maxStreaming = num(cfg.WEB_STREAMING_MAX_QUERIES, process.env.WEB_STREAMING_MAX_QUERIES, 14);
  const maxWeatherTeams = num(cfg.WEB_WEATHER_TEAM_MAX, process.env.WEB_WEATHER_TEAM_MAX, 10);
  const delayMs = num(cfg.WEB_SEARCH_DELAY_MS, process.env.WEB_SEARCH_DELAY_MS, 450);

  const { inFile, outFile } = parseInOut(process.argv, "advice-context.json", "web-context.json");
  if (!fs.existsSync(inFile)) {
    console.error(`Input not found: ${inFile} (run: npm run advice-context)`);
    process.exit(1);
  }

  const advice = readJsonFile(inFile);

  const easternYmd = getEasternYmd();
  const easternDisplay = getEasternDisplayDate();
  const playerNewsPublishedAfter = subtractCalendarDaysFromYmd(easternYmd, 5);

  let mlb_schedule = null;
  if (mlbStatsApiEnabled(cfg)) {
    const baseUrl = process.env.MLB_STATS_API_BASE || cfg.MLB_STATS_API_BASE || "https://statsapi.mlb.com";
    console.error("Fetching MLB Stats API (schedule / probables)…");
    try {
      mlb_schedule = await fetchMlbScheduleForAdvice(advice, {
        easternYmd,
        matchup: advice.matchup_this_week,
        baseUrl,
      });
      console.error(
        `MLB schedule ok (${mlb_schedule.game_count_returned} games, ${mlb_schedule.relevant_team_abbr.length} team abbrevs)`,
      );
    } catch (err) {
      const msg = err.response?.data || err.message || String(err);
      mlb_schedule = {
        source: "mlb_stats_api",
        error: typeof msg === "string" ? msg : JSON.stringify(msg),
        games: [],
        start_date: null,
        end_date: null,
        relevant_team_abbr: [],
        game_count_returned: 0,
      };
      console.error(`MLB Stats API error: ${mlb_schedule.error}`);
    }
  }

  const players = collectPlayers(advice, maxPlayerQueries);
  const entries = await runSearchSeries(
    apiKey,
    players,
    ({ name }) =>
      `"${name}" MLB baseball ${easternDisplay} injury lineup IL activation roster news`,
    "player",
    delayMs,
    "news",
    { start_date: playerNewsPublishedAfter },
  );

  const matchup = advice.matchup_this_week;
  const streamWeekPhrase = matchup
    ? `H2H week ${matchup.week ?? "?"} (${matchup.week_start || "?"}–${matchup.week_end || "?"})`
    : "this H2H matchup week";
  const streamDatePhrase = easternDisplay;
  const streamTavilyStart = subtractCalendarDaysFromYmd(easternYmd, 5);
  const streamQueryBuilder = buildStreamingSearchQuery({ streamDatePhrase, streamWeekPhrase });

  const streamTargets = collectStreamingTargets(advice, maxStreaming);
  const streaming_matchup_entries =
    streamTargets.length === 0
      ? []
      : await runSearchSeries(
          apiKey,
          streamTargets,
          streamQueryBuilder,
          "stream",
          delayMs,
          "news",
          { start_date: streamTavilyStart },
        );

  const weatherTeams = collectTeamsForWeather(advice, maxWeatherTeams);
  const weatherDatePhrase = easternDisplay;
  const weatherPublishedAfter = subtractCalendarDaysFromYmd(easternYmd, 3);
  const team_weather_entries =
    weatherTeams.length === 0
      ? []
      : await runSearchSeries(
          apiKey,
          weatherTeams,
          ({ label }) =>
            `${label} MLB ballpark weather ${weatherDatePhrase} forecast rain delay postponement`,
          "weather",
          delayMs,
          "news",
          {
            start_date: weatherPublishedAfter,
          },
        );

  const payload = {
    meta: {
      sources: ["tavily", ...(mlb_schedule ? ["mlb_stats_api"] : [])],
      web_context_version: 4,
      generated_at: new Date().toISOString(),
      player_count: players.length,
      player_news_eastern_ymd: easternYmd,
      player_news_query_display: easternDisplay,
      player_news_tavily_start_date: playerNewsPublishedAfter,
      streaming_query_count: streaming_matchup_entries.length,
      weather_team_count: team_weather_entries.length,
      weather_query_eastern_ymd: easternYmd,
      weather_query_display: weatherDatePhrase,
      weather_tavily_start_date: weatherPublishedAfter,
      streaming_query_eastern_ymd: easternYmd,
      streaming_query_today_display: streamDatePhrase,
      streaming_query_week_phrase: streamWeekPhrase,
      streaming_tavily_start_date: streamTavilyStart,
      disclaimer:
        "Tavily: cite URLs; verify claims. MLB block (mlb_schedule): official schedule/probables feed; listed probables and times can change — not guaranteed starters. Confirm in Yahoo / MLB before locking lineups.",
    },
    entries,
    streaming_matchup_entries,
    team_weather_entries,
    mlb_schedule,
  };

  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.error(`Wrote ${outFile}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

exports.collectPlayers = collectPlayers;
exports.collectStreamingTargets = collectStreamingTargets;
exports.collectTeamsForWeather = collectTeamsForWeather;
