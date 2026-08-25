require("dotenv").config();

const http = require("node:http");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
} = require("discord.js");

const { createClient } = require("@supabase/supabase-js");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const TIME_ZONE = "Asia/Manila";
const PORT = Number(process.env.PORT || 3000);

if (!TOKEN) throw new Error("DISCORD_TOKEN is missing.");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing.");
if (!SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is missing.");
}
if (!CHANNEL_ID) throw new Error("CHANNEL_ID is missing.");

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* Render Web Service health endpoint. */
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        discordReady: client.isReady(),
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("Discord time-clock bot v2 is running.");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Web server listening on port ${PORT}`);
});

function createDefaultRecord(userId) {
  return {
    user_id: userId,
    clocked_in_at: null,
    accumulated_milliseconds: 0,
    sessions: [],
    last_submitted_at: null,
    last_submitted_milliseconds: null,
  };
}

async function getUserRecord(userId) {
  const { data, error } = await supabase
    .from("time_records")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load time record: ${error.message}`);
  }

  if (data) {
    return {
      ...data,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
    };
  }

  const newRecord = createDefaultRecord(userId);
  const { data: createdRecord, error: insertError } = await supabase
    .from("time_records")
    .insert(newRecord)
    .select("*")
    .single();

  if (insertError) {
    // Another click may have created this user at the same time.
    const { data: existingRecord, error: retryError } = await supabase
      .from("time_records")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (retryError) {
      throw new Error(`Could not create time record: ${insertError.message}`);
    }

    return {
      ...existingRecord,
      sessions: Array.isArray(existingRecord.sessions)
        ? existingRecord.sessions
        : [],
    };
  }

  return {
    ...createdRecord,
    sessions: Array.isArray(createdRecord.sessions)
      ? createdRecord.sessions
      : [],
  };
}

