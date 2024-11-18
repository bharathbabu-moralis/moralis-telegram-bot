const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const {
  fetchAndStoreSwaps,
  processStoredSwaps,
  cleanupOldSwaps,
} = require("./pollingService");
const GroupConfig = require("./models/GroupConfig");
require("dotenv").config();

const bot = new TelegramBot(process.env.BOT_API_TOKEN, {
  polling: { interval: 3000, timeout: 60, autoStart: true },
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

const VALID_CHAINS = [
  {
    id: "eth",
    name: "Ethereum",
    icon: "🔷",
  },
  {
    id: "bsc",
    name: "BSC",
    icon: "💛",
  },
  {
    id: "polygon",
    name: "Polygon",
    icon: "💜",
  },
  {
    id: "avax",
    name: "Avalanche",
    icon: "❄️",
  },
  {
    id: "arbitrum",
    name: "Arbitrum",
    icon: "🔵",
  },
  {
    id: "base",
    name: "Base",
    icon: "🔘",
  },
  {
    id: "linea",
    name: "Linea",
    icon: "🟦",
  },
  {
    id: "optimism",
    name: "Optimism",
    icon: "🔴",
  },
];

const userSessions = {};

function formatChatId(chatId, type, isPublic = false, username = null) {
  if (!chatId || type !== "channel") return chatId;

  if (isPublic) {
    if (username) {
      return username.startsWith("@") ? username : `@${username}`;
    }
    if (isNaN(chatId)) {
      return chatId.startsWith("@") ? chatId : `@${chatId}`;
    }
  }

  const cleanId = chatId.replace(/[^\d]/g, "");
  return `-100${cleanId}`;
}

function formatConfigStatus(config) {
  const trackingStatus = config.tracking?.active ? "✅" : "❌";
  const tokenAddress = config.tracking?.token?.address || "❌";

  // Get chain info with icon
  const chainInfo = config.tracking?.token?.chain
    ? VALID_CHAINS.find((c) => c.id === config.tracking.token.chain)
    : null;
  const chainDisplay = chainInfo ? `${chainInfo.icon} ${chainInfo.name}` : "❌";

  const minValue = config.tracking?.filters?.minValue
    ? `$${config.tracking.filters.minValue}`
    : "❌";
  const transType = config.tracking?.filters?.transactionType || "❌";

  return (
    `Configuration for ${config.name}:\n\n` +
    `🔑 Token: ${tokenAddress}\n` +
    `⛓️ Chain: ${chainDisplay}\n` +
    `💵 Min Value: ${minValue}\n` +
    `📊 Transaction Type: ${transType}\n` +
    `📡 Tracking: ${trackingStatus}`
  );
}

async function verifyChannelAccess(
  bot,
  chatId,
  type,
  isPublic = false,
  username = null
) {
  try {
    const messageId = isPublic
      ? `@${username || chatId}`.replace(/^@@/, "@")
      : `-100${chatId.replace(/[^\d]/g, "")}`;

    // Just check if we can access the chat
    try {
      await bot.getChat(messageId);
      return {
        success: true,
        messageId,
      };
    } catch (error) {
      console.error("Failed to access chat:", error);
      return {
        success: false,
        error: "Cannot access chat",
      };
    }
  } catch (error) {
    console.error("Channel verification failed:", {
      chatId,
      type,
      isPublic,
      error: error.message,
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

// Start command
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const existingConfig = await GroupConfig.find({
    admin_id: userId.toString(),
  });

  if (existingConfig.length === 0) {
    bot.sendMessage(
      userId,
      "Welcome! I can help you track transactions. Choose where you want to set up tracking:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Set up for a Group", callback_data: "setup_group" }],
            [{ text: "Set up for a Channel", callback_data: "setup_channel" }],
          ],
        },
      }
    );
  } else {
    bot.sendMessage(
      userId,
      "You have existing configurations. Use /manage to view and modify them."
    );
  }
});

