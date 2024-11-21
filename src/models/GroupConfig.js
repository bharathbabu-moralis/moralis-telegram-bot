// models/GroupConfig.js

const mongoose = require("mongoose");

// Define valid chains constant
const VALID_CHAINS = [
  "eth",
  "bsc",
  "polygon",
  "avax",
  "arbitrum",
  "base",
  "linea",
  "optimism",
];

const groupConfigSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["group", "channel"],
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    chatId: {
      type: String,
      required: true,
      index: true,
    },
    admin_id: {
      type: String,
      required: true,
      index: true,
    },
    isPublic: {
      type: Boolean,
      default: false,
    },
    username: String,
    numeric_id: String,
    tracking: {
      active: {
        type: Boolean,
        default: false,
        index: true,
      },
      startTime: Date,
      token: {
        address: {
          type: String,
          index: true,
          // Optional: Add validation for ETH address format
          validate: {
            validator: function (v) {
              return v === undefined || /^0x[a-fA-F0-9]{40}$/.test(v);
            },
            message: (props) => `${props.value} is not a valid token address!`,
          },
        },
        chain: {
          type: String,
          enum: VALID_CHAINS, // Updated to include all supported chains
          index: true,
        },
      },
      filters: {
        minValue: {
          type: Number,
          min: 0, // Ensure minimum value is not negative
        },
        transactionType: {
          type: String,
          enum: ["buy", "sell", "both"],
        },
      },
    },
    customization: {
      emoji: {
        type: String,
        default: "⚡️",
      },
      customLinks: [
        {
          text: String,
          url: String,
          active: {
            type: Boolean,
            default: true,
          },
        },
      ],
    },
    metadata: {
      createdAt: {
        type: Date,
        default: Date.now,
      },
      lastUpdated: {
        type: Date,
        default: Date.now,
      },
      lastActive: Date,
    },
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt
  }
);

// Add compound indexes for better query performance
groupConfigSchema.index({
  "tracking.token.address": 1,
  "tracking.token.chain": 1,
});
groupConfigSchema.index({ admin_id: 1, "tracking.active": 1 });

// Pre-save middleware to update lastUpdated
groupConfigSchema.pre("save", function (next) {
  this.metadata.lastUpdated = new Date();
  next();
});

// Helper method to check if configuration is complete
groupConfigSchema.methods.isConfigured = function () {
  return !!(
    this.tracking?.token?.address &&
    this.tracking?.token?.chain &&
    this.tracking?.filters?.minValue !== undefined &&
    this.tracking?.filters?.transactionType
  );
};

// Helper method to get missing configurations
groupConfigSchema.methods.getMissingConfigs = function () {
  const missing = [];
  if (!this.tracking?.token?.address) missing.push("Token Address");
  if (!this.tracking?.token?.chain) missing.push("Chain");
  if (this.tracking?.filters?.minValue === undefined)
    missing.push("Minimum Value");
  if (!this.tracking?.filters?.transactionType)
    missing.push("Transaction Type");
  return missing;
};

const GroupConfig = mongoose.model("GroupConfig", groupConfigSchema);

module.exports = GroupConfig;
