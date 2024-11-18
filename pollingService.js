// pollingService.js
const axios = require("axios");
const GroupConfig = require("./GroupConfig");
const SwapData = require("./SwapData");
const TokenMetadata = require("./TokenMetadata");
const Chain = require("./Chain");
const Queue = require("better-queue");

// Rate limit handler
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

// Create message queue
const messageQueue = new Queue(
  async function (task, cb) {
    const { bot, chatId, message, options } = task;

    try {
      // Check rate limit
      if (rateLimitHandler.shouldWait(chatId)) {
        const waitTime = rateLimitHandler.getWaitTime(chatId);
        throw new Error(
          `Rate limit in effect. Wait ${Math.ceil(waitTime / 1000)} seconds`
        );
      }

      await bot.sendMessage(chatId, message, options);
      cb(null); // Success
    } catch (error) {
      if (error.message.includes("Too Many Requests")) {
        // Extract retry time from error message
        const match = error.message.match(/retry after (\d+)/);
        const retrySeconds = match ? parseInt(match[1]) : 10;

        rateLimitHandler.setWaitTime(chatId, retrySeconds);

        // Requeue the message with delay
        setTimeout(() => {
          messageQueue.push(task);
        }, retrySeconds * 1000 + 100);

        cb(null); // Don't treat as error, just requeued
      } else {
        cb(error); // Real error
      }
    }
  },
  {
    concurrent: 1,
    maxRetries: 3,
    retryDelay: 1000,
  }
);

// Helper functions
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

// Fetch and store new swaps
async function fetchAndStoreSwaps() {
  try {
    const configs = await GroupConfig.find({
      "tracking.active": true,
      "tracking.token.address": { $exists: true },
    }).lean();

    console.log(`Fetching swaps for ${configs.length} active configurations`);

    for (const config of configs) {
      try {
        const { address: tokenAddress, chain } = config.tracking.token;

        // Get latest stored swap
        const latestSwap = await SwapData.findOne({
          tokenAddress,
          chain,
        })
          .sort({ block_timestamp: -1 })
          .lean();

        // Fetch new swaps
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

        if (!response.data?.result) continue;

        // Store new swaps
        const bulkOps = response.data.result.map((swap) => ({
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

        if (bulkOps.length > 0) {
          await SwapData.bulkWrite(bulkOps);
          console.log(
            `Stored ${bulkOps.length} new swaps for ${tokenAddress} on ${chain}`
          );
        }
      } catch (error) {
        console.error(
          `Error fetching swaps for token ${config.tracking.token.address}:`,
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
    // Get active token configurations
    const activeTokens = await GroupConfig.aggregate([
      {
        $match: {
          "tracking.active": true,
          "tracking.token.address": { $exists: true },
          "tracking.token.chain": { $exists: true },
          "tracking.startTime": { $exists: true }, // Make sure startTime exists
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

    console.log(`Processing ${activeTokens.length} token configurations`);

    for (const tokenGroup of activeTokens) {
      try {
        const { address, chain } = tokenGroup._id;

        // Get unprocessed swaps
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

        // Process each swap
        for (const swapData of unprocessedSwaps) {
          try {
            const swap = swapData.swap_data;
            const swapTimestamp = new Date(swap.block_timestamp);
            const notifications = [];

            // Calculate swap amounts
            const swapAmount = Math.abs(
              swap.transaction_type === "buy"
                ? swap.token1.usd_amount // Amount spent in USD for buys
                : swap.token0.usd_amount // Amount received in USD for sells
            );

            // Check criteria for each config
            for (const config of tokenGroup.configs) {
              try {
                // Skip if swap is before tracking start time
                if (
                  config.tracking.startTime &&
                  swapTimestamp < new Date(config.tracking.startTime)
                ) {
                  continue;
                }

                const { minValue, transactionType } = config.tracking.filters;

                // Check minimum value
                const meetsMinValue = swapAmount >= minValue;
                if (!meetsMinValue) {
                  console.log(
                    `Swap amount ${swapAmount} below minimum ${minValue} for ${config.name}`
                  );
                  continue;
                }

                // Check transaction type
                const matchesTransactionType =
                  transactionType === "both" ||
                  (transactionType === "buy" &&
                    swap.transaction_type === "buy") ||
                  (transactionType === "sell" &&
                    swap.transaction_type === "sell");

                if (!matchesTransactionType) {
                  console.log(
                    `Transaction type ${swap.transaction_type} doesn't match filter ${transactionType} for ${config.name}`
                  );
                  continue;
                }

                // All criteria met
                notifications.push(config);
                console.log(
                  `Notification queued for ${config.name} - Amount: ${swapAmount}, Type: ${swap.transaction_type}`
                );
              } catch (configError) {
                console.error(
                  `Error checking criteria for ${config.name}:`,
                  configError
                );
                continue;
              }
            }

            if (notifications.length > 0) {
              // Prepare message template
              const messageTemplate = await prepareMessageTemplate(
                swap,
                chainInfo,
                address
              );

              // Send notifications with rate limiting
              for (const config of notifications) {
                try {
                  await sendNotification(bot, config, messageTemplate);

                  // Record successful notification
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
                    `Failed to send notification to ${config.name}:`,
                    error
                  );

                  // Record failed notification
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

                // Add delay between notifications
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }

            // Mark swap as processed
            await SwapData.updateOne(
              { _id: swapData._id },
              {
                $set: {
                  processed: true,
                  processedAt: new Date(),
                },
              }
            );
          } catch (swapError) {
            console.error(
              `Error processing swap ${swapData.transaction_hash}:`,
              swapError
            );
            continue;
          }
        }
      } catch (tokenError) {
        console.error(
          `Error processing token ${tokenGroup._id.address}:`,
          tokenError
        );
        continue;
      }
    }
  } catch (error) {
    console.error("Error in processStoredSwaps:", error);
  }
}

async function prepareMessageTemplate(swap, chainInfo, trackedTokenAddress) {
  const isBuyTransaction = swap.transaction_type === "buy";

  // Determine which token is the one we're tracking
  const trackedTokenIsToken0 =
    swap.token0.address.toLowerCase() === trackedTokenAddress.toLowerCase();
  const trackedToken = trackedTokenIsToken0 ? swap.token0 : swap.token1;

  // Get proper token price
  const price = trackedToken.usd_price.toFixed(2);

  // For notification formatting
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
    price, // This is now the tracked token's price
    wallet: swap.wallet_address,
    urls: {
      explorer: chainInfo.explorer_url,
      tx: swap.transaction_hash,
      chart: `${chainInfo.chart_url_base}${trackedTokenAddress}`,
    },
  };
}

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

  // Queue the message instead of sending directly
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
            // Update last active only on successful send
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

// Cleanup function
async function cleanupOldSwaps() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  await SwapData.deleteMany({
    processed: true,
    processedAt: { $lt: thirtyDaysAgo },
  });
}

// Export functions
module.exports = {
  fetchAndStoreSwaps,
  processStoredSwaps,
  cleanupOldSwaps,
};
