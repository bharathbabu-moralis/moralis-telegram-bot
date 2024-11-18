const axios = require("axios");
const GroupConfig = require("./models/GroupConfig");
const SwapData = require("./models/SwapData");
const Chain = require("./models/Chain");
const Queue = require("better-queue");

// Rate limit handler for Telegram notifications
class RateLimitHandler {
  constructor() {
    this.waitTimes = new Map();
  }

  shouldWait(chatId) {
    return (
      this.waitTimes.has(chatId) && this.waitTimes.get(chatId) > Date.now()
    );
  }

  getWaitTime(chatId) {
    return Math.max(0, (this.waitTimes.get(chatId) || 0) - Date.now());
  }

  setWaitTime(chatId, seconds) {
    this.waitTimes.set(chatId, Date.now() + seconds * 1000);
  }

  clearWaitTime(chatId) {
    this.waitTimes.delete(chatId);
  }
}

const rateLimitHandler = new RateLimitHandler();

// Message queue for rate-limited notifications
const messageQueue = new Queue(
  async function (task, cb) {
    const { bot, chatId, message, options } = task;

    try {
      if (rateLimitHandler.shouldWait(chatId)) {
        const waitTime = rateLimitHandler.getWaitTime(chatId);
        throw new Error(
          `Rate limit in effect. Wait ${Math.ceil(waitTime / 1000)} seconds`
        );
      }

      await bot.sendMessage(chatId, message, options);
      cb(null);
    } catch (error) {
      if (error.message.includes("Too Many Requests")) {
        const match = error.message.match(/retry after (\d+)/);
        const retrySeconds = match ? parseInt(match[1]) : 10;
        rateLimitHandler.setWaitTime(chatId, retrySeconds);

        setTimeout(() => {
          messageQueue.push(task);
        }, retrySeconds * 1000 + 100);

        cb(null);
      } else {
        cb(error);
      }
    }
  },
  {
    concurrent: 1,
    maxRetries: 3,
    retryDelay: 1000,
  }
);

// Get unique token+chain combinations from active configs
async function getUniqueActiveTokens() {
  return GroupConfig.aggregate([
    {
      $match: {
        "tracking.active": true,
        "tracking.token.address": { $exists: true },
        "tracking.token.chain": { $exists: true },
      },
    },
    {
      $group: {
        _id: {
          address: "$tracking.token.address",
          chain: "$tracking.token.chain",
        },
        configs: { $push: "$$ROOT" },
      },
    },
  ]);
}

// Fetch swaps for a single token
async function fetchSwapsForToken(tokenAddress, chain) {
  try {
    const response = await axios.get(
      `https://deep-index-beta.moralis.io/api/v2.2/erc20/${tokenAddress}/swaps`,
      {
        params: {
          chain,
          order: "DESC",
          limit: 100,
        },
        headers: { "X-API-Key": process.env.MORALIS_API_KEY },
      }
    );

    if (!response.data?.result) {
      console.log(`No swaps found for ${tokenAddress} on ${chain}`);
      return [];
    }

    return response.data.result;
  } catch (error) {
    console.error(
      `Error fetching swaps for ${tokenAddress} on ${chain}:`,
      error.message
    );
    throw error;
  }
}

// Store swaps with bulk operation
async function storeSwaps(swaps, tokenAddress, chain) {
  if (swaps.length === 0) return;

  const bulkOps = swaps.map((swap) => ({
    updateOne: {
      filter: { transaction_hash: swap.transaction_hash },
      update: {
        $setOnInsert: {
          tokenAddress,
          chain,
          transaction_hash: swap.transaction_hash,
          block_timestamp: new Date(swap.block_timestamp),
          swap_data: swap,
          processed: false,
        },
      },
      upsert: true,
    },
  }));

  try {
    const result = await SwapData.bulkWrite(bulkOps);
    console.log(
      `Stored ${result.upsertedCount} new swaps for ${tokenAddress} on ${chain}`
    );
    return result.upsertedCount;
  } catch (error) {
    console.error(`Error storing swaps for ${tokenAddress}:`, error.message);
    throw error;
  }
}

// Main fetch and store function
async function fetchAndStoreSwaps() {
  try {
    const uniqueTokens = await getUniqueActiveTokens();
    console.log(
      `Fetching swaps for ${uniqueTokens.length} unique token combinations`
    );

    for (const token of uniqueTokens) {
      try {
        const { address, chain } = token._id;
        const swaps = await fetchSwapsForToken(address, chain);
        await storeSwaps(swaps, address, chain);
      } catch (error) {
        console.error(
          `Failed processing token ${token._id.address}:`,
          error.message
        );
        continue;
      }
    }
  } catch (error) {
    console.error("Error in fetchAndStoreSwaps:", error);
  }
}

