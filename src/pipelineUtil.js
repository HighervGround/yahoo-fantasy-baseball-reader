const fs = require("fs");
const path = require("path");

function loadRootConfig() {
  const p = path.join(process.cwd(), "config.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function teamKeyFromConfig(cfg) {
  if (!cfg.LEAGUE_KEY || cfg.TEAM === undefined || cfg.TEAM === null || cfg.TEAM === "") return null;
  return `${cfg.LEAGUE_KEY}.t.${cfg.TEAM}`;
}

function parseInOut(argv, defaultIn, defaultOut) {
  const opts = {
    inFile: path.join(process.cwd(), defaultIn),
    outFile: path.join(process.cwd(), defaultOut),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--in" && argv[i + 1]) opts.inFile = path.resolve(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) opts.outFile = path.resolve(argv[++i]);
  }
  return opts;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getTavilyApiKey(cfg) {
  return process.env.TAVILY_API_KEY || process.env.TAVILY_KEY || (cfg && cfg.TAVILY_API_KEY) || "";
}

function getOpenAiApiKey(cfg) {
  return process.env.OPENAI_API_KEY || (cfg && cfg.OPENAI_API_KEY) || "";
}

/**
 * Prefer OpenRouter if OPENROUTER_API_KEY is set (env or config); else direct OpenAI.
 * OpenRouter: https://openrouter.ai/docs/api/reference/authentication
 */
function resolveLlm(cfg) {
  const c = cfg || {};
  const orKey = process.env.OPENROUTER_API_KEY || c.OPENROUTER_API_KEY;
  if (orKey) {
    const base = (process.env.OPENROUTER_BASE_URL || c.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    return {
      provider: "openrouter",
      apiKey: orKey,
      url: `${base}/chat/completions`,
      model: process.env.OPENROUTER_MODEL || c.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      extraHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || c.OPENROUTER_HTTP_REFERER || "http://localhost",
        "X-OpenRouter-Title": process.env.OPENROUTER_APP_TITLE || c.OPENROUTER_APP_TITLE || "yahoo-fantasy-baseball-reader",
      },
    };
  }
  const oaKey = process.env.OPENAI_API_KEY || c.OPENAI_API_KEY;
  if (oaKey) {
    const base = (process.env.OPENAI_BASE_URL || c.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    return {
      provider: "openai",
      apiKey: oaKey,
      url: `${base}/chat/completions`,
      model: process.env.OPENAI_MODEL || c.OPENAI_MODEL || "gpt-4o-mini",
      extraHeaders: {},
    };
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  loadRootConfig,
  teamKeyFromConfig,
  parseInOut,
  readJsonFile,
  getTavilyApiKey,
  getOpenAiApiKey,
  resolveLlm,
  sleep,
};
