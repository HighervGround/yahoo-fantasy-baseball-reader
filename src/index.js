const fs = require("fs");
const yahoo = require("./yahooFantasyBaseball");
const CONFIG = require("../config.json");

function fetchLeagueRosters() {
  const v = CONFIG.FETCH_LEAGUE_ROSTERS;
  if (v === false || v === "0" || v === 0) return false;
  return true;
}

function fetchPercentOwned() {
  const v = CONFIG.FETCH_PERCENT_OWNED;
  if (v === false || v === "0" || v === 0) return false;
  return true;
}

function collectPlayerKeysForOwnership(freeAgents, myPlayers, leagueTeams) {
  const s = new Set();
  for (const p of freeAgents || []) {
    if (p && p.player_key) s.add(p.player_key);
  }
  for (const p of myPlayers || []) {
    if (p && p.player_key) s.add(p.player_key);
  }
  for (const tm of leagueTeams || []) {
    for (const p of tm.players || []) {
      if (p && p.player_key) s.add(p.player_key);
    }
  }
  return [...s];
}

const getData = async () => {
  try {
    // Read credentials file or get new authorization token
    await yahoo.yfbb.readCredentials();

    // If crededentials exist
    if (yahoo.yfbb.CREDENTIALS) {
      yahoo.yfbb.WEEK = await yahoo.yfbb.getCurrentWeek();
      console.log(`Getting current week...`);

      const freeAgents = await yahoo.yfbb.getFreeAgents();
      console.log(`Getting free agents...`);

      const myPlayers = await yahoo.yfbb.getMyPlayers();
      console.log(`Getting a list of my players...`);

      const myPlayersStats = await yahoo.yfbb.getMyPlayersStats();
      console.log(`Getting my players' stats...`);

      const myScoreboard = await yahoo.yfbb.getMyScoreboard();
      console.log(`Getting the scoreboard...`);

      const statsIDs = await yahoo.yfbb.getStatsIDs();
      console.log(`Getting the ID mapping of the stats...`);

      const currentRoster = await yahoo.yfbb.getCurrentRoster();
      console.log(`Getting my current roster...`);

      const transactions = await yahoo.yfbb.getTransactions();
      console.log(`Getting a list of transactions...`);

      let leagueTeams = [];
      if (fetchLeagueRosters()) {
        console.log(`Getting league rosters (all teams, for trades)...`);
        leagueTeams = await yahoo.yfbb.getLeagueTeamsWithRosters();
      }

      let percentOwnedMap = {};
      let draftAnalysisMap = {};
      if (fetchPercentOwned()) {
        const keys = collectPlayerKeysForOwnership(freeAgents, myPlayers, leagueTeams);
        console.log(`Getting percent_owned + draft_analysis for ${keys.length} players...`);
        const extras = await yahoo.yfbb.getPlayersMarketExtras(keys);
        percentOwnedMap = extras.percent_owned_map || {};
        draftAnalysisMap = extras.draft_analysis_map || {};
      }

      const allData = {
        "free agents": freeAgents,
        "my players": myPlayers,
        "my players' stats": myPlayersStats,
        "my scoreboard": myScoreboard,
        "stat IDs": statsIDs,
        "current roster": currentRoster,
        transactions,
        "league teams": leagueTeams,
        percent_owned_map: percentOwnedMap,
        draft_analysis_map: draftAnalysisMap,
      };

      const data = JSON.stringify(allData);

      const outputFile = "./allMyData.json";

      // Writing to file
      fs.writeFile(outputFile, data, { flag: "w" }, (err) => {
        if (err) {
          console.error(`Error in writing to ${outputFile}: ${err}`);
        } else {
          console.error(`Data successfully written to ${outputFile}.`);
        }
      });
    }
  } catch (err) {
    console.error(`Error in getData(): ${err}`);
  }
};

getData();
