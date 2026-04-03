const fs = require("fs");
const { loadRootConfig, teamKeyFromConfig, parseInOut, readJsonFile } = require("./pipelineUtil");

function num(cfgVal, envVal, fallback) {
  const n = envVal !== undefined && envVal !== "" ? Number(envVal) : Number(cfgVal);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isPitcherRow(p) {
  if (!p) return false;
  if (p.position_type === "P") return true;
  const pos = String(p.display_position || "").toUpperCase();
  return /\b(SP|RP)\b/.test(pos) || pos === "P" || pos.includes("SP,") || pos.includes(",SP");
}

function slimRosterRow(p) {
  if (!p) return null;
  const ss = p.season_stats;
  return {
    player_key: p.player_key,
    name: p.name,
    team_abbr: p.team_abbr,
    team_name: p.team_name || null,
    position_type: p.position_type || null,
    display_position: p.display_position,
    selected_position: p.selected_position,
    is_starting: p.is_starting,
    lineup_date: p.lineup_date,
    percent_owned: p.percent_owned != null ? p.percent_owned : null,
    draft_analysis: p.draft_analysis && typeof p.draft_analysis === "object" ? p.draft_analysis : null,
    season_stats: ss
      ? {
          season: ss.season,
          by_label: ss.byLabel,
        }
      : null,
  };
}

function slimFaRow(p) {
  if (!p) return null;
  return {
    player_key: p.player_key,
    name: p.name,
    team_abbr: p.team_abbr,
    team_name: p.team_name || null,
    position_type: p.position_type || null,
    display_position: p.display_position,
    is_starting: p.is_starting,
    percent_owned: p.percent_owned != null ? p.percent_owned : null,
    draft_analysis: p.draft_analysis && typeof p.draft_analysis === "object" ? p.draft_analysis : null,
  };
}

function findMyMatchup(matchups, myTeamKey) {
  if (!myTeamKey) return null;
  for (const m of matchups || []) {
    const teams = m.teams || [];
    if (teams.some((t) => t.team_key === myTeamKey)) {
      return m;
    }
  }
  return null;
}

function slimPitcherForStreaming(p) {
  if (!p || !isPitcherRow(p)) return null;
  const ss = p.season_stats;
  return {
    player_key: p.player_key,
    name: p.name,
    team_abbr: p.team_abbr,
    team_name: p.team_name || null,
    display_position: p.display_position,
    percent_owned: p.percent_owned != null ? p.percent_owned : null,
    season_stats_by_label: ss?.byLabel ?? null,
  };
}

function buildAdviceContext(snapshot, cfg) {
  const myTeamKey = teamKeyFromConfig(cfg);
  const faLimit = num(cfg.ADVICE_FA_LIMIT, process.env.ADVICE_FA_LIMIT, 20);
  const streamFaLimit = num(cfg.ADVICE_STREAMING_FA_CAP, process.env.ADVICE_STREAMING_FA_CAP, 35);
  const matchup = findMyMatchup(snapshot.matchups_this_week, myTeamKey);

  const faSlice = (snapshot.free_agents || []).slice(0, Math.max(faLimit, streamFaLimit));
  const streaming_from_waiver = faSlice.map(slimPitcherForStreaming).filter(Boolean);
  const streaming_from_roster = (snapshot.my_roster || []).map(slimPitcherForStreaming).filter(Boolean);

  const lineup_start_sit = (snapshot.my_roster || []).map(slimRosterRow).filter(Boolean);

  return {
    meta: {
      source: "yahoo-fantasy-baseball-reader",
      advice_context_version: 3,
      generated_at: new Date().toISOString(),
      team_key: myTeamKey,
      llm_note:
        "Yahoo-only: roster slots in `lineup_start_sit`. `streaming_pitcher_pool` = SP/RP on you + extra FA arms for streamer research. `percent_owned` / `draft_analysis` as before. Matchup/weather/probable starters for games come from web_context (Tavily), not Yahoo.",
    },
    scoring: {
      stat_definitions: snapshot.scoring?.stat_definitions ?? [],
    },
    my_roster: (snapshot.my_roster || []).map(slimRosterRow).filter(Boolean),
    free_agents: (snapshot.free_agents || []).slice(0, faLimit).map(slimFaRow).filter(Boolean),
    lineup_start_sit,
    streaming_pitcher_pool: {
      from_my_roster: streaming_from_roster,
      from_waiver_wire: streaming_from_waiver,
    },
    league_teams: snapshot.league_teams || [],
    matchup_this_week: matchup,
  };
}

function main() {
  const cfg = loadRootConfig();
  const { inFile, outFile } = parseInOut(process.argv, "snapshot.normalized.json", "advice-context.json");
  if (!fs.existsSync(inFile)) {
    console.error(`Input not found: ${inFile} (run: npm run normalize)`);
    process.exit(1);
  }
  const snapshot = readJsonFile(inFile);
  const ctx = buildAdviceContext(snapshot, cfg);
  fs.writeFileSync(outFile, `${JSON.stringify(ctx, null, 2)}\n`, "utf8");
  console.error(
    `Wrote ${outFile} (${ctx.my_roster.length} roster, ${ctx.free_agents.length} FA, ${(ctx.league_teams || []).length} league teams)`,
  );
}

if (require.main === module) {
  main();
}

exports.buildAdviceContext = buildAdviceContext;
