const fs = require("fs");
const axios = require("axios");
const { loadRootConfig, parseInOut, readJsonFile, getTavilyApiKey, sleep } = require("./pipelineUtil");

const TAVILY_SEARCH = "https://api.tavily.com/search";
const SNIPPET_MAX = 700;

function num(cfgVal, envVal, fallback) {
  const n = envVal !== undefined && envVal !== "" ? Number(envVal) : Number(cfgVal);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
  for (const p of roster) {
    const name = (p.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, role: "streaming_roster_sp" });
    if (out.length >= max) return out;
  }
  for (const p of fa) {
    if (out.length >= max) break;
    const name = (p.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, role: "streaming_fa_sp" });
  }
  return out;
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

async function tavilySearch(apiKey, query, topic = "news") {
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

async function runSearchSeries(apiKey, items, buildQuery, label, delayMs, topic = "news") {
  const entries = [];
  let i = 0;
  for (const item of items) {
    i += 1;
    const query = buildQuery(item);
    process.stderr.write(`[${label} ${i}/${items.length}] ${query.slice(0, 60)}… `);
    try {
      const { results } = await tavilySearch(apiKey, query, topic);
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

  const players = collectPlayers(advice, maxPlayerQueries);
  const entries = await runSearchSeries(
    apiKey,
    players,
    ({ name }) => `"${name}" MLB injury OR lineup OR starting OR news`,
    "player",
    delayMs,
    "news",
  );

  const streamTargets = collectStreamingTargets(advice, maxStreaming);
  const streaming_matchup_entries =
    streamTargets.length === 0
      ? []
      : await runSearchSeries(
          apiKey,
          streamTargets,
          ({ name }) =>
            `"${name}" MLB starting pitcher next start probable opponent matchup two-start stream fantasy baseball`,
          "stream",
          delayMs,
          "news",
        );

  const weatherTeams = collectTeamsForWeather(advice, maxWeatherTeams);
  const team_weather_entries =
    weatherTeams.length === 0
      ? []
      : await runSearchSeries(
          apiKey,
          weatherTeams,
          ({ label }) => `${label} MLB ballpark weather forecast rain delay postponement this week`,
          "weather",
          delayMs,
          "general",
        );

  const payload = {
    meta: {
      source: "tavily",
      web_context_version: 2,
      generated_at: new Date().toISOString(),
      player_count: players.length,
      streaming_query_count: streaming_matchup_entries.length,
      weather_team_count: team_weather_entries.length,
      disclaimer:
        "Snippets are from web search; verify before lineup/streaming decisions. Not official MLB or Yahoo data.",
    },
    entries,
    streaming_matchup_entries,
    team_weather_entries,
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
