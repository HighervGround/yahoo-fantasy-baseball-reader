/**
 * Local dashboard: advice markdown + web context (news, streaming, weather, MLB).
 * No auth — bind localhost only. Run after: npm run advise / npm run web-context
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");

const ROOT = process.cwd();
const PORT = Number(process.env.UI_PORT || process.env.PORT || 3847);
const HOST = process.env.UI_HOST || "127.0.0.1";
const PUBLIC = path.join(__dirname, "..", "public");

function readUtf8(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function jsonParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Trim web-context for the browser (full file can be huge). */
function webPayloadForApi(web) {
  if (!web) return null;
  const mlb = web.mlb_schedule;
  return {
    meta: web.meta || {},
    entries: web.entries || [],
    streaming_matchup_entries: web.streaming_matchup_entries || [],
    team_weather_entries: web.team_weather_entries || [],
    mlb_schedule: mlb
      ? {
          source: mlb.source,
          copyright: mlb.copyright,
          start_date: mlb.start_date,
          end_date: mlb.end_date,
          relevant_team_abbr: mlb.relevant_team_abbr,
          game_count_returned: mlb.game_count_returned,
          error: mlb.error,
          games: (mlb.games || []).slice(0, 56),
        }
      : null,
  };
}

function buildApiData() {
  const advicePath = path.join(ROOT, "advice.md");
  const webPath = path.join(ROOT, "web-context.json");
  const adviceCtxPath = path.join(ROOT, "advice-context.json");

  const adviceMd = readUtf8(advicePath);
  const web = jsonParse(readUtf8(webPath));
  const adviceCtx = jsonParse(readUtf8(adviceCtxPath));

  let adviceHtml = "";
  if (adviceMd) {
    try {
      adviceHtml = marked.parse(adviceMd, { async: false });
    } catch (e) {
      adviceHtml = `<p class="err">Markdown render error: ${String(e.message || e)}</p>`;
    }
  }

  return {
    ok: true,
    adviceMarkdown: adviceMd || "",
    adviceHtml,
    webContext: webPayloadForApi(web),
    adviceContextSummary: adviceCtx
      ? {
          meta: adviceCtx.meta,
          scoring_stat_count: (adviceCtx.scoring?.stat_definitions || []).length,
          roster_count: (adviceCtx.my_roster || []).length,
          fa_count: (adviceCtx.free_agents || []).length,
        }
      : null,
    files: {
      advice_md: !!adviceMd,
      web_context: !!web,
      advice_context: !!adviceCtx,
    },
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".ico": "image/x-icon",
};

function servePublic(urlPath, res) {
  const name = urlPath.replace(/^\/+/, "") || "index.html";
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const fp = path.join(PUBLIC, name);
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(name);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "GET" && urlPath === "/api/data") {
    const body = JSON.stringify(buildApiData());
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && (urlPath === "/" || urlPath === "/index.html")) {
    const indexPath = path.join(PUBLIC, "index.html");
    if (!fs.existsSync(indexPath)) {
      res.writeHead(500);
      res.end("Missing public/index.html");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(indexPath).pipe(res);
    return;
  }

  if (req.method === "GET" && (urlPath.endsWith(".css") || urlPath.endsWith(".js"))) {
    servePublic(urlPath, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.error(`Fantasy dashboard: http://${HOST}:${PORT}/`);
  console.error("Open after: npm run advice-context && npm run web-context && npm run advise");
});
