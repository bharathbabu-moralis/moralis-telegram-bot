const mongoose = require("mongoose");

const UserGroupConfigSchema = new mongoose.Schema({
  user_id: { type: Number, required: true },
  group_id: { type: Number, required: true },
  group_name: { type: String, required: true },
});

module.exports = mongoose.model("UserGroupConfig", UserGroupConfigSchema);