// My chat member handler
bot.on("my_chat_member", async (chatMember) => {
  const chat = chatMember.chat;
  const newStatus = chatMember.new_chat_member.status;
  const userId = chatMember.from.id;

  if (newStatus === "administrator") {
    const chatType = chat.type === "channel" ? "channel" : "group";
    const isPublic = !!chat.username;
    let chatId;

    if (chatType === "channel") {
      chatId = isPublic
        ? chat.username
        : chat.id.toString().replace(/^-?100/, "");
    } else {
      chatId = chat.id.toString();
    }

    try {
      const config = await GroupConfig.findOneAndUpdate(
        { chatId },
        {
          $set: {
            type: chatType,
            name: chat.title,
            chatId,
            admin_id: userId.toString(),
            isPublic,
            username: chat.username,
            numeric_id: chat.id.toString(),
            tracking: {
              active: false,
              token: {},
              filters: {},
            },
            metadata: {
              createdAt: new Date(),
              lastUpdated: new Date(),
            },
          },
        },
        { upsert: true, new: true }
      );

      const messageId = formatChatId(chatId, chatType, isPublic, chat.username);

      try {
        await bot.sendMessage(
          messageId,
          "✅ Bot setup initialized! I'll send transaction notifications here."
        );

        bot.sendMessage(
          userId,
          `Successfully added to "${chat.title}"! Use /setup to configure tracking.`
        );
      } catch (error) {
        console.error("Failed to send initial message:", error);
        bot.sendMessage(
          userId,
          "⚠️ Added but couldn't send test message. Please verify my permissions."
        );
      }
    } catch (error) {
      console.error("Setup error:", error);
      bot.sendMessage(userId, "Setup error occurred. Please try again.");
    }
  }
});

