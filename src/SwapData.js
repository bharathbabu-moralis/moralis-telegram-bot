const mongoose = require("mongoose");

const swapSchema = new mongoose.Schema(
  {
    tokenAddress: {
      type: String,
      required: true,
      index: true,
    },
    chain: {
      type: String,
      required: true,
      index: true,
    },
    transaction_hash: {
      type: String,
      required: true,
      unique: true,
    },
    block_timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    swap_data: {
      type: Object,
      required: true,
    },
    processed: {
      type: Boolean,
      default: false,
      index: true,
    },
    processedAt: Date,
    notifications: [
      {
        chatId: String,
        sentAt: Date,
        success: Boolean,
        error: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

swapSchema.index({ tokenAddress: 1, chain: 1, processed: 1 });

module.exports = mongoose.model("SwapData", swapSchema);
