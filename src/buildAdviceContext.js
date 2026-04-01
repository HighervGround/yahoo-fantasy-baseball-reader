const fs = require("fs");
const { loadRootConfig, teamKeyFromConfig, parseInOut, readJsonFile } = require("./pipelineUtil");

function num(cfgVal, envVal, fallback) {
  const n = envVal !== undefined && envVal !== "" ? Number(envVal) : Number(cfgVal);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function slimRosterRow(p) {
  if (!p) return null;
  const ss = p.season_stats;
  return {
    player_key: p.player_key,
    name: p.name,
    team_abbr: p.team_abbr,
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

function buildAdviceContext(snapshot, cfg) {
  const myTeamKey = teamKeyFromConfig(cfg);
  const faLimit = num(cfg.ADVICE_FA_LIMIT, process.env.ADVICE_FA_LIMIT, 20);
  const matchup = findMyMatchup(snapshot.matchups_this_week, myTeamKey);

  return {
    meta: {
      source: "yahoo-fantasy-baseball-reader",
      advice_context_version: 2,
      generated_at: new Date().toISOString(),
      team_key: myTeamKey,
      llm_note:
        "Yahoo-only: `percent_owned` = league-wide % rostered (trade realism). `draft_analysis` = Yahoo aggregate ADP-style data (average_pick, average_round, etc.) — NOT necessarily this league's actual draft slot. league_teams = all rosters. web_context = injuries/news.",
    },
    scoring: {
      stat_definitions: snapshot.scoring?.stat_definitions ?? [],
    },
    my_roster: (snapshot.my_roster || []).map(slimRosterRow).filter(Boolean),
    free_agents: (snapshot.free_agents || []).slice(0, faLimit).map(slimFaRow).filter(Boolean),
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