// Setup command
bot.onText(/\/setup/, async (msg) => {
  const userId = msg.from.id;
  const chatType = msg.chat.type;

  if (chatType === "private") {
    const configs = await GroupConfig.find({
      admin_id: userId.toString(),
      $or: [
        { "tracking.token.address": { $exists: false } },
        { "tracking.token.address": null },
      ],
    });

    if (configs.length === 0) {
      return bot.sendMessage(
        userId,
        "No unconfigured groups/channels found. Make sure to:\n" +
          "1. Add me as an admin\n" +
          "2. Try /setup again\n\n" +
          "Or use /start for new setup."
      );
    }

    const keyboard = configs.map((config) => [
      {
        text: `${config.name} (${config.type})`,
        callback_data: `config_token_${config.chatId}`,
      },
    ]);

    bot.sendMessage(userId, "Select a chat to configure:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  } else if (chatType === "supergroup" || chatType === "group") {
    const chatId = msg.chat.id.toString();
    const groupName = msg.chat.title;

    try {
      const botMember = await bot.getChatMember(chatId, bot.options.username);
      if (botMember.status !== "administrator") {
        return bot.sendMessage(chatId, "Please make me an admin first!");
      }

      await GroupConfig.findOneAndUpdate(
        { chatId },
        {
          $set: {
            type: "group",
            name: groupName,
            chatId,
            admin_id: userId.toString(),
            tracking: {
              active: false,
              token: {},
              filters: {},
            },
          },
        },
        { upsert: true }
      );

      bot.sendMessage(chatId, "Setup initialized! Check your DM to continue.");
      bot.sendMessage(
        userId,
        `Configuring "${groupName}". Let's start with the token address:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Set Token Address",
                  callback_data: `config_token_${chatId}`,
                },
              ],
            ],
          },
        }
      );
    } catch (error) {
      console.error("Setup error:", error);
      bot.sendMessage(
        chatId,
        "An error occurred during setup. Please try again."
      );
    }
  }
});

// Manage command
bot.onText(/\/manage/, async (msg) => {
  const userId = msg.from.id;
  const configs = await GroupConfig.find({ admin_id: userId.toString() });

  if (configs.length === 0) {
    return bot.sendMessage(
      userId,
      "No configurations found. Use /start to set up."
    );
  }

  const keyboard = configs.map((config) => [
    {
      text: `${config.name} (${config.type})`,
      callback_data: `manage_${config.chatId}`,
    },
  ]);

  bot.sendMessage(userId, "Select a chat to manage:", {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// Callback query handler
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const callbackData = query.data;

  try {
    // Initial setup options
    if (callbackData === "setup_group") {
      bot.sendMessage(
        userId,
        "To set up a group:\n" +
          "1. Add me to your group\n" +
          "2. Make me an admin\n" +
          "3. Type /setup in the group"
      );
    } else if (callbackData === "setup_channel") {
      bot.sendMessage(
        userId,
        "To set up a channel:\n" +
          "1. Add me as an admin to your channel\n" +
          "2. Type /setup here after adding me"
      );
    }

    // Configuration steps
    else if (callbackData.startsWith("config_token_")) {
      const chatId = callbackData.split("_")[2];
      const config = await GroupConfig.findOne({
        chatId,
        admin_id: userId.toString(), // Important: Verify user is admin
      });

      if (!config) {
        return bot.sendMessage(
          userId,
          "Configuration not found. Please start again."
        );
      }

      bot.sendMessage(
        userId,
        `Configuring ${config.name}\nPlease enter the token address (format: 0x...)`
      );
      userSessions[userId] = { step: "awaiting_token", chatId };
    } else if (callbackData.startsWith("set_chain_")) {
      const [_, __, chain, chatId] = callbackData.split("_");

      // Validate chain
      if (!VALID_CHAINS.find((c) => c.id === chain)) {
        return bot.sendMessage(
          userId,
          "Invalid chain selected. Please try again."
        );
      }

      await GroupConfig.findOneAndUpdate(
        { chatId },
        {
          $set: {
            "tracking.token.chain": chain,
          },
        }
      );

      const chainInfo = VALID_CHAINS.find((c) => c.id === chain);
      bot.sendMessage(
        userId,
        `Chain set to ${chainInfo.icon} ${chainInfo.name}! Now enter the minimum transaction value in USD:`
      );
      userSessions[userId] = { step: "awaiting_minvalue", chatId };
    } else if (callbackData.startsWith("set_transtype_")) {
      const [_, __, type, chatId] = callbackData.split("_");

      await GroupConfig.findOneAndUpdate(
        { chatId },
        {
          $set: {
            "tracking.filters.transactionType": type,
          },
        }
      );

      const config = await GroupConfig.findOne({ chatId });
      bot.sendMessage(
        userId,
        `Transaction type set to: ${type}\n\n${formatConfigStatus(config)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Start Tracking",
                  callback_data: `tracking_start_${chatId}`,
                },
              ],
            ],
          },
        }
      );
    }

    // Tracking controls
    else if (callbackData.startsWith("tracking_")) {
      const [_, action, chatId] = callbackData.split("_");
      const config = await GroupConfig.findOne({
        chatId,
        admin_id: userId.toString(),
      });

      if (!config) {
        return bot.sendMessage(
          userId,
          "You don't have permission to manage this chat."
        );
      }

      const isStarting = action === "start";

      if (isStarting) {
        try {
          // Verify configuration is complete
          if (
            !config.tracking?.token?.address ||
            !config.tracking?.token?.chain ||
            !config.tracking?.filters?.minValue ||
            !config.tracking?.filters?.transactionType
          ) {
            return bot.sendMessage(
              userId,
              "Please complete all configuration settings before starting tracking."
            );
          }

          // Verify access
          const messageId = formatChatId(
            config.chatId,
            config.type,
            config.isPublic,
            config.username
          );

          try {
            await bot.getChat(messageId);
          } catch (error) {
            return bot.sendMessage(
              userId,
              "Cannot access the chat. Please verify my permissions."
            );
          }

          // Start tracking
          await GroupConfig.findOneAndUpdate(
            { chatId },
            {
              $set: {
                "tracking.active": true,
                "tracking.startTime": new Date(),
              },
            }
          );

          bot.sendMessage(
            userId,
            "✅ Tracking started successfully!\n\n" +
              formatConfigStatus(config),
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Manage Configuration",
                      callback_data: `manage_${chatId}`,
                    },
                  ],
                ],
              },
            }
          );
        } catch (error) {
          console.error("Failed to start tracking:", error);
          return bot.sendMessage(
            userId,
            "❌ Failed to start tracking. Please try again."
          );
        }
      } else {
        // Stop tracking
        await GroupConfig.findOneAndUpdate(
          { chatId },
          {
            $set: {
              "tracking.active": false,
              "tracking.startTime": null,
            },
          }
        );

        bot.sendMessage(
          userId,
          "⏹️ Tracking stopped!\n\n" + formatConfigStatus(config),
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Manage Configuration",
                    callback_data: `manage_${chatId}`,
                  },
                ],
              ],
            },
          }
        );
      }
    }

    // Management actions
    // Management actions (continued from previous part)
    else if (callbackData.startsWith("manage_")) {
      const chatId = callbackData.split("_")[1];
      const config = await GroupConfig.findOne({ chatId });

      if (!config || config.admin_id !== userId.toString()) {
        return bot.sendMessage(
          userId,
          "You don't have permission to manage this chat."
        );
      }

      const keyboard = [
        [{ text: "Configure Token", callback_data: `config_token_${chatId}` }],
        [
          {
            text: "Configure Chain",
            callback_data: `set_chain_menu_${chatId}`,
          },
        ],
        [{ text: "Set Min Value", callback_data: `config_minvalue_${chatId}` }],
        [
          {
            text: "Set Transaction Type",
            callback_data: `config_transtype_${chatId}`,
          },
        ],
      ];

      if (config.tracking?.token?.address) {
        keyboard.push([
          {
            text: config.tracking.active ? "Stop Tracking" : "Start Tracking",
            callback_data: `tracking_${
              config.tracking.active ? "stop" : "start"
            }_${chatId}`,
          },
        ]);
      }

      bot.sendMessage(userId, formatConfigStatus(config), {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // Chain menu handler
    else if (callbackData.startsWith("set_chain_menu_")) {
      const chatId = callbackData.split("_")[3];

      // Create keyboard with 2 chains per row
      const keyboard = [];
      for (let i = 0; i < VALID_CHAINS.length; i += 2) {
        const row = [];

        // Add first chain in pair
        row.push({
          text: `${VALID_CHAINS[i].icon} ${VALID_CHAINS[i].name}`,
          callback_data: `set_chain_${VALID_CHAINS[i].id}_${chatId}`,
        });

        // Add second chain if exists
        if (i + 1 < VALID_CHAINS.length) {
          row.push({
            text: `${VALID_CHAINS[i + 1].icon} ${VALID_CHAINS[i + 1].name}`,
            callback_data: `set_chain_${VALID_CHAINS[i + 1].id}_${chatId}`,
          });
        }

        keyboard.push(row);
      }

      bot.sendMessage(userId, "Select the chain:", {
        reply_markup: {
          inline_keyboard: keyboard,
        },
      });
    }

    // Handle config_minvalue
    else if (callbackData.startsWith("config_minvalue_")) {
      const chatId = callbackData.split("_")[2];
      bot.sendMessage(
        userId,
        "Please enter the minimum transaction value in USD:"
      );
      userSessions[userId] = { step: "awaiting_minvalue", chatId };
    }

    // Handle config_transtype
    else if (callbackData.startsWith("config_transtype_")) {
      const chatId = callbackData.split("_")[2];
      bot.sendMessage(userId, "Select transaction type to track:", {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Buy Only",
                callback_data: `set_transtype_buy_${chatId}`,
              },
              {
                text: "Sell Only",
                callback_data: `set_transtype_sell_${chatId}`,
              },
              { text: "Both", callback_data: `set_transtype_both_${chatId}` },
            ],
          ],
        },
      });
    }
  } catch (error) {
    console.error("Callback query error:", error);
    bot.sendMessage(userId, "An error occurred. Please try again.");
  }
});

