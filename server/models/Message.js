const mongoose = require("mongoose");

const playbackStateSchema = new mongoose.Schema(
  {
    room: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    hostUsername: {
      type: String,
      default: "",
      trim: true,
    },
    videoId: {
      type: String,
      default: "",
      trim: true,
    },
    videoUrl: {
      type: String,
      default: "",
      trim: true,
    },
    currentTime: {
      type: Number,
      default: 0,
    },
    isPlaying: {
      type: Boolean,
      default: false,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
);

module.exports = mongoose.model("PlaybackState", playbackStateSchema);