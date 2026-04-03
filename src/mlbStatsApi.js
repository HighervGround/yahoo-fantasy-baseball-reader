/**
 * Public MLB Stats API (statsapi.mlb.com) — schedule + probables.
 * No API key. Respect MLB copyright / terms for your use case.
 */

const axios = require("axios");

/** Yahoo Fantasy abbreviations that differ from MLB Stats API `team.abbreviation`. */
const YAHOO_TO_MLB_ABBR = {
  AZ: "ARI",
};

function yahooAbbrToMlb(abbr) {
  const u = String(abbr || "")
    .trim()
    .toUpperCase();
  return YAHOO_TO_MLB_ABBR[u] || u;
}

function parseLeadingYmd(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function addDaysToYmd(ymd, days) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function computeScheduleWindow(easternYmd, matchup) {
  const weekEnd = parseLeadingYmd(matchup?.week_end);
  let end = addDaysToYmd(easternYmd, 6);
  if (weekEnd && weekEnd >= easternYmd && weekEnd > end) end = weekEnd;
  const cap = addDaysToYmd(easternYmd, 13);
  if (end > cap) end = cap;
  return { startDate: easternYmd, endDate: end };
}

function sideFromSchedule(side) {
  const t = side?.team;
  const p = side?.probablePitcher;
  return {
    abbr: t?.abbreviation || "",
    name: t?.name || "",
    probable_pitcher_id: p?.id ?? null,
    probable_pitcher: p?.fullName || null,
  };
}

function normalizeGame(g, calendarDate) {
  const away = sideFromSchedule(g?.teams?.away);
  const home = sideFromSchedule(g?.teams?.home);
  const st = g?.status || {};
  return {
    official_date: g?.officialDate || calendarDate,
    game_pk: g?.gamePk,
    game_datetime_utc: g?.gameDate || null,
    game_type: g?.gameType || null,
    status: st.detailedState || st.abstractGameState || null,
    venue: g?.venue?.name || null,
    away,
    home,
  };
}

function flattenSchedule(apiBody) {
  const out = [];
  for (const day of apiBody?.dates || []) {
    const d = day?.date;
    for (const g of day?.games || []) {
      out.push(normalizeGame(g, d));
    }
  }
  return out;
}

function collectRelevantMlbAbbrevs(advice) {
  const set = new Set();
  const addFromPlayer = (p) => {
    const a = yahooAbbrToMlb(p?.team_abbr);
    if (a) set.add(a);
  };
  for (const p of advice?.my_roster || []) addFromPlayer(p);
  for (const p of advice?.free_agents || []) addFromPlayer(p);
  const pool = advice?.streaming_pitcher_pool || {};
  for (const p of pool.from_my_roster || []) addFromPlayer(p);
  for (const p of pool.from_waiver_wire || []) addFromPlayer(p);
  const weatherRoster = advice?.lineup_start_sit || advice?.my_roster || [];
  for (const p of weatherRoster) addFromPlayer(p);
  for (const tm of advice?.league_teams || []) {
    for (const p of tm?.players || []) addFromPlayer(p);
  }
  return set;
}

function gameInvolvesTeam(game, mlbAbbrSet) {
  const a = game?.away?.abbr;
  const h = game?.home?.abbr;
  return (a && mlbAbbrSet.has(a)) || (h && mlbAbbrSet.has(h));
}

async function fetchScheduleRaw(baseUrl, startDate, endDate) {
  const base = String(baseUrl || "https://statsapi.mlb.com").replace(/\/$/, "");
  const hydrate = encodeURIComponent("probablePitcher,team,venue");
  const url = `${base}/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=${hydrate}`;
  const { data } = await axios.get(url, {
    timeout: 25000,
    headers: { Accept: "application/json" },
    validateStatus: (s) => s === 200,
  });
  return data;
}

/**
 * @param {object} advice - advice-context object
 * @param {object} opts - { easternYmd, matchup, baseUrl }
 */
async function fetchMlbScheduleForAdvice(advice, opts) {
  const easternYmd = opts.easternYmd;
  const matchup = opts.matchup ?? advice?.matchup_this_week;
  const baseUrl = opts.baseUrl;
  const { startDate, endDate } = computeScheduleWindow(easternYmd, matchup);
  const raw = await fetchScheduleRaw(baseUrl, startDate, endDate);
  const allGames = flattenSchedule(raw);
  const teams = collectRelevantMlbAbbrevs(advice);
  const games = teams.size === 0 ? [] : allGames.filter((g) => gameInvolvesTeam(g, teams));

  games.sort((x, y) => {
    const da = `${x.official_date || ""}-${x.game_pk || 0}`;
    const db = `${y.official_date || ""}-${y.game_pk || 0}`;
    return da.localeCompare(db);
  });

  return {
    source: "mlb_stats_api",
    copyright: raw?.copyright || null,
    start_date: startDate,
    end_date: endDate,
    relevant_team_abbr: [...teams].sort(),
    game_count_returned: games.length,
    games,
  };
}

module.exports = {
  yahooAbbrToMlb,
  computeScheduleWindow,
  collectRelevantMlbAbbrevs,
  fetchMlbScheduleForAdvice,
  fetchScheduleRaw,
  flattenSchedule,
};
