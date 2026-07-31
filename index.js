require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1532775690095562964";
const DATA_FILE = path.join(__dirname, "time-data.json");
const PANEL_FILE = path.join(__dirname, "panel-data.json");
const TIME_ZONE = "Asia/Manila";

if (!TOKEN) {
  throw new Error("DISCORD_TOKEN is missing from the .env file.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not read ${path.basename(file)}:`, error);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const temporaryFile = `${file}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
  fs.renameSync(temporaryFile, file);
}

let timeData = readJson(DATA_FILE, {});
let panelData = readJson(PANEL_FILE, { messageId: null });

function getUserRecord(userId) {
  if (!timeData[userId]) {
    timeData[userId] = {
      clockedInAt: null,
      accumulatedMilliseconds: 0,
      sessions: [],
    };
  }

  return timeData[userId];
}

function saveTimeData() {
  writeJsonAtomic(DATA_FILE, timeData);
}

function formatPhilippineDateTime(timestamp) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: true,
  }).format(new Date(timestamp));
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    decimalHours: (milliseconds / 3_600_000).toFixed(2),
    readable: `${hours}h ${minutes}m ${seconds}s`,
  };
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Employee Time Clock")
    .setDescription(
      [
        "Use the buttons below to record your work time.",
        "",
        "🟢 **Clock In** — starts your personal timer",
        "🔴 **Clock Out** — stops your personal timer and adds the session",
        "🧾 **Total Hours** — posts your total publicly and resets your completed total",
        "",
        "**Important:** Clock out before requesting Total Hours.",
        "All displayed times use Philippine Time.",
      ].join("\n")
    )
    .setFooter({ text: "Each Discord user has an independent time record." })
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("time_clock_in")
      .setLabel("Clock In")
      .setEmoji("🟢")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("time_clock_out")
      .setLabel("Clock Out")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("time_total_hours")
      .setLabel("Total Hours")
      .setEmoji("🧾")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [buttons] };
}

async function createOrRefreshPanel(channel) {
  if (panelData.messageId) {
    try {
      const oldPanel = await channel.messages.fetch(panelData.messageId);
      await oldPanel.edit(buildPanel());
      return;
    } catch {
      console.log("Previous panel was not found. Creating a new one.");
    }
  }

  const panel = await channel.send(buildPanel());
  panelData.messageId = panel.id;
  writeJsonAtomic(PANEL_FILE, panelData);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Online as ${readyClient.user.tag}`);

  try {
    const channel = await readyClient.channels.fetch(CHANNEL_ID);

    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      throw new Error(`Channel ${CHANNEL_ID} is not a supported server text channel.`);
    }

    await createOrRefreshPanel(channel);
    console.log("Time-clock panel is ready.");
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

  const userId = interaction.user.id;
  const record = getUserRecord(userId);
  const now = Date.now();

  try {
    if (interaction.customId === "time_clock_in") {
      if (record.clockedInAt !== null) {
        await interaction.reply({
          content: `⚠️ ${interaction.user}, you are already clocked in. Your current session started at **${formatPhilippineDateTime(record.clockedInAt)}**.`,
        });
        return;
      }

      record.clockedInAt = now;
      saveTimeData();

      await interaction.reply({
        content: `🟢 **CLOCKED IN**\nEmployee: ${interaction.user}\nTime: **${formatPhilippineDateTime(now)}**`,
      });
      return;
    }

    if (interaction.customId === "time_clock_out") {
      if (record.clockedInAt === null) {
        await interaction.reply({
          content: `⚠️ ${interaction.user}, you are not currently clocked in.`,
        });
        return;
      }

      const startedAt = record.clockedInAt;
      const sessionMilliseconds = Math.max(0, now - startedAt);

      record.accumulatedMilliseconds += sessionMilliseconds;
      record.sessions.push({
        clockIn: startedAt,
        clockOut: now,
        durationMilliseconds: sessionMilliseconds,
      });
      record.clockedInAt = null;
      saveTimeData();

      const session = formatDuration(sessionMilliseconds);
      const runningTotal = formatDuration(record.accumulatedMilliseconds);

      await interaction.reply({
        content: [
          "🔴 **CLOCKED OUT**",
          `Employee: ${interaction.user}`,
          `Clock In: **${formatPhilippineDateTime(startedAt)}**`,
          `Clock Out: **${formatPhilippineDateTime(now)}**`,
          `Session: **${session.readable} (${session.decimalHours} hours)**`,
          `Current Total: **${runningTotal.readable} (${runningTotal.decimalHours} hours)**`,
        ].join("\n"),
      });
      return;
    }

    if (interaction.customId === "time_total_hours") {
      // Requiring Clock Out first prevents an active shift from being
      // accidentally cut off or reset during invoice calculation.
      if (record.clockedInAt !== null) {
        await interaction.reply({
          content: `⚠️ ${interaction.user}, please click **Clock Out** before requesting and resetting your Total Hours.`,
        });
        return;
      }

      if (record.accumulatedMilliseconds <= 0) {
        await interaction.reply({
          content: `🧾 ${interaction.user}, you currently have **0.00 completed hours** to submit.`,
        });
        return;
      }

      const submittedMilliseconds = record.accumulatedMilliseconds;
      const submittedSessions = record.sessions.length;
      const total = formatDuration(submittedMilliseconds);

      // Reset only this user's completed period after capturing the total.
      record.accumulatedMilliseconds = 0;
      record.sessions = [];
      record.lastSubmittedAt = now;
      record.lastSubmittedMilliseconds = submittedMilliseconds;
      saveTimeData();

      await interaction.reply({
        content: [
          "🧾 **TOTAL HOURS SUBMITTED AND RESET**",
          `Employee: ${interaction.user}`,
          `Completed Sessions: **${submittedSessions}**`,
          `Total: **${total.readable}**`,
          `Invoice Hours: **${total.decimalHours} hours**`,
          `Submitted: **${formatPhilippineDateTime(now)}**`,
          "",
          "This employee's completed total is now reset to **0.00 hours**.",
        ].join("\n"),
      });
    }
  } catch (error) {
    console.error("Time-clock interaction error:", error);

    const message = {
      content: "❌ The bot could not process that time-clock action. Please try again.",
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(message).catch(console.error);
    } else {
      await interaction.reply(message).catch(console.error);
    }
  }
});

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

client.login(TOKEN);
