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

if (!TOKEN) {
  throw new Error("DISCORD_TOKEN is missing.");
}

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL is missing.");
}

if (!SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is missing.");
}

if (!CHANNEL_ID) {
  throw new Error("CHANNEL_ID is missing.");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/*
 * Small web server required because this bot is deployed
 * as a Render Web Service.
 */
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, {
      "Content-Type": "application/json",
    });

    response.end(
      JSON.stringify({
        status: "ok",
        discordReady: client.isReady(),
        timestamp: new Date().toISOString(),
      })
    );

    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/plain",
  });

  response.end("Discord time-clock bot is running.");
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
    throw new Error(
      `Could not load time record: ${error.message}`
    );
  }

  if (data) {
    return {
      ...data,
      sessions: Array.isArray(data.sessions)
        ? data.sessions
        : [],
    };
  }

  const newRecord = createDefaultRecord(userId);

  const {
    data: createdRecord,
    error: insertError,
  } = await supabase
    .from("time_records")
    .insert(newRecord)
    .select("*")
    .single();

  if (insertError) {
    /*
     * Another request may have created the record at nearly
     * the same time. Try loading it once more.
     */
    const {
      data: existingRecord,
      error: retryError,
    } = await supabase
      .from("time_records")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (retryError) {
      throw new Error(
        `Could not create time record: ${insertError.message}`
      );
    }

    return {
      ...existingRecord,
      sessions: Array.isArray(existingRecord.sessions)
        ? existingRecord.sessions
        : [],
    };
  }

  return createdRecord;
}

async function saveUserRecord(record) {
  const recordToSave = {
    user_id: record.user_id,
    clocked_in_at: record.clocked_in_at,
    accumulated_milliseconds:
      record.accumulated_milliseconds || 0,
    sessions: Array.isArray(record.sessions)
      ? record.sessions
      : [],
    last_submitted_at:
      record.last_submitted_at || null,
    last_submitted_milliseconds:
      record.last_submitted_milliseconds || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("time_records")
    .upsert(recordToSave, {
      onConflict: "user_id",
    });

  if (error) {
    throw new Error(
      `Could not save time record: ${error.message}`
    );
  }
}

async function getPanelMessageId() {
  const { data, error } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", "panel_message_id")
    .maybeSingle();

  if (error) {
    throw new Error(
      `Could not load panel setting: ${error.message}`
    );
  }

  return data?.setting_value || null;
}

async function savePanelMessageId(messageId) {
  const { error } = await supabase
    .from("bot_settings")
    .upsert(
      {
        setting_key: "panel_message_id",
        setting_value: messageId,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "setting_key",
      }
    );

  if (error) {
    throw new Error(
      `Could not save panel setting: ${error.message}`
    );
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
  const safeMilliseconds = Math.max(
    0,
    Number(milliseconds) || 0
  );

  const totalSeconds = Math.floor(
    safeMilliseconds / 1000
  );

  const hours = Math.floor(totalSeconds / 3600);

  const minutes = Math.floor(
    (totalSeconds % 3600) / 60
  );

  const seconds = totalSeconds % 60;

  return {
    decimalHours: (
      safeMilliseconds / 3_600_000
    ).toFixed(2),

    readable: `${hours}h ${minutes}m ${seconds}s`,
  };
}

/*
 * Button displayed directly under a successful
 * Clock In message.
 */
function buildClockedInActions() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("time_clock_out")
      .setLabel("Clock Out")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
  );
}

/*
 * Buttons displayed after Clock Out or Total Hours
 * submission.
 */
function buildClockedOutActions() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("time_clock_in")
      .setLabel("Clock In")
      .setEmoji("🟢")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("time_total_hours")
      .setLabel("Total Hours")
      .setEmoji("🧾")
      .setStyle(ButtonStyle.Primary)
  );
}

/*
 * Private Yes/No confirmation buttons for Total Hours.
 *
 * The current total and session count are included in the
 * custom ID. This prevents an older confirmation from
 * resetting newly recorded hours.
 */
