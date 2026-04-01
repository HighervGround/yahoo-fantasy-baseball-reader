const fs = require("fs");
const path = require("path");

function ensureArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function stripXmlNoise(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripXmlNoise);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "?xml") continue;
    if (k.startsWith("@_")) continue;
    out[k] = stripXmlNoise(v);
  }
  return out;
}

function buildStatLabelMaps(statDefinitions) {
  const list = ensureArray(statDefinitions);
  const byId = {};
  for (const def of list) {
    if (def == null || def.stat_id === undefined) continue;
    const id = String(def.stat_id);
    const label = def.display_name || def.name || id;
    const types = ensureArray(def.position_types?.position_type);
    if (!byId[id]) {
      byId[id] = { label, positionTypes: types, sortOrder: def.sort_order };
    }
  }
  return { byId, list };
}

function coerceStatValue(value) {
  if (value === "-" || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return value;
}

function statsRowsToObjects(statRows, idToLabelMap) {
  const byId = {};
  const byLabel = {};
  for (const row of ensureArray(statRows)) {
    if (row == null || row.stat_id === undefined) continue;
    const id = String(row.stat_id);
    const raw = coerceStatValue(row.value);
    byId[id] = raw;
    const meta = idToLabelMap[id];
    let label = meta?.label ?? `stat_${id}`;
    if (Object.prototype.hasOwnProperty.call(byLabel, label)) {
      label = `${label} (${id})`;
    }
    byLabel[label] = raw;
  }
  return { byId, byLabel };
}

function slimPlayerProfile(p, poMap, daMap) {
  if (!p) return null;
  const po = poMap || {};
  const da = daMap || {};
  const pct =
    p.player_key != null && po[p.player_key] !== undefined ? po[p.player_key] : p.percent_owned != null ? p.percent_owned : null;
  const draft =
    p.player_key != null && da[p.player_key] !== undefined ? da[p.player_key] : p.draft_analysis != null ? p.draft_analysis : null;
  return {
    player_key: p.player_key,
    player_id: p.player_id,
    name: p.name?.full ?? `${p.name?.first ?? ""} ${p.name?.last ?? ""}`.trim(),
    team_abbr: p.editorial_team_abbr,
    team_name: p.editorial_team_full_name,
    display_position: p.display_position,
    primary_position: p.primary_position,
    position_type: p.position_type,
    eligible_positions: ensureArray(p.eligible_positions?.position),
    selected_position: p.selected_position?.position ?? null,
    lineup_date: p.selected_position?.date ?? p.starting_status?.date ?? null,
    is_starting: p.starting_status?.is_starting ?? null,
    batting_order: p.batting_order?.order_num ?? null,
    is_undroppable: p.is_undroppable,
    percent_owned: pct != null && Number.isFinite(Number(pct)) ? Number(pct) : null,
    draft_analysis: draft && typeof draft === "object" ? draft : null,
  };
}

function extractMyPlayersStatsPlayers(myPlayersStats) {
  const cleaned = stripXmlNoise(myPlayersStats);
  const players = cleaned?.fantasy_content?.players?.player;
  return ensureArray(players);
}

function normalizeScoring(statIdsBlock) {
  const stats = ensureArray(statIdsBlock?.stat);
  const { byId, list } = buildStatLabelMaps(stats);
  const definitions = list.map((def) => ({
    stat_id: def.stat_id,
    name: def.name,
    display_name: def.display_name || def.name,
    sort_order: def.sort_order,
    position_types: ensureArray(def.position_types?.position_type),
  }));
  return { definitions, labelByStatId: byId };
}

function attachSeasonStats(rosterSlim, statsPlayers, labelByStatId) {
  const byKey = new Map();
  for (const sp of statsPlayers) {
    if (!sp?.player_key) continue;
    const rows = sp.player_stats?.stats?.stat;
    const { byId, byLabel } = statsRowsToObjects(rows, labelByStatId);
    byKey.set(sp.player_key, { season: sp.player_stats?.season ?? null, byId, byLabel });
  }
  return rosterSlim.map((row) => {
    const extra = byKey.get(row.player_key);
    return extra ? { ...row, season_stats: extra } : { ...row, season_stats: null };
  });
}

function normalizeMatchups(scoreboardRows, labelByStatId) {
  return ensureArray(scoreboardRows).map((m) => {
    const winners = ensureArray(m.stat_winners?.stat_winner).map((w) => ({
      stat_id: w.stat_id,
      winner_team_key: w.winner_team_key ?? null,
      is_tied: w.is_tied === 1 || w.is_tied === true,
    }));
    const teams = ensureArray(m.teams?.team).map((t) => {
      const statRows = t.team_stats?.stats?.stat;
      const { byId, byLabel } = statsRowsToObjects(statRows, labelByStatId);
      return {
        team_key: t.team_key,
        team_id: t.team_id,
        name: t.name,
        url: t.url,
        number_of_moves: t.number_of_moves,
        number_of_trades: t.number_of_trades,
        week_stats_by_id: byId,
        week_stats_by_label: byLabel,
      };
    });
    return {
      week: m.week,
      week_start: m.week_start,
      week_end: m.week_end,
      status: m.status,
      is_playoffs: m.is_playoffs,
      stat_category_winners: winners,
      teams,
    };
  });
}

function normalizeTransactions(transactionsBlock) {
  const txs = ensureArray(transactionsBlock?.transaction);
  return txs.map((tx) => {
    const players = ensureArray(tx.players?.player).map((p) => ({
      player_key: p.player_key,
      name: p.name?.full ?? `${p.name?.first ?? ""} ${p.name?.last ?? ""}`.trim(),
      team_abbr: p.editorial_team_abbr,
      display_position: p.display_position,
      position_type: p.position_type,
      transaction: p.transaction_data?.type,
      source_type: p.transaction_data?.source_type,
      destination_type: p.transaction_data?.destination_type,
      source_team_name: p.transaction_data?.source_team_name,
      destination_team_name: p.transaction_data?.destination_team_name,
    }));
    return {
      transaction_key: tx.transaction_key,
      transaction_id: tx.transaction_id,
      type: tx.type,
      status: tx.status,
      timestamp: tx.timestamp,
      players,
    };
  });
}

function normalizeFreeAgentsAndBench(freeAgents, myPlayers, poMap, daMap) {
  return {
    free_agents: ensureArray(freeAgents).map((p) => slimPlayerProfile(p, poMap, daMap)),
    my_players_brief: ensureArray(myPlayers).map((p) => slimPlayerProfile(p, poMap, daMap)),
  };
}

function normalizeLeagueTeams(rawList, poMap, daMap) {
  const po = poMap || {};
  const da = daMap || {};
  return ensureArray(rawList).map((tm) => ({
    team_key: tm.team_key,
    team_id: tm.team_id,
    name: tm.name,
    url: tm.url,
    is_my_team: !!tm.is_my_team,
    players: ensureArray(tm.players).map((p) => {
      const v = p.player_key != null && po[p.player_key] !== undefined ? po[p.player_key] : p.percent_owned;
      const pct = v != null && Number.isFinite(Number(v)) ? Number(v) : null;
      const draft =
        p.player_key != null && da[p.player_key] !== undefined ? da[p.player_key] : p.draft_analysis != null ? p.draft_analysis : null;
      return {
        player_key: p.player_key,
        name: p.name,
        display_position: p.display_position,
        team_abbr: p.team_abbr,
        position_type: p.position_type,
        percent_owned: pct,
        draft_analysis: draft && typeof draft === "object" ? draft : null,
      };
    }),
  }));
}

/**
 * Turn a raw allMyData.json object (from src/index.js) into a stable, AI-friendly snapshot.
 */
function normalizeRawExport(raw) {
  const scoring = normalizeScoring(raw["stat IDs"]);
  const labelByStatId = scoring.labelByStatId;
  const poMap = raw.percent_owned_map && typeof raw.percent_owned_map === "object" ? raw.percent_owned_map : {};
  const daMap = raw.draft_analysis_map && typeof raw.draft_analysis_map === "object" ? raw.draft_analysis_map : {};

  const { free_agents, my_players_brief } = normalizeFreeAgentsAndBench(
    raw["free agents"],
    raw["my players"],
    poMap,
    daMap,
  );

  const statsPlayers = extractMyPlayersStatsPlayers(raw["my players' stats"]);
  const rosterPlayers = ensureArray(raw["current roster"]?.player);
  const rosterSlim = rosterPlayers.map((p) => slimPlayerProfile(p, poMap, daMap));
  const my_roster = attachSeasonStats(rosterSlim, statsPlayers, labelByStatId);

  const matchups = normalizeMatchups(raw["my scoreboard"], labelByStatId);
  const transactions = normalizeTransactions(raw.transactions);
  const league_teams = normalizeLeagueTeams(raw["league teams"], poMap, daMap);

  return {
    meta: {
      source: "yahoo-fantasy-baseball-reader",
      normalized_version: 2,
      generated_at: new Date().toISOString(),
    },
    scoring: {
      stat_definitions: scoring.definitions,
    },
    my_roster,
    free_agents,
    my_players_brief,
    league_teams,
    matchups_this_week: matchups,
    recent_transactions: transactions,
  };
}

function parseArgs(argv) {
  const opts = { inFile: path.join(process.cwd(), "allMyData.json"), outFile: path.join(process.cwd(), "snapshot.normalized.json") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--in" && argv[i + 1]) {
      opts.inFile = path.resolve(argv[++i]);
    } else if (argv[i] === "--out" && argv[i + 1]) {
      opts.outFile = path.resolve(argv[++i]);
    }
  }
  return opts;
}

function main() {
  const { inFile, outFile } = parseArgs(process.argv);
  if (!fs.existsSync(inFile)) {
    console.error(`Input file not found: ${inFile}`);
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inFile, "utf8"));
  } catch (e) {
    console.error(`Failed to parse JSON from ${inFile}: ${e.message}`);
    process.exit(1);
  }
  const normalized = normalizeRawExport(raw);
  fs.writeFileSync(outFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  console.error(`Wrote ${outFile}`);
}

if (require.main === module) {
  main();
}

exports.normalizeRawExport = normalizeRawExport;
exports.ensureArray = ensureArray;
