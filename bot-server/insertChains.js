const mongoose = require("mongoose");
const Chain = require("./models/Chain"); // Assuming Chain model is in `models/Chain.js`
require("dotenv").config();

async function insertChainData() {
  const chains = [
    {
      chain_name: "eth",
      explorer_url: "https://etherscan.io",
      chart_url_base: "https://moralis.com/chain/ethereum/token/price/",
      swap_url_base: "https://app.1inch.io/#/1/simple/swap/",
      chain_id: 1,
    },
    {
      chain_name: "base",
      explorer_url: "https://basescan.org",
      chart_url_base: "https://moralis.com/chain/base/token/price/",
      swap_url_base: "https://app.1inch.io/#/8453/simple/swap/",
      chain_id: 8453,
    },
    {
      chain_name: "bsc",
      explorer_url: "https://bscscan.com",
      chart_url_base: "https://moralis.com/chain/bsc/token/price/",
      swap_url_base: "https://app.1inch.io/#/56/simple/swap/",
      chain_id: 56,
    },
    {
      chain_name: "avalanche",
      explorer_url: "https://snowtrace.io",
      chart_url_base: "https://moralis.com/chain/avalanche/token/price/",
      swap_url_base: "https://app.1inch.io/#/43114/simple/swap/",
      chain_id: 43114,
    },
    {
      chain_name: "polygon",
      explorer_url: "https://polygonscan.com",
      chart_url_base: "https://moralis.com/chain/polygon/token/price/",
      swap_url_base: "https://app.1inch.io/#/137/simple/swap/",
      chain_id: 137,
    },
    {
      chain_name: "optimism",
      explorer_url: "https://optimistic.etherscan.io",
      chart_url_base: "https://moralis.com/chain/optimism/token/price/",
      swap_url_base: "https://app.1inch.io/#/10/simple/swap/",
      chain_id: 10,
    },
    {
      chain_name: "arbitrum",
      explorer_url: "https://arbiscan.io",
      chart_url_base: "https://moralis.com/chain/arbitrum/token/price/",
      swap_url_base: "https://app.1inch.io/#/42161/simple/swap/",
      chain_id: 42161,
    },
    {
      chain_name: "linea",
      explorer_url: "https://lineascan.build",
      chart_url_base: "https://moralis.com/chain/linea/token/price/",
      swap_url_base: "https://app.1inch.io/#/59144/simple/swap/",
      chain_id: 59144,
    },
  ];

  try {
    await Chain.insertMany(chains);
    console.log("Chain data inserted successfully");
  } catch (error) {
    console.error("Error inserting chain data:", error);
  }
}

mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to MongoDB");
    return insertChainData();
  })
  .then(() => mongoose.disconnect())
  .catch((error) => {
    console.error("MongoDB connection error:", error);
  });