async function saveUserRecord(record) {
  const recordToSave = {
    user_id: record.user_id,
    clocked_in_at: record.clocked_in_at,
    accumulated_milliseconds: record.accumulated_milliseconds || 0,
    sessions: Array.isArray(record.sessions) ? record.sessions : [],
    last_submitted_at: record.last_submitted_at || null,
    last_submitted_milliseconds:
      record.last_submitted_milliseconds || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("time_records")
    .upsert(recordToSave, { onConflict: "user_id" });

  if (error) {
    throw new Error(`Could not save time record: ${error.message}`);
  }
}

async function getPanelMessageId() {
  const { data, error } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", "panel_message_id")
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load panel setting: ${error.message}`);
  }

  return data?.setting_value || null;
}

async function savePanelMessageId(messageId) {
  const { error } = await supabase.from("bot_settings").upsert(
    {
      setting_key: "panel_message_id",
      setting_value: messageId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "setting_key" }
  );

  if (error) {
    throw new Error(`Could not save panel setting: ${error.message}`);
  }
}

function formatPhilippineDateTime(timestamp) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: true,
  }).format(new Date(Number(timestamp)));
}

function formatDuration(milliseconds) {
  const safeMilliseconds = Math.max(0, Number(milliseconds) || 0);
  const totalSeconds = Math.floor(safeMilliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    decimalHours: (safeMilliseconds / 3_600_000).toFixed(2),
    readable: `${hours}h ${minutes}m ${seconds}s`,
  };
}

function buildClockInButton() {
  return new ButtonBuilder()
    .setCustomId("time_clock_in")
    .setLabel("Clock In")
    .setEmoji("🟢")
    .setStyle(ButtonStyle.Success);
}

function buildClockOutButton() {
  return new ButtonBuilder()
    .setCustomId("time_clock_out")
    .setLabel("Clock Out")
    .setEmoji("🔴")
    .setStyle(ButtonStyle.Danger);
}

function buildTotalHoursButton() {
  return new ButtonBuilder()
    .setCustomId("time_total_hours")
    .setLabel("Total Hours")
    .setEmoji("🧾")
    .setStyle(ButtonStyle.Primary);
}

/*
 * V2: Every result includes the next useful action. This means employees no
 * longer need to scroll back to the original panel after a log is posted.
 */
function buildNextActionRow(isClockedIn) {
  const row = new ActionRowBuilder();

  if (isClockedIn) {
    row.addComponents(buildClockOutButton());
  } else {
    row.addComponents(buildClockInButton(), buildTotalHoursButton());
  }

  return row;
}

function buildResult(content, isClockedIn) {
  return {
    content,
    components: [buildNextActionRow(isClockedIn)],
  };
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Employee Time Clock · V2")
    .setDescription(
      [
        "Use the buttons below to record your work time.",
        "",
        "🟢 **Clock In** — starts your personal timer",
        "🔴 **Clock Out** — stops your timer and adds the session",
        "🧾 **Total Hours** — posts your total and resets completed hours",
        "",
        "After every action, the newest log includes the button you need next.",
        "**Important:** Clock out before requesting Total Hours.",
        "All displayed times use Philippine Time.",
      ].join("\n")
    )
    .setFooter({ text: "Records are stored in the cloud database." })
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    buildClockInButton(),
    buildClockOutButton(),
    buildTotalHoursButton()
  );

  return {
    embeds: [embed],
    components: [buttons],
  };
}

async function createOrRefreshPanel(channel) {
  const panelMessageId = await getPanelMessageId();

  if (panelMessageId) {
    try {
      const oldPanel = await channel.messages.fetch(panelMessageId);
      await oldPanel.edit(buildPanel());
      console.log("Existing panel refreshed.");
      return;
    } catch (error) {
      console.log("Previous panel was not found. Creating a new one.");
    }
  }

  const panel = await channel.send(buildPanel());
  await savePanelMessageId(panel.id);
  console.log(`New panel created: ${panel.id}`);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Online as ${readyClient.user.tag}`);

  try {
    const channel = await readyClient.channels.fetch(CHANNEL_ID);

    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      throw new Error(`Channel ${CHANNEL_ID} is not a supported text channel.`);
    }

    await createOrRefreshPanel(channel);
    console.log("Time-clock panel v2 is ready.");
  } catch (error) {
    console.error("Could not prepare the time-clock channel:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("time_")) return;

  if (interaction.channelId !== CHANNEL_ID) {
    await interaction.reply({
      content: `The time clock can only be used in <#${CHANNEL_ID}>.`,
      ephemeral: true,
    });
    return;
  }

  // Prevent Discord's three-second timeout while Supabase is loading.
  await interaction.deferReply();

  const userId = interaction.user.id;
  const now = Date.now();

  try {
    const record = await getUserRecord(userId);

    if (interaction.customId === "time_clock_in") {
      if (record.clocked_in_at !== null) {
        await interaction.editReply(
          buildResult(
            `⚠️ ${interaction.user}, you are already clocked in. ` +
              `Your session started at **${formatPhilippineDateTime(
                record.clocked_in_at
              )}**.`,
            true
          )
        );
        return;
      }

      record.clocked_in_at = now;
      await saveUserRecord(record);

      await interaction.editReply(
        buildResult(
          [
            "🟢 **CLOCKED IN**",
            `Employee: ${interaction.user}`,
            `Time: **${formatPhilippineDateTime(now)}**`,
            "",
            "Use the button below when your shift is finished.",
          ].join("\n"),
          true
        )
      );
      return;
    }

    if (interaction.customId === "time_clock_out") {
      if (record.clocked_in_at === null) {
        await interaction.editReply(
          buildResult(
            `⚠️ ${interaction.user}, you are not currently clocked in.`,
            false
          )
        );
        return;
      }

      const startedAt = Number(record.clocked_in_at);
      const sessionMilliseconds = Math.max(0, now - startedAt);

      record.accumulated_milliseconds =
        Number(record.accumulated_milliseconds) + sessionMilliseconds;
      record.sessions.push({
        clockIn: startedAt,
        clockOut: now,
        durationMilliseconds: sessionMilliseconds,
      });
      record.clocked_in_at = null;

      await saveUserRecord(record);

      const session = formatDuration(sessionMilliseconds);
      const runningTotal = formatDuration(record.accumulated_milliseconds);

      await interaction.editReply(
        buildResult(
          [
            "🔴 **CLOCKED OUT**",
            `Employee: ${interaction.user}`,
            `Clock In: **${formatPhilippineDateTime(startedAt)}**`,
            `Clock Out: **${formatPhilippineDateTime(now)}**`,
            `Session: **${session.readable} (${session.decimalHours} hours)**`,
            `Current Total: **${runningTotal.readable} (${runningTotal.decimalHours} hours)**`,
            "",
            "Use **Clock In** below for your next shift.",
          ].join("\n"),
          false
        )
      );
      return;
    }

    if (interaction.customId === "time_total_hours") {
      if (record.clocked_in_at !== null) {
        await interaction.editReply(
          buildResult(
            `⚠️ ${interaction.user}, click **Clock Out** before requesting Total Hours.`,
            true
          )
        );
        return;
      }

      if (Number(record.accumulated_milliseconds) <= 0) {
        await interaction.editReply(
          buildResult(
            `🧾 ${interaction.user}, you currently have **0.00 completed hours**.`,
            false
          )
        );
        return;
      }

      const submittedMilliseconds = Number(record.accumulated_milliseconds);
      const submittedSessions = record.sessions.length;
      const total = formatDuration(submittedMilliseconds);

      record.accumulated_milliseconds = 0;
      record.sessions = [];
      record.last_submitted_at = now;
      record.last_submitted_milliseconds = submittedMilliseconds;

      await saveUserRecord(record);

      await interaction.editReply(
        buildResult(
          [
            "🧾 **TOTAL HOURS SUBMITTED AND RESET**",
            `Employee: ${interaction.user}`,
            `Completed Sessions: **${submittedSessions}**`,
            `Total: **${total.readable}**`,
            `Invoice Hours: **${total.decimalHours} hours**`,
            `Submitted: **${formatPhilippineDateTime(now)}**`,
            "",
            "This employee's completed total is now reset to **0.00 hours**.",
          ].join("\n"),
          false
        )
      );
      return;
    }

    await interaction.editReply({
      content: "❌ Unknown time-clock action.",
    });
  } catch (error) {
    console.error("Time-clock interaction error:", error);

    const errorMessage =
      "❌ The bot could not save the action to the database. Please try again.";

    if (interaction.deferred) {
      await interaction.editReply({ content: errorMessage }).catch(console.error);
    } else {
      await interaction
        .reply({ content: errorMessage, ephemeral: true })
        .catch(console.error);
    }
  }
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down.");
  client.destroy();
  server.close(() => process.exit(0));
});

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

client.login(TOKEN);