// Process stored swaps
async function processStoredSwaps(bot) {
  try {
    const uniqueTokens = await getUniqueActiveTokens();

    for (const tokenGroup of uniqueTokens) {
      const { address, chain } = tokenGroup._id;

      const unprocessedSwaps = await SwapData.find({
        tokenAddress: address,
        chain,
        processed: false,
      })
        .sort({ block_timestamp: 1 })
        .limit(50)
        .lean();

      if (unprocessedSwaps.length === 0) continue;

      const chainInfo = await Chain.findOne({ chain_name: chain }).lean();
      if (!chainInfo) continue;

      for (const swapData of unprocessedSwaps) {
        try {
          const swap = swapData.swap_data;
          const swapTimestamp = new Date(swap.block_timestamp);
          const notifications = [];

          // Calculate swap amount once
          const swapAmount = Math.abs(
            swap.transaction_type === "buy"
              ? swap.token1.usd_amount
              : swap.token0.usd_amount
          );

          // Check all configs for this token
          for (const config of tokenGroup.configs) {
            // Skip if swap is before tracking start time
            if (
              config.tracking.startTime &&
              swapTimestamp < new Date(config.tracking.startTime)
            ) {
              continue;
            }

            const { minValue, transactionType } = config.tracking.filters;

            // Check criteria
            if (swapAmount < minValue) continue;

            const matchesType =
              transactionType === "both" ||
              transactionType === swap.transaction_type;

            if (!matchesType) continue;

            notifications.push(config);
          }

          if (notifications.length > 0) {
            const messageTemplate = await prepareMessageTemplate(
              swap,
              chainInfo,
              address
            );

            // Send notifications
            await Promise.allSettled(
              notifications.map(async (config) => {
                try {
                  await sendNotification(bot, config, messageTemplate);
                  await SwapData.updateOne(
                    { _id: swapData._id },
                    {
                      $push: {
                        notifications: {
                          chatId: config.chatId,
                          sentAt: new Date(),
                          success: true,
                        },
                      },
                    }
                  );
                } catch (error) {
                  console.error(
                    `Notification failed for ${config.chatId}:`,
                    error.message
                  );
                  await SwapData.updateOne(
                    { _id: swapData._id },
                    {
                      $push: {
                        notifications: {
                          chatId: config.chatId,
                          sentAt: new Date(),
                          success: false,
                          error: error.message,
                        },
                      },
                    }
                  );
                }
              })
            );
          }

          // Mark as processed
          await SwapData.updateOne(
            { _id: swapData._id },
            {
              $set: {
                processed: true,
                processedAt: new Date(),
              },
            }
          );
        } catch (error) {
          console.error(
            `Error processing swap ${swapData.transaction_hash}:`,
            error.message
          );
          continue;
        }
      }
    }
  } catch (error) {
    console.error("Error in processStoredSwaps:", error);
  }
}

// Helper function to prepare notification message
async function prepareMessageTemplate(swap, chainInfo, trackedTokenAddress) {
  const isBuyTransaction = swap.transaction_type === "buy";
  const trackedTokenIsToken0 =
    swap.token0.address.toLowerCase() === trackedTokenAddress.toLowerCase();
  const trackedToken = trackedTokenIsToken0 ? swap.token0 : swap.token1;
  const price = trackedToken.usd_price.toFixed(2);
  const tokenSpent = swap.token_sold === "token0" ? swap.token0 : swap.token1;
  const tokenReceived =
    swap.token_bought === "token1" ? swap.token1 : swap.token0;

  return {
    type: isBuyTransaction ? "🟢 Buy" : "🔴 Sell",
    exchange: swap.pair_label || "Unknown Exchange",
    amounts: {
      spent: {
        usd: Math.abs(tokenSpent.usd_amount).toFixed(2),
        tokens: Math.abs(tokenSpent.amount).toFixed(4),
        symbol: tokenSpent.symbol,
      },
      received: {
        tokens: Math.abs(tokenReceived.amount).toFixed(4),
        symbol: tokenReceived.symbol,
      },
    },
    price,
    wallet: swap.wallet_address,
    urls: {
      explorer: chainInfo.explorer_url,
      tx: swap.transaction_hash,
      chart: `${chainInfo.chart_url_base}${trackedTokenAddress}`,
    },
  };
}

// Send notification with rate limiting
async function sendNotification(bot, config, template) {
  const formattedChatId = formatChatId(
    config.chatId,
    config.type,
    config.isPublic,
    config.username
  );
  const emojiCount = Math.min(
    17,
    Math.max(1, Math.floor(parseFloat(template.amounts.spent.usd) / 50))
  );
  const emoji = (config.customization?.emoji || "⚡️").repeat(emojiCount);

  const message = `
${template.type} on ${template.exchange}!\n\n
${emoji}\n\n
💲 Spent: $${template.amounts.spent.usd} (${template.amounts.spent.tokens} ${
    template.amounts.spent.symbol
  })\n
💱 Got: ${template.amounts.received.tokens} ${
    template.amounts.received.symbol
  } Tokens\n
🤵‍♂️ Wallet: <a href="${template.urls.explorer}/address/${
    template.wallet
  }">${template.wallet.slice(0, 6)}...${template.wallet.slice(-4)}</a>\n
💵 Price: $${template.price}\n\n
<a href="${template.urls.explorer}/tx/${template.urls.tx}">TX</a> | <a href="${
    template.urls.chart
  }">Chart</a>
  `.trim();

  return new Promise((resolve, reject) => {
    messageQueue.push(
      {
        bot,
        chatId: formattedChatId,
        message,
        options: {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
      },
      async (err) => {
        if (err) {
          reject(err);
        } else {
          try {
            await GroupConfig.updateOne(
              { chatId: config.chatId },
              { $set: { "metadata.lastActive": new Date() } }
            );
            resolve();
          } catch (updateError) {
            reject(updateError);
          }
        }
      }
    );
  });
}

// Cleanup old processed swaps
async function cleanupOldSwaps() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  await SwapData.deleteMany({
    processed: true,
    processedAt: { $lt: thirtyDaysAgo },
  });
}

// Format chat ID helper
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

module.exports = {
  fetchAndStoreSwaps,
  processStoredSwaps,
  cleanupOldSwaps,
};