function buildTotalHoursConfirmation(
  userId,
  expectedMilliseconds,
  expectedSessions
) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `time_total_hours_confirm:${userId}:${expectedMilliseconds}:${expectedSessions}`
      )
      .setLabel("Yes, Submit & Reset")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId(
        `time_total_hours_cancel:${userId}`
      )
      .setLabel("No, Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Employee Time Clock")
    .setDescription(
      [
        "Use the buttons below to record your work time.",
        "",
        "🟢 **Clock In** — starts your personal timer",
        "🔴 **Clock Out** — stops your timer and adds the session",
        "🧾 **Total Hours** — submits your completed total and resets it to zero",
        "",
        "**Important:** Clock out before requesting Total Hours.",
        "A private Yes/No warning appears before any reset.",
        "All displayed times use Philippine Time.",
      ].join("\n")
    )
    .setFooter({
      text: "Records are stored in the cloud database.",
    })
    .setTimestamp();

  const buttons =
    new ActionRowBuilder().addComponents(
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

  return {
    embeds: [embed],
    components: [buttons],
  };
}

async function createOrRefreshPanel(channel) {
  const panelMessageId =
    await getPanelMessageId();

  if (panelMessageId) {
    try {
      const oldPanel =
        await channel.messages.fetch(
          panelMessageId
        );

      await oldPanel.edit(buildPanel());

      console.log("Existing panel refreshed.");

      return;
    } catch (error) {
      console.log(
        "Previous panel was not found. Creating a new one."
      );
    }
  }

  const panel = await channel.send(
    buildPanel()
  );

  await savePanelMessageId(panel.id);

  console.log(
    `New panel created: ${panel.id}`
  );
}

client.once(
  Events.ClientReady,
  async (readyClient) => {
    console.log(
      `Online as ${readyClient.user.tag}`
    );

    try {
      const channel =
        await readyClient.channels.fetch(
          CHANNEL_ID
        );

      if (
        !channel ||
        !channel.isTextBased() ||
        !("messages" in channel)
      ) {
        throw new Error(
          `Channel ${CHANNEL_ID} is not a supported text channel.`
        );
      }

      await createOrRefreshPanel(channel);

      console.log(
        "Time-clock panel is ready."
      );
    } catch (error) {
      console.error(
        "Could not prepare the time-clock channel:",
        error
      );
    }
  }
);

