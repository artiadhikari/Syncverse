

const mongoose = require("mongoose");

const RoomSchema = new mongoose.Schema({
  roomId:       { type: String, required: true, unique: true, index: true },
  roomName:     { type: String, required: true },
  inviteCode:   { type: String, required: true, index: true },
  hostUsername: { type: String, default: "" },
  createdAt:    { type: Date,   default: Date.now },
});

module.exports = mongoose.model("Room", RoomSchema);
