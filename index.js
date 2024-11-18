// src/index.js
require("dotenv").config();
const express = require("express");
const app = express();
const bot = require("./bot");

// Basic route to keep the app alive
app.get("/", (req, res) => {
  res.send("Bot is running!");
});

// Error handling
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  bot
    .stopPolling()
    .then(() => process.exit(1))
    .catch(() => process.exit(1));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
