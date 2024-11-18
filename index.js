require("dotenv").config();
const bot = require("bot");

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  // Attempt to gracefully shutdown
  bot
    .stopPolling()
    .then(() => process.exit(1))
    .catch(() => process.exit(1));
});
