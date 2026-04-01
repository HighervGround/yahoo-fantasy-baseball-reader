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

function trimSnippet(text) {
  if (!text || typeof text !== "string") return "";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= SNIPPET_MAX ? t : `${t.slice(0, SNIPPET_MAX)}…`;
}

async function tavilySearch(apiKey, query) {
  const { data } = await axios({
    method: "post",
    url: TAVILY_SEARCH,
    headers: { "Content-Type": "application/json" },
    data: {
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 4,
      topic: "news",
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

async function main() {
  const cfg = loadRootConfig();
  const apiKey = getTavilyApiKey(cfg);
  if (!apiKey) {
    console.error("Missing Tavily API key. Set TAVILY_API_KEY in the environment or TAVILY_API_KEY in config.json.");
    process.exit(1);
  }

  const maxQueries = num(cfg.WEB_SEARCH_MAX_PLAYERS, process.env.WEB_SEARCH_MAX_PLAYERS, 28);
  const delayMs = num(cfg.WEB_SEARCH_DELAY_MS, process.env.WEB_SEARCH_DELAY_MS, 450);

  const { inFile, outFile } = parseInOut(process.argv, "advice-context.json", "web-context.json");
  if (!fs.existsSync(inFile)) {
    console.error(`Input not found: ${inFile} (run: npm run advice-context)`);
    process.exit(1);
  }

  const advice = readJsonFile(inFile);
  const players = collectPlayers(advice, maxQueries);
  const entries = [];
  let i = 0;
  for (const { name, role } of players) {
    i += 1;
    const query = `"${name}" MLB injury OR lineup OR starting OR news`;
    process.stderr.write(`[${i}/${players.length}] ${name}… `);
    try {
      const { results } = await tavilySearch(apiKey, query);
      entries.push({
        player: name,
        role,
        query,
        results,
      });
      console.error(`ok (${results.length})`);
    } catch (err) {
      const msg = err.response?.data?.detail || err.response?.data?.error || err.message || String(err);
      entries.push({
        player: name,
        role,
        query,
        error: msg,
        results: [],
      });
      console.error(`err: ${msg}`);
    }
    if (i < players.length && delayMs > 0) await sleep(delayMs);
  }

  const payload = {
    meta: {
      source: "tavily",
      web_context_version: 1,
      generated_at: new Date().toISOString(),
      player_count: players.length,
      disclaimer: "Snippets are from web search; verify before roster decisions. Not league official stats.",
    },
    entries,
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
