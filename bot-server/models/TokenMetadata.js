const mongoose = require("mongoose");

const tokenMetadataSchema = new mongoose.Schema({
  address: { type: String, required: true },
  chain: { type: String, required: true }, // New field to store the chain
  name: { type: String, required: true },
  symbol: { type: String, required: true },
  decimals: { type: Number, required: true },
  logo: { type: String },
  fully_diluted_valuation: { type: Number },
  last_updated: { type: Date, default: Date.now },
});

tokenMetadataSchema.index({ address: 1, chain: 1 }, { unique: true }); // Ensure unique combination of address and chain

module.exports = mongoose.model("TokenMetadata", tokenMetadataSchema);
