// services/tokenMetadataService.js
const axios = require("axios");
const GroupConfig = require("./models/GroupConfig");
const TokenMetadata = require("./models/TokenMetadata");

async function fetchTokenMetadata(address, chain) {
  try {
    const response = await axios.get(
      "https://deep-index.moralis.io/api/v2.2/erc20/metadata",
      {
        params: {
          chain,
          addresses: [address],
        },
        headers: { "X-API-Key": process.env.MORALIS_API_KEY },
      }
    );

    if (!response.data?.[0]) {
      throw new Error("Token metadata not found");
    }

    return response.data[0];
  } catch (error) {
    console.error("Error fetching token metadata:", error);
    throw error;
  }
}

async function updateTokenMetadata() {
  try {
    const activeTokens = await GroupConfig.aggregate([
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
        },
      },
    ]);

    console.log(`Updating metadata for ${activeTokens.length} tokens`);

    for (const token of activeTokens) {
      try {
        const metadata = await fetchTokenMetadata(
          token._id.address,
          token._id.chain
        );

        await TokenMetadata.findOneAndUpdate(
          {
            address: token._id.address,
            chain: token._id.chain,
          },
          {
            $set: {
              name: metadata.name,
              symbol: metadata.symbol,
              decimals: metadata.decimals,
              logo: metadata.logo,
              fully_diluted_valuation: metadata.fully_diluted_valuation,
              last_updated: new Date(),
            },
          },
          { upsert: true }
        );
      } catch (error) {
        console.error(
          `Failed to update metadata for ${token._id.address}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error("Error in updateTokenMetadata:", error);
  }
}

module.exports = {
  fetchTokenMetadata,
  updateTokenMetadata,
};
