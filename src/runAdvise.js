const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const axios = require("axios");
const { loadRootConfig, resolveLlm } = require("./pipelineUtil");

function parseArgs(argv) {
  const opts = {
    refresh: argv.includes("--refresh"),
    adviceFile: path.join(process.cwd(), "advice-context.json"),
    webFile: path.join(process.cwd(), "web-context.json"),
    outFile: path.join(process.cwd(), "advice.md"),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) opts.outFile = path.resolve(argv[++i]);
    else if (argv[i] === "--advice" && argv[i + 1]) opts.adviceFile = path.resolve(argv[++i]);
    else if (argv[i] === "--web" && argv[i + 1]) opts.webFile = path.resolve(argv[++i]);
  }
  return opts;
}

function runFullRefresh() {
  console.error("Refreshing Yahoo data, normalizing, building context, and fetching web snippets…\n");
  execSync("npm start && npm run advice-pipeline", {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
}

const SYSTEM_PROMPT = `You are a Yahoo Fantasy Baseball assistant.

Rules:
1. All roster stats, scoring categories, free agent lists, head-to-head numbers, and **every player/team name in ADD / DROP / TRADE** MUST come only from the first JSON block (advice-context). Do not invent players or teams.
2. **Waiver adds need a roster spot.** For every suggested add from \`free_agents\`, you must name exactly one **drop** from \`my_roster\` to release (same transaction in Yahoo). Do not recommend a bare add with no cut unless the JSON clearly shows an unfilled roster slot you can point to; if unsure, always pair add+drop.
3. **DROP** (stand-alone): only players listed under \`my_roster\`. Do not repeat the same drop you already paired with a waiver add unless you explain a second, separate move.
4. For **TRADE**: 
   - Trades may be **any shape**: 1-for-1, 2-for-1, 3-for-2, etc. List **every** player on each side. Prefer a multi-player package when it better balances categories or roster construction.
   - Players you **give** must appear on **your** roster (\`my_roster\` or the team where \`is_my_team\` is true inside \`league_teams\`).
   - Players you **receive** must appear on **that opponent's** roster in \`league_teams\` (same \`name\` / \`team_key\` object — do not assign a player to the wrong team).
   - If \`league_teams\` is missing or empty, you must **not** fabricate trades; say league rosters were not available and stick to add/drop only.
   - **Unequal player counts — roster math:** Let G = number of players you give, R = number you receive. Net filled slots change by **(R − G)**. Examples: **3-for-1** (G=3, R=1) → net **−2** → after the trade you have **two extra empty roster spots**; you do **not** need extra drops to complete that trade, but you *may* use those spots for waiver adds (each add still needs its own spot—you already freed them). **1-for-3** (G=1, R=3) → net **+2** → you must either **already have 2 open roster spots** or **name two specific additional players from \`my_roster\`** (not part of "You give") you would drop **before or as part of executing** the deal so the roster stays legal. Always spell this out in plain language for the user.
   - **Trade partner diversity:** Find this week's H2H opponent using \`meta.team_key\` and \`matchup_this_week.teams\` (the team in that matchup whose \`team_key\` is not yours). When you output **two** trade ideas, **at most one** may use that H2H opponent as **Trade partner**; the other **must** name a **different** fantasy team from \`league_teams\`. (One trade idea only: any valid partner is fine.) Do not default both trades to the weekly opponent out of habit.
   - **Trade realism — \`percent_owned\`:** Many players include \`percent_owned\` (Yahoo's league-wide **% rostered** in fantasy; tracks how managers value a player—similar idea to high **% Start** in the app). For **1-for-1** trades, **do not** suggest you give a low-\`percent_owned\` player and get a much higher one (e.g. single-digit vs ~90+) as a "fair" deal—no reasonable manager accepts that straight up. Either **add more value on your side** (extra players/picks narrative—still only names from JSON), or label the idea **Unlikely as a 1-for-1 — needs a sweetener / bigger package**, or pick a different target closer in \`percent_owned\`. Always show \`percent_owned\` in the write-up when the JSON has it. If missing, say the field was unavailable.
5. Injuries, lineups, and breaking news MUST come only from the second JSON block (web-context). Cite the source URL when you use web info.
6. If data is missing, say so clearly.
7. Write in clear Markdown with headings. Be specific: use full player names exactly as in the JSON.
8. Remind the reader that final moves must be made in the Yahoo Fantasy app.`;

function buildUserPrompt(adviceJson, webJson) {
  return `Below are two JSON documents from a local tool (already fetched).

---

### FILE 1: advice-context.json (Yahoo — stats, rosters, league_teams for trades)

\`\`\`json
${adviceJson}
\`\`\`

---

### FILE 2: web-context.json (web search snippets — news/lineups/injuries only; cite URLs)

\`\`\`json
${webJson}
\`\`\`

---

Please produce these sections (use \`###\` headings in this order):

### Waiver wire (add **and** drop — Yahoo needs a roster spot)
- Roster size is capped: **every** suggested add must include **who you cut** on the same move.
- Up to **3** options, labeled **Option A / B / C** (these are **alternatives** for one waiver run unless the user is making multiple adds in real life).
- For **each** option use this template:
  - **Add:** [full name from \`free_agents\` only]
  - **Drop:** [full name from \`my_roster\` only] — one line why this is the logical player to release
  - Then bullets: why the add helps (cite **specific** stat labels from \`my_roster\` / matchup), and any web risk from file 2 with URL.

### Drop (without adding anyone)
- Only for a cut that makes sense **even if** the user does **not** claim a FA this period (e.g. dead roster spot). If none, write **Drop (stand-alone): None**. Do **not** duplicate a player you already named under **Drop:** in the waiver options above.

### Trade
- **Up to 2** concrete proposals. Trades are **not** limited to 1-for-1 — use 2-for-1, **3-for-1**, 3-for-2, etc.; list every player on each side.
- For each proposal, use exactly this template:
  - **Trade partner:** [opponent fantasy team \`name\` from \`league_teams\`]
  - **You give:** [comma-separated names — all from YOUR roster only; can be multiple]
  - **You get:** [comma-separated names — all from THAT team's \`players\` list only; can be multiple]
  - **Roster / drop scenario (required if G ≠ R):** State G and R. Explain net **(R − G)** roster spots: e.g. **3-for-1** → you free **2** spots (no extra drops needed for the swap); **1-for-3** → you need **2** open bench spots **or** name **two** concrete cuts from \`my_roster\` not already in "You give". For equal G=R, write **Roster / drop scenario:** None (slot-neutral).
  - **Percent owned (from JSON):** For every player in "You give" and "You get", append \`(percent_owned: X)\` when file 1 has \`percent_owned\`; if null/missing, write \`(percent_owned: n/a)\`. Use these numbers to sanity-check the offer.
  - **Likelihood:** If a 1-for-1 has a huge gap (e.g. you give ~10% and get ~90% rostered), you **must** call it **unlikely straight-up** and either restructure (more players from your side from the JSON) or choose a fairer target—do not present it as a normal fair trade.
  - **Why:** category / roster fit using stats from file 1 only; optional web note with URL from file 2.
- **Partner rule when you write two trades:** only **one** of them may be with this week's H2H opponent (infer from \`matchup_this_week\` vs \`meta.team_key\`). The **other** must be a different team from \`league_teams\`.
- If \`league_teams\` is empty or unusable: write **Trade: Not available** and explain (do not invent opponent rosters).

### This week (matchup)
- Short read using \`matchup_this_week\` and \`week_stats_by_label\` only for category strength vs opponent.

### News digest
- Bullets for your roster names where file 2 has relevant snippets (name, one line, URL).

End with a one-line disclaimer: not professional advice; confirm moves in the Yahoo app.`;
}

async function callChatCompletions(llm, userContent) {
  const { data } = await axios({
    method: "post",
    url: llm.url,
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      ...llm.extraHeaders,
    },
    data: {
      model: llm.model,
      temperature: 0.35,
      max_tokens: 6144,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    },
    timeout: 120000,
  });
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("LLM returned no message content.");
  }
  return text.trim();
}