client.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    if (
      !interaction.customId.startsWith(
        "time_"
      )
    ) {
      return;
    }

    if (
      interaction.channelId !== CHANNEL_ID
    ) {
      await interaction.reply({
        content:
          `The time clock can only be used in <#${CHANNEL_ID}>.`,
        ephemeral: true,
      });

      return;
    }

    const customId =
      interaction.customId;

    const userId =
      interaction.user.id;

    const now =
      Date.now();

    const confirmPrefix =
      "time_total_hours_confirm:";

    const cancelPrefix =
      "time_total_hours_cancel:";

    const isTotalHoursConfirmation =
      customId.startsWith(confirmPrefix);

    const isTotalHoursCancellation =
      customId.startsWith(cancelPrefix);

    /*
     * The confirmation buttons contain the employee's Discord ID.
     * This prevents another employee from using somebody else's
     * confirmation buttons if the message visibility changes later.
     */
    if (
      isTotalHoursConfirmation ||
      isTotalHoursCancellation
    ) {
      const expectedUserId =
        customId.split(":")[1];

      if (expectedUserId !== userId) {
        await interaction.reply({
          content:
            "⚠️ This Total Hours confirmation belongs to another employee.",
          ephemeral: true,
        });

        return;
      }
    }

    /*
     * User selected No.
     */
    if (isTotalHoursCancellation) {
      await interaction.update({
        content:
          "✅ Total Hours cancelled. No hours were submitted or reset.",
        components: [],
      });

      return;
    }

    /*
     * User selected Yes.
     */
    if (isTotalHoursConfirmation) {
      /*
       * Remove the Yes/No buttons immediately so the destructive
       * action cannot be clicked twice while the database is saving.
       */
      await interaction.update({
        content:
          "⏳ Submitting your completed hours and resetting the total...",
        components: [],
      });

      try {
        const record =
          await getUserRecord(userId);

        /*
         * Re-check the record because its state may have changed
         * after the warning was first displayed.
         */
        if (record.clocked_in_at !== null) {
          await interaction.editReply({
            content:
              `⚠️ ${interaction.user}, you are currently clocked in. ` +
              "Clock out first, then request Total Hours again.",
            components: [],
          });

          return;
        }

        if (
          Number(
            record.accumulated_milliseconds
          ) <= 0
        ) {
          await interaction.editReply({
            content:
              `🧾 ${interaction.user}, you currently have **0.00 completed hours**. Nothing was reset.`,
            components: [],
          });

          return;
        }

        const confirmationParts =
          customId.split(":");

        const expectedMilliseconds =
          Number(confirmationParts[2]);

        const expectedSessions =
          Number(confirmationParts[3]);

        /*
         * Prevent an old confirmation message from resetting
         * hours that were recorded after the warning appeared.
         */
        if (
          Number(
            record.accumulated_milliseconds
          ) !== expectedMilliseconds ||
          record.sessions.length !== expectedSessions
        ) {
          await interaction.editReply({
            content: [
              "⚠️ Your completed hours changed after this warning was opened.",
              "Nothing was submitted or reset.",
              "Please click **Total Hours** again to review the updated total.",
            ].join("\n"),
            components: [],
          });

          return;
        }

        const submittedMilliseconds =
          Number(
            record.accumulated_milliseconds
          );

        const submittedSessions =
          record.sessions.length;

        const total =
          formatDuration(
            submittedMilliseconds
          );

        /*
         * Reset the completed total only after the employee
         * selected Yes.
         */
        record.accumulated_milliseconds = 0;
        record.sessions = [];
        record.last_submitted_at = now;
        record.last_submitted_milliseconds =
          submittedMilliseconds;

        await saveUserRecord(record);

        /*
         * Update the private confirmation.
         */
        await interaction.editReply({
          content:
            "✅ Confirmed. Your completed hours were submitted and reset.",
          components: [],
        });

        /*
         * Post the final total publicly in the channel,
         * matching the original bot behavior.
         */
        await interaction.followUp({
          content: [
            "🧾 **TOTAL HOURS SUBMITTED AND RESET**",
            `Employee: ${interaction.user}`,
            `Completed Sessions: **${submittedSessions}**`,
            `Total: **${total.readable}**`,
            `Invoice Hours: **${total.decimalHours} hours**`,
            `Submitted: **${formatPhilippineDateTime(
              now
            )}**`,
            "",
            "This employee's completed total is now reset to **0.00 hours**.",
          ].join("\n"),

          components: [
            buildClockedOutActions(),
          ],

          ephemeral: false,
        });
      } catch (error) {
        console.error(
          "Total-hours confirmation error:",
          error
        );

        await interaction
          .editReply({
            content:
              "❌ The bot could not submit or reset your hours. Please try again.",
            components: [],
          })
          .catch(console.error);
      }

      return;
    }

    /*
     * Total Hours starts with a private warning.
     *
     * Clock In and Clock Out continue to post regular
     * channel messages.
     */
    await interaction.deferReply({
      ephemeral:
        customId === "time_total_hours",
    });

    try {
      const record =
        await getUserRecord(userId);

      /*
       * CLOCK IN
       */
      if (
        customId === "time_clock_in"
      ) {
        if (
          record.clocked_in_at !== null
        ) {
          await interaction.editReply({
            content:
              `⚠️ ${interaction.user}, you are already clocked in. ` +
              `Your session started at **${formatPhilippineDateTime(
                record.clocked_in_at
              )}**.`,

            /*
             * Include a Clock Out button so the employee
             * does not need to scroll back to the main panel.
             */
            components: [
              buildClockedInActions(),
            ],
          });

          return;
        }

        record.clocked_in_at = now;

        await saveUserRecord(record);

        await interaction.editReply({
          content: [
            "🟢 **CLOCKED IN**",
            `Employee: ${interaction.user}`,
            `Time: **${formatPhilippineDateTime(
              now
            )}**`,
            "",
            "Use the **Clock Out** button below when your shift is finished.",
          ].join("\n"),

          /*
           * Clock Out button appears directly beneath
           * the Clock In confirmation.
           */
          components: [
            buildClockedInActions(),
          ],
        });

        return;
      }

      /*
       * CLOCK OUT
       */
      if (
        customId === "time_clock_out"
      ) {
        if (
          record.clocked_in_at === null
        ) {
          await interaction.editReply({
            content:
              `⚠️ ${interaction.user}, you are not currently clocked in.`,

            components: [
              buildClockedOutActions(),
            ],
          });

          return;
        }

        const startedAt =
          Number(record.clocked_in_at);

        const sessionMilliseconds =
          Math.max(0, now - startedAt);

        record.accumulated_milliseconds =
          Number(
            record.accumulated_milliseconds
          ) + sessionMilliseconds;

        record.sessions.push({
          clockIn: startedAt,
          clockOut: now,
          durationMilliseconds:
            sessionMilliseconds,
        });

        record.clocked_in_at = null;

        await saveUserRecord(record);

        const session =
          formatDuration(
            sessionMilliseconds
          );

        const runningTotal =
          formatDuration(
            record.accumulated_milliseconds
          );

        await interaction.editReply({
          content: [
            "🔴 **CLOCKED OUT**",
            `Employee: ${interaction.user}`,
            `Clock In: **${formatPhilippineDateTime(
              startedAt
            )}**`,
            `Clock Out: **${formatPhilippineDateTime(
              now
            )}**`,
            `Session: **${session.readable} (${session.decimalHours} hours)**`,
            `Current Total: **${runningTotal.readable} (${runningTotal.decimalHours} hours)**`,
            "",
            "You can clock in again or request Total Hours below.",
          ].join("\n"),

          components: [
            buildClockedOutActions(),
          ],
        });

        return;
      }

      /*
       * TOTAL HOURS
       */
      if (
        customId === "time_total_hours"
      ) {
        if (
          record.clocked_in_at !== null
        ) {
          await interaction.editReply({
            content:
              `⚠️ ${interaction.user}, click **Clock Out** before requesting Total Hours.`,

            components: [
              buildClockedInActions(),
            ],
          });

          return;
        }

        if (
          Number(
            record.accumulated_milliseconds
          ) <= 0
        ) {
          await interaction.editReply({
            content:
              `🧾 ${interaction.user}, you currently have **0.00 completed hours**.`,
            components: [],
          });

          return;
        }

        const total =
          formatDuration(
            record.accumulated_milliseconds
          );

        const completedSessions =
          record.sessions.length;

        /*
         * Do not reset the hours yet.
         *
         * Show a private explanation with Yes and No buttons.
         */
        await interaction.editReply({
          content: [
            "⚠️ **CONFIRM TOTAL HOURS**",
            `Employee: ${interaction.user}`,
            `Completed Sessions: **${completedSessions}**`,
            `Total to submit: **${total.readable} (${total.decimalHours} hours)**`,
            "",
            "Choosing **Yes, Submit & Reset** will:",
            "• Post your completed total in this channel.",
            "• Clear all completed sessions.",
            "• Reset your completed hours to **0.00**.",
            "",
            "Choosing **No, Cancel** will make no changes.",
            "",
            "Do you want to continue?",
          ].join("\n"),

          components: [
            buildTotalHoursConfirmation(
              userId,
              Number(
                record.accumulated_milliseconds
              ),
              completedSessions
            ),
          ],
        });

        return;
      }

      await interaction.editReply({
        content:
          "❌ Unknown time-clock action.",
        components: [],
      });
    } catch (error) {
      console.error(
        "Time-clock interaction error:",
        error
      );

      const errorMessage =
        "❌ The bot could not save the action to the database. Please try again.";

      if (interaction.deferred) {
        await interaction
          .editReply({
            content: errorMessage,
            components: [],
          })
          .catch(console.error);
      } else {
        await interaction
          .reply({
            content: errorMessage,
            ephemeral: true,
          })
          .catch(console.error);
      }
    }
  }
);

process.on(
  "SIGTERM",
  async () => {
    console.log(
      "SIGTERM received. Shutting down."
    );

    client.destroy();

    server.close(() => {
      process.exit(0);
    });
  }
);

process.on(
  "uncaughtException",
  console.error
);

process.on(
  "unhandledRejection",
  console.error
);

client.login(TOKEN);