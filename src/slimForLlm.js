/**
 * Shrink advice + web JSON before sending to the LLM (OpenRouter 128k, etc.).
 * Full files on disk are unchanged.
 */

const DEFAULTS = {
  MAX_STAT_LABELS: 24,
  MAX_FREE_AGENTS: 14,
  MAX_LEAGUE_TEAM_PLAYERS: 18,
  MAX_WEEK_STATS_LABELS: 22,
  MAX_WEB_PLAYER_ENTRIES: 18,
  MAX_WEB_STREAMING: 10,
  MAX_WEB_WEATHER: 8,
  MAX_WEB_RESULTS_PER_QUERY: 3,
  MAX_SNIPPET_CHARS: 260,
  MAX_STREAMING_DROP_CANDIDATES: 12,
  MAX_MLB_GAMES: 52,
};

function truncate(s, max) {
  if (s == null || typeof s !== "string") return s;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function trimByLabel(byLabel, maxKeys) {
  if (!byLabel || typeof byLabel !== "object") return null;
  const e = Object.entries(byLabel);
  if (e.length <= maxKeys) return byLabel;
  return Object.fromEntries(e.slice(0, maxKeys));
}

function slimMatchupThisWeek(m, maxLabels) {
  if (!m) return null;
  return {
    week: m.week,
    week_start: m.week_start,
    week_end: m.week_end,
    status: m.status,
    is_playoffs: m.is_playoffs,
    stat_category_winners: Array.isArray(m.stat_category_winners) ? m.stat_category_winners.slice(0, 40) : m.stat_category_winners,
    teams: (m.teams || []).map((t) => ({
      team_key: t.team_key,
      team_id: t.team_id,
      name: t.name,
      week_stats_by_label: trimByLabel(t.week_stats_by_label, maxLabels),
    })),
  };
}

function slimRosterForLlm(r, maxLabels) {
  if (!r) return null;
  const stats = r.season_stats;
  return {
    player_key: r.player_key,
    name: r.name,
    team_abbr: r.team_abbr,
    team_name: r.team_name,
    position_type: r.position_type,
    display_position: r.display_position,
    selected_position: r.selected_position,
    is_starting: r.is_starting,
    lineup_date: r.lineup_date,
    percent_owned: r.percent_owned,
    season_stats: stats?.by_label ? { by_label: trimByLabel(stats.by_label, maxLabels) } : null,
  };
}

function slimPitcherPoolEntry(p, maxLabels) {
  if (!p) return null;
  const row = {
    player_key: p.player_key,
    name: p.name,
    team_abbr: p.team_abbr,
    team_name: p.team_name,
    display_position: p.display_position,
    percent_owned: p.percent_owned,
    season_stats_by_label: trimByLabel(p.season_stats_by_label, maxLabels),
  };
  if (p.selected_position != null) row.selected_position = p.selected_position;
  if (p.is_starting != null) row.is_starting = p.is_starting;
  return row;
}

function mergeSlimOptions(cfg) {
  const c = cfg || {};
  const fromEnv = (key, def) => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return def;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const num = (v, def) => {
    const n = typeof v === "string" ? parseInt(v, 10) : v;
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    MAX_STAT_LABELS: num(c.LLM_MAX_STAT_LABELS, fromEnv("LLM_MAX_STAT_LABELS", DEFAULTS.MAX_STAT_LABELS)),
    MAX_FREE_AGENTS: num(c.LLM_MAX_FREE_AGENTS, fromEnv("LLM_MAX_FREE_AGENTS", DEFAULTS.MAX_FREE_AGENTS)),
    MAX_LEAGUE_TEAM_PLAYERS: num(c.LLM_MAX_LEAGUE_TEAM_PLAYERS, fromEnv("LLM_MAX_LEAGUE_TEAM_PLAYERS", DEFAULTS.MAX_LEAGUE_TEAM_PLAYERS)),
    MAX_WEEK_STATS_LABELS: num(c.LLM_MAX_WEEK_STATS_LABELS, fromEnv("LLM_MAX_WEEK_STATS_LABELS", DEFAULTS.MAX_WEEK_STATS_LABELS)),
    MAX_WEB_PLAYER_ENTRIES: num(c.LLM_MAX_WEB_PLAYER_ENTRIES, fromEnv("LLM_MAX_WEB_PLAYER_ENTRIES", DEFAULTS.MAX_WEB_PLAYER_ENTRIES)),
    MAX_WEB_STREAMING: num(c.LLM_MAX_WEB_STREAMING, fromEnv("LLM_MAX_WEB_STREAMING", DEFAULTS.MAX_WEB_STREAMING)),
    MAX_WEB_WEATHER: num(c.LLM_MAX_WEB_WEATHER, fromEnv("LLM_MAX_WEB_WEATHER", DEFAULTS.MAX_WEB_WEATHER)),
    MAX_WEB_RESULTS_PER_QUERY: num(c.LLM_MAX_WEB_RESULTS_PER_QUERY, fromEnv("LLM_MAX_WEB_RESULTS_PER_QUERY", DEFAULTS.MAX_WEB_RESULTS_PER_QUERY)),
    MAX_SNIPPET_CHARS: num(c.LLM_MAX_SNIPPET_CHARS, fromEnv("LLM_MAX_SNIPPET_CHARS", DEFAULTS.MAX_SNIPPET_CHARS)),
    MAX_STREAMING_DROP_CANDIDATES: num(
      c.LLM_MAX_STREAMING_DROP_CANDIDATES,
      fromEnv("LLM_MAX_STREAMING_DROP_CANDIDATES", DEFAULTS.MAX_STREAMING_DROP_CANDIDATES),
    ),
    MAX_MLB_GAMES: num(c.LLM_MAX_MLB_GAMES, fromEnv("LLM_MAX_MLB_GAMES", DEFAULTS.MAX_MLB_GAMES)),
  };
}

function slimAdviceForLlm(advice, cfg) {
  const o = mergeSlimOptions(cfg);
  const slimWeek = (x) => slimMatchupThisWeek(x, o.MAX_WEEK_STATS_LABELS);

  return {
    meta: {
      ...(advice.meta || {}),
      llm_slim: true,
      llm_slim_note: "Trimmed for LLM context. Use on-disk advice-context.json for the full export.",
    },
    scoring: {
      stat_definitions: (advice.scoring?.stat_definitions || []).map((d) => ({
        stat_id: d.stat_id,
        display_name: d.display_name,
      })),
    },
    my_roster: (advice.my_roster || []).map((r) => slimRosterForLlm(r, o.MAX_STAT_LABELS)).filter(Boolean),
    free_agents: (advice.free_agents || []).slice(0, o.MAX_FREE_AGENTS).map((fa) => ({
      player_key: fa.player_key,
      name: fa.name,
      team_abbr: fa.team_abbr,
      team_name: fa.team_name,
      display_position: fa.display_position,
      percent_owned: fa.percent_owned,
    })),
    streaming_pitcher_pool: {
      from_my_roster: (advice.streaming_pitcher_pool?.from_my_roster || [])
        .map((p) => slimPitcherPoolEntry(p, o.MAX_STAT_LABELS))
        .filter(Boolean),
      from_waiver_wire: (advice.streaming_pitcher_pool?.from_waiver_wire || [])
        .map((p) => slimPitcherPoolEntry(p, o.MAX_STAT_LABELS))
        .filter(Boolean),
    },
    streaming_options: advice.streaming_options
      ? {
          intent: advice.streaming_options.intent,
          today_eastern_ymd: advice.streaming_options.today_eastern_ymd,
          today_eastern_display: advice.streaming_options.today_eastern_display,
          fantasy_week: advice.streaming_options.fantasy_week,
          drop_candidates_for_stream: (advice.streaming_options.drop_candidates_for_stream || [])
            .slice(0, o.MAX_STREAMING_DROP_CANDIDATES)
            .map((p) => slimPitcherPoolEntry(p, o.MAX_STAT_LABELS))
            .filter(Boolean),
        }
      : null,
    league_teams: (advice.league_teams || []).map((tm) => ({
      team_key: tm.team_key,
      name: tm.name,
      is_my_team: tm.is_my_team,
      players: (tm.players || []).slice(0, o.MAX_LEAGUE_TEAM_PLAYERS).map((p) => ({
        player_key: p.player_key,
        name: p.name,
        display_position: p.display_position,
        percent_owned: p.percent_owned,
      })),
    })),
    matchup_this_week: slimWeek(advice.matchup_this_week),
  };
}

function slimWebForLlm(web, cfg) {
  const o = mergeSlimOptions(cfg);
  const slimResults = (results) =>
    (results || []).slice(0, o.MAX_WEB_RESULTS_PER_QUERY).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncate(r.snippet, o.MAX_SNIPPET_CHARS),
    }));

  const mapEntry = (e, keys) => {
    const row = {};
    for (const k of keys) {
      if (e[k] !== undefined) row[k] = e[k];
    }
    row.results = slimResults(e.results);
    if (e.error) row.error = e.error;
    return row;
  };

  return {
    meta: {
      ...(web.meta || {}),
      llm_slim: true,
      llm_slim_note: "Trimmed for LLM context. Full web-context.json on disk.",
    },
    entries: (web.entries || []).slice(0, o.MAX_WEB_PLAYER_ENTRIES).map((e) => mapEntry(e, ["name", "player", "role"])),
    streaming_matchup_entries: (web.streaming_matchup_entries || []).slice(0, o.MAX_WEB_STREAMING).map((e) =>
      mapEntry(e, ["name", "role"]),
    ),
    team_weather_entries: (web.team_weather_entries || []).slice(0, o.MAX_WEB_WEATHER).map((e) => mapEntry(e, ["label"])),
    mlb_schedule: web.mlb_schedule
      ? {
          source: web.mlb_schedule.source,
          start_date: web.mlb_schedule.start_date,
          end_date: web.mlb_schedule.end_date,
          relevant_team_abbr: (web.mlb_schedule.relevant_team_abbr || []).slice(0, 36),
          game_count_returned: web.mlb_schedule.game_count_returned,
          games: (web.mlb_schedule.games || []).slice(0, o.MAX_MLB_GAMES),
          ...(web.mlb_schedule.error ? { error: truncate(String(web.mlb_schedule.error), 220) } : {}),
        }
      : null,
  };
}

module.exports = {
  slimAdviceForLlm,
  slimWebForLlm,
  mergeSlimOptions,
  DEFAULTS,
};
