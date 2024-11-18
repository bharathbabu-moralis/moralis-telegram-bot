require("dotenv").config();
const express = require("express");
const app = express();

try {
  const bot = require("./bot");
  console.log("Bot loaded successfully");
} catch (error) {
  console.error("Error loading bot:", error);
  process.exit(1);
}

app.get("/", (req, res) => res.send("Bot Running"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
