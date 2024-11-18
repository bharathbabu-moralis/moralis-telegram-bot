const mongoose = require("mongoose");

const deliveredMessageSchema = new mongoose.Schema({
  chatId: {
    type: String,
    required: true,
  },
  transaction_hash: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

deliveredMessageSchema.index(
  { chatId: 1, transaction_hash: 1 },
  { unique: true }
);

module.exports = mongoose.model("DeliveredMessage", deliveredMessageSchema);
