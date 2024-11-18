require("dotenv").config();
const bot = require("./bot");

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

// For Heroku - keep alive
const http = require("http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running\n");
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`HTTP server running on port ${port}`);
});
