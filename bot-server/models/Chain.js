const mongoose = require("mongoose");

const chainSchema = new mongoose.Schema({
  chain_name: { type: String, required: true }, // e.g., "ethereum"
  explorer_url: { type: String, required: true }, // e.g., "https://etherscan.io"
  chart_url_base: { type: String, required: true }, // e.g., "https://moralis.com/chain/ethereum/token/price/"
  swap_url_base: { type: String, required: true }, // e.g., "https://app.1inch.io/#/1/simple/swap/"
  chain_id: { type: Number, required: true }, // Chain ID, e.g., 1 for Ethereum
});

module.exports = mongoose.model("Chain", chainSchema);
