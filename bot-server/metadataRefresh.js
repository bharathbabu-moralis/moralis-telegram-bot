const axios = require("axios");
const TokenMetadata = require("./models/TokenMetadata");

async function refreshTokenMetadata() {
  console.log("Starting token metadata refresh...");

  const tokens = await TokenMetadata.find();

  for (const token of tokens) {
    try {
      const response = await axios.get(
        "https://deep-index.moralis.io/api/v2.2/erc20/metadata",
        {
          params: { chain: token.chain, addresses: [token.address] },
          headers: { "X-API-Key": process.env.MORALIS_API_KEY },
        }
      );

      const metadata = response.data[0];
      if (metadata) {
        token.fully_diluted_valuation = parseFloat(
          metadata.fully_diluted_valuation
        );
        token.last_updated = Date.now();
        await token.save();
        console.log(
          `Updated metadata for ${token.name} (${token.symbol}) on ${token.chain} chain.`
        );
      }
    } catch (error) {
      console.error(
        `Error refreshing metadata for ${token.address} on chain ${token.chain}:`,
        error.message
      );
    }
  }

  console.log("Token metadata refresh completed.");
}

module.exports = refreshTokenMetadata;