async function main() {
  const cfg = loadRootConfig();
  const llm = resolveLlm(cfg);

  if (!llm) {
    console.error(`
No LLM API key found.

OpenRouter (recommended — one key, many models):
  • export OPENROUTER_API_KEY="sk-or-..."
  • optional: export OPENROUTER_MODEL="openai/gpt-4o-mini"   (see models on openrouter.ai)
  • optional: OPENROUTER_HTTP_REFERER, OPENROUTER_APP_TITLE for OpenRouter rankings

Or direct OpenAI:
  • export OPENAI_API_KEY="sk-..."
  • optional: OPENAI_MODEL

You can also set the same keys in config.json (not recommended for secrets in git).

Then run:
  npm run advise              — use existing advice-context.json + web-context.json
  npm run advise -- --refresh — refetch Yahoo + web first, then ask the model
`);
    process.exit(1);
  }

  const opts = parseArgs(process.argv);
  if (opts.refresh) {
    runFullRefresh();
  }

  if (!fs.existsSync(opts.adviceFile)) {
    console.error(`Missing ${opts.adviceFile}. Run: npm run advice-context   or   npm run advise -- --refresh`);
    process.exit(1);
  }
  if (!fs.existsSync(opts.webFile)) {
    console.error(`Missing ${opts.webFile}. Run: npm run web-context   or   npm run advise -- --refresh`);
    process.exit(1);
  }

  const adviceJson = fs.readFileSync(opts.adviceFile, "utf8");
  const webJson = fs.readFileSync(opts.webFile, "utf8");

  console.error(`Asking ${llm.provider} / ${llm.model}… (this may take a minute)\n`);
  const markdown = await callChatCompletions(llm, buildUserPrompt(adviceJson, webJson));

  const header = `<!-- Generated ${new Date().toISOString()} — ${llm.provider}:${llm.model} -->\n\n`;
  fs.writeFileSync(opts.outFile, header + markdown + "\n", "utf8");

  console.error(`Saved: ${opts.outFile}\n`);
  console.log(markdown);
}

if (require.main === module) {
  main().catch((err) => {
    const body = err.response?.data;
    const msg =
      body?.error?.message ||
      (typeof body?.error === "string" ? body.error : null) ||
      err.message ||
      String(err);
    console.error("Error:", msg);
    process.exit(1);
  });
}