// Message handler for text inputs
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const session = userSessions[userId];
  if (!session) return;

  try {
    if (session.step === "awaiting_token") {
      const tokenAddress = msg.text;
      if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
        return bot.sendMessage(userId, "Invalid address format. Try again.");
      }

      await GroupConfig.findOneAndUpdate(
        { chatId: session.chatId },
        {
          $set: {
            "tracking.token.address": tokenAddress,
          },
        }
      );

      const config = await GroupConfig.findOne({ chatId: session.chatId });

      // Create keyboard with 2 chains per row
      const keyboard = [];
      for (let i = 0; i < VALID_CHAINS.length; i += 2) {
        const row = [];

        // Add first chain in pair
        row.push({
          text: `${VALID_CHAINS[i].icon} ${VALID_CHAINS[i].name}`,
          callback_data: `set_chain_${VALID_CHAINS[i].id}_${session.chatId}`,
        });

        // Add second chain if exists
        if (i + 1 < VALID_CHAINS.length) {
          row.push({
            text: `${VALID_CHAINS[i + 1].icon} ${VALID_CHAINS[i + 1].name}`,
            callback_data: `set_chain_${VALID_CHAINS[i + 1].id}_${
              session.chatId
            }`,
          });
        }

        keyboard.push(row);
      }

      bot.sendMessage(
        userId,
        `Token address saved!\n\n${formatConfigStatus(
          config
        )}\n\nNow select the chain:`,
        {
          reply_markup: {
            inline_keyboard: keyboard,
          },
        }
      );
      delete userSessions[userId];
    } else if (session.step === "awaiting_minvalue") {
      const minValue = parseFloat(msg.text);
      if (isNaN(minValue) || minValue <= 0) {
        return bot.sendMessage(
          userId,
          "Please enter a valid number greater than 0."
        );
      }

      await GroupConfig.findOneAndUpdate(
        { chatId: session.chatId },
        {
          $set: {
            "tracking.filters.minValue": minValue,
          },
        }
      );

      const config = await GroupConfig.findOne({ chatId: session.chatId });
      bot.sendMessage(
        userId,
        `Minimum value set!\n\n${formatConfigStatus(
          config
        )}\n\nSelect transaction types to track:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Buy Only",
                  callback_data: `set_transtype_buy_${session.chatId}`,
                },
                {
                  text: "Sell Only",
                  callback_data: `set_transtype_sell_${session.chatId}`,
                },
                {
                  text: "Both",
                  callback_data: `set_transtype_both_${session.chatId}`,
                },
              ],
            ],
          },
        }
      );
      delete userSessions[userId];
    }
  } catch (error) {
    console.error("Message handler error:", error);
    bot.sendMessage(userId, "An error occurred. Please try again.");
  }
});

// Set up intervals for the new polling system
let fetchInterval = null;
let processInterval = null;
let cleanupInterval = null;

function startPolling() {
  // Stop existing intervals if any
  if (fetchInterval) clearInterval(fetchInterval);
  if (processInterval) clearInterval(processInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);

  // Start new polling intervals
  fetchInterval = setInterval(fetchAndStoreSwaps, 30000); // Every 30 seconds
  processInterval = setInterval(() => processStoredSwaps(bot), 10000); // Every 10 seconds
  cleanupInterval = setInterval(cleanupOldSwaps, 24 * 60 * 60 * 1000); // Once a day

  console.log("Polling services started");
}

// Start polling when bot is ready
bot.on("polling_error", (error) => {
  console.error("Polling error:", error);
});

startPolling();

module.exports = bot;
