
require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const connectDB = require("./config/db");
const PlaybackState = require("./models/PlaybackState");
const Room = require("./models/Room"); 

const app = express();

// FIX: lock CORS to CLIENT_URL in production; fall back to * only in dev
const allowedOrigin =
  process.env.NODE_ENV === "production"
    ? process.env.CLIENT_URL || false
    : "*";

app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

connectDB();

app.get("/api/health", (req, res) => {
  res.send("SyncVerse server is running");
});

const clientBuildPath = path.join(__dirname, "..", "client", "build");
if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientBuildPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
  });
}

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"],
  },
});

// ---------- In-memory caches (backed by MongoDB) ----------
// rooms      : roomId → room meta (roomId, roomName, inviteCode, hostUsername, createdAt)
// roomUsers  : roomId → [{ socketId, username, isHost }]
// These are populated from DB on demand and kept in sync with every mutation.
const rooms = {};
const roomUsers = {};

// ---------- Input constants ----------
const MAX_USERNAME   = 64;
const MAX_ROOM_NAME  = 64;
const MAX_MESSAGE    = 500;
const MAX_VIDEO_URL  = 2048;
// FIX: YouTube video IDs are exactly 11 chars: [a-zA-Z0-9_-]
const YT_ID_RE       = /^[a-zA-Z0-9_-]{11}$/;

// ---------- Rate limiting ----------
// Simple per-socket token bucket: MAX_EVENTS events per WINDOW_MS window.
// Exceeding it drops the event silently.
const RATE_WINDOW_MS = 5000;
const MAX_EVENTS     = 30; // generous for sync traffic; tighten if needed
const socketEventLog = new Map(); // socketId → [timestamp, ...]

const isRateLimited = (socketId) => {
  const now = Date.now();
  const log = (socketEventLog.get(socketId) || []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  log.push(now);
  socketEventLog.set(socketId, log);
  return log.length > MAX_EVENTS;
};

const clearRateLog = (socketId) => socketEventLog.delete(socketId);

// ---------- Helpers ----------
const generateRoomId    = () => `room_${Math.random().toString(36).slice(2, 10)}`;
const generateInviteCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const safeTrim  = (value) => (typeof value === "string" ? value.trim() : "");
const safeUpper = (value) => safeTrim(value).toUpperCase();

// FIX: clamp and validate currentTime before writing to DB
const safeTime = (value) => {
  const n = Number(value);
  return isFinite(n) && n >= 0 ? n : 0;
};

const getRoomMeta  = (roomId) => rooms[roomId] || null;
const getRoomUsers = (roomId) => roomUsers[roomId] || [];

const findUserInRoomBySocket   = (roomId, socketId) =>
  getRoomUsers(roomId).find((u) => u.socketId === socketId);

const findUserInRoomByUsername = (roomId, username) =>
  getRoomUsers(roomId).find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );

const findRoomByInviteCode = (inviteCode) => {
  if (!inviteCode) return null;
  return Object.values(rooms).find((r) => r.inviteCode === safeUpper(inviteCode));
};

const emitRoomUsers = (roomId) =>
  io.to(roomId).emit("room_users", getRoomUsers(roomId));

const emitRoomMeta = (roomId) => {
  const room = getRoomMeta(roomId);
  if (!room) return;
  io.to(roomId).emit("room_meta", {
    roomId:      room.roomId,
    roomName:    room.roomName,
    inviteCode:  room.inviteCode,
    hostUsername: room.hostUsername,
  });
};

const getTimestamp = () =>
  new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const emitSystemMessage = (roomId, message) =>
  io.to(roomId).emit("receive_message", {
    type: "system",
    message,
    time: getTimestamp(),
  });

const emitHostChanged = (roomId, hostUsername) =>
  io.to(roomId).emit("host_changed", { hostUsername });

const createRoomState = ({
  hostUsername = "",
  videoId      = "",
  videoUrl     = "",
  currentTime  = 0,
  isPlaying    = false,
} = {}) => ({
  hostUsername,
  videoId,
  videoUrl,
  currentTime: safeTime(currentTime),
  isPlaying:   !!isPlaying,
  updatedAt:   new Date(),
});

const getRoomState = async (roomId) =>
  await PlaybackState.findOne({ room: roomId }).lean();

const replaceRoomState = async (roomId, state = {}) => {
  const payload = { room: roomId, ...createRoomState(state) };
  return await PlaybackState.findOneAndUpdate(
    { room: roomId },
    { $set: payload },
    { new: true, upsert: true }
  ).lean();
};

const updateRoomState = async (roomId, updates = {}) => {
  const payload = {
    ...(updates.hostUsername !== undefined && { hostUsername: updates.hostUsername }),
    ...(updates.videoId      !== undefined && { videoId:      updates.videoId }),
    ...(updates.videoUrl     !== undefined && { videoUrl:     updates.videoUrl }),
    ...(updates.currentTime  !== undefined && { currentTime:  safeTime(updates.currentTime) }),
    ...(updates.isPlaying    !== undefined && { isPlaying:    !!updates.isPlaying }),
    updatedAt: new Date(),
  };
  return await PlaybackState.findOneAndUpdate(
    { room: roomId },
    { $set: payload, $setOnInsert: { room: roomId } },
    { new: true, upsert: true }
  ).lean();
};

const emitRoomStateToRoom = async (roomId) => {
  const state = await getRoomState(roomId);
  if (!state) return;
  io.to(roomId).emit("room_state", { ...state, sentAt: Date.now() });
};

const emitRoomStateToOthers = async (roomId, socket) => {
  const state = await getRoomState(roomId);
  if (!state) return;
  socket.to(roomId).emit("room_state", { ...state, sentAt: Date.now() });
};

const isHostUser = (roomId, socketId) => {
  const room = getRoomMeta(roomId);
  const user = findUserInRoomBySocket(roomId, socketId);
  if (!room || !user) return false;
  return room.hostUsername === user.username;
};

const syncRoomHosts = async (roomId) => {
  const room  = getRoomMeta(roomId);
  const users = getRoomUsers(roomId);
  if (!room) return;

  if (!users.length) {
    room.hostUsername = "";
    await updateRoomState(roomId, { hostUsername: "" });
    return;
  }

  let { hostUsername } = room;
  const hostStillExists = users.some((u) => u.username === hostUsername);

  if (!hostStillExists) {
    hostUsername = users[0].username;
    rooms[roomId].hostUsername = hostUsername;
    await updateRoomState(roomId, { hostUsername });
    // FIX: also persist to Room document
    await Room.findOneAndUpdate({ roomId }, { hostUsername });

    emitHostChanged(roomId, hostUsername);
    emitSystemMessage(roomId, `${hostUsername} is now the host`);
  }

  roomUsers[roomId] = users.map((u) => ({
    ...u,
    isHost: u.username === hostUsername,
  }));
};

// FIX: persist room meta to MongoDB so it survives a server restart
const persistRoom = async (roomData) => {
  await Room.findOneAndUpdate(
    { roomId: roomData.roomId },
    { $set: roomData },
    { new: true, upsert: true }
  );
};

// FIX: load room meta from MongoDB into the in-memory cache on demand
const hydrateRoomFromDB = async (roomId) => {
  if (rooms[roomId]) return rooms[roomId]; // already cached
  const doc = await Room.findOne({ roomId }).lean();
  if (!doc) return null;
  rooms[roomId] = {
    roomId:       doc.roomId,
    roomName:     doc.roomName,
    inviteCode:   doc.inviteCode,
    hostUsername: doc.hostUsername,
    createdAt:    doc.createdAt,
  };
  if (!roomUsers[roomId]) roomUsers[roomId] = [];
  return rooms[roomId];
};

const cleanupRoomIfEmpty = async (roomId) => {
  const users = getRoomUsers(roomId);
  if (users.length > 0) return;

  delete roomUsers[roomId];
  delete rooms[roomId];

  try {
    await PlaybackState.deleteOne({ room: roomId });
    await Room.deleteOne({ roomId }); // FIX: also remove from Room collection
  } catch (error) {
    console.log("cleanupRoomIfEmpty error:", error);
  }
};

const leaveCurrentRoomIfAny = async (socket) => {
  const oldRoomId   = socket.roomId;
  const oldUsername = socket.username;

  if (!oldRoomId || !roomUsers[oldRoomId]) {
    socket.roomId   = null;
    socket.username = null;
    return;
  }

  socket.leave(oldRoomId);

  roomUsers[oldRoomId] = roomUsers[oldRoomId].filter(
    (u) => u.socketId !== socket.id
  );

  if (roomUsers[oldRoomId].length > 0) {
    await syncRoomHosts(oldRoomId);
    emitRoomUsers(oldRoomId);
    emitRoomMeta(oldRoomId);
    if (oldUsername) emitSystemMessage(oldRoomId, `${oldUsername} left the room`);
  } else {
    await cleanupRoomIfEmpty(oldRoomId);
  }

  socket.roomId   = null;
  socket.username = null;
};

const joinUserToRoom = async ({ socket, roomId, username }) => {
  await leaveCurrentRoomIfAny(socket);

  const normalizedUsername = safeTrim(username);
  if (!normalizedUsername) throw new Error("Username is required");

  // FIX: try to hydrate from DB in case the in-memory cache was wiped
  await hydrateRoomFromDB(roomId);

  socket.join(roomId);
  socket.roomId   = roomId;
  socket.username = normalizedUsername;

  if (!roomUsers[roomId]) roomUsers[roomId] = [];

  const existingUser = findUserInRoomByUsername(roomId, normalizedUsername);
  if (existingUser) throw new Error("Username already taken in this room");

  roomUsers[roomId].push({
    socketId: socket.id,
    username: normalizedUsername,
    isHost:   false,
  });

  const existingState = await getRoomState(roomId);
  if (!existingState) {
    await replaceRoomState(roomId, {
      hostUsername: rooms[roomId]?.hostUsername || normalizedUsername,
      videoId:      "",
      videoUrl:     "",
      currentTime:  0,
      isPlaying:    false,
    });
  }

  await syncRoomHosts(roomId);
  emitRoomUsers(roomId);
  emitRoomMeta(roomId);

  const latestState = await getRoomState(roomId);
  socket.emit(
    "room_state",
    latestState ? { ...latestState, sentAt: Date.now() } : {}
  );
};

// ---------- Socket ----------
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("create_room", async (data) => {
    if (isRateLimited(socket.id)) return;
    try {
      const username = safeTrim(data?.username);
      const roomName = safeTrim(data?.roomName);

      // FIX: server-side length validation
      if (!username || username.length > MAX_USERNAME) {
        socket.emit("room_error", { message: "Invalid username" });
        return;
      }
      if (!roomName || roomName.length > MAX_ROOM_NAME) {
        socket.emit("room_error", { message: "Invalid room name" });
        return;
      }

      let roomId = generateRoomId();
      while (rooms[roomId]) roomId = generateRoomId();

      let inviteCode = generateInviteCode();
      while (findRoomByInviteCode(inviteCode)) inviteCode = generateInviteCode();

      const roomMeta = {
        roomId,
        roomName,
        inviteCode,
        hostUsername: username,
        createdAt:    new Date(),
      };

      rooms[roomId]     = roomMeta;
      roomUsers[roomId] = [];

      // FIX: persist to DB immediately
      await persistRoom(roomMeta);

      await replaceRoomState(roomId, {
        hostUsername: username,
        videoId:      "",
        videoUrl:     "",
        currentTime:  0,
        isPlaying:    false,
      });

      await joinUserToRoom({ socket, roomId, username });

      socket.emit("room_created", { roomId, roomName, inviteCode, hostUsername: username });
      emitSystemMessage(roomId, `${username} created the room`);
    } catch (error) {
      console.log("❌ create_room error:", error);
      socket.emit("room_error", { message: error.message || "Failed to create room" });
    }
  });

  socket.on("join_room", async (data) => {
    if (isRateLimited(socket.id)) return;
    try {
      const username       = safeTrim(data?.username);
      const roomIdInput    = safeTrim(data?.roomId);
      const inviteCodeInput = safeUpper(data?.inviteCode);

      // FIX: length check
      if (!username || username.length > MAX_USERNAME) {
        socket.emit("room_error", { message: "Invalid username" });
        return;
      }

      let room = null;

      if (inviteCodeInput) {
        room = findRoomByInviteCode(inviteCodeInput);
        // FIX: if not in memory, try DB (handles server restart)
        if (!room) {
          const doc = await Room.findOne({ inviteCode: inviteCodeInput }).lean();
          if (doc) {
            room = doc;
            rooms[doc.roomId] = doc;
            if (!roomUsers[doc.roomId]) roomUsers[doc.roomId] = [];
          }
        }
      } else if (roomIdInput) {
        room = rooms[roomIdInput];
        if (!room) room = await hydrateRoomFromDB(roomIdInput);
      }

      if (!room) {
        socket.emit("room_error", { message: "Room not found" });
        return;
      }

      await joinUserToRoom({ socket, roomId: room.roomId, username });

      socket.emit("room_joined", {
        roomId:       room.roomId,
        roomName:     room.roomName,
        inviteCode:   room.inviteCode,
        hostUsername: room.hostUsername,
      });

      emitSystemMessage(room.roomId, `${username} joined the room`);
    } catch (error) {
      console.log("❌ join_room error:", error);
      socket.emit("room_error", { message: error.message || "Failed to join room" });
    }
  });

  socket.on("transfer_host", async (data) => {
    if (isRateLimited(socket.id)) return;
    try {
      const roomId         = safeTrim(data?.roomId);
      const targetUsername = safeTrim(data?.targetUsername);

      if (!roomId || !targetUsername) {
        socket.emit("room_error", { message: "Invalid host transfer request" });
        return;
      }
      if (!isHostUser(roomId, socket.id)) {
        socket.emit("room_error", { message: "Only host can transfer host" });
        return;
      }

      const room = getRoomMeta(roomId);
      if (!room) { socket.emit("room_error", { message: "Room not found" }); return; }

      const targetUser = findUserInRoomByUsername(roomId, targetUsername);
      if (!targetUser) {
        socket.emit("room_error", { message: "Selected user not found in room" });
        return;
      }
      if (room.hostUsername === targetUser.username) {
        socket.emit("room_error", { message: "This user is already the host" });
        return;
      }

      rooms[roomId].hostUsername = targetUser.username;
      await updateRoomState(roomId, { hostUsername: targetUser.username });
      await Room.findOneAndUpdate({ roomId }, { hostUsername: targetUser.username });
      await syncRoomHosts(roomId);

      emitRoomUsers(roomId);
      emitRoomMeta(roomId);
      emitHostChanged(roomId, targetUser.username);
      emitSystemMessage(roomId, `${targetUser.username} is now the host`);
    } catch (error) {
      console.log("transfer_host error:", error);
      socket.emit("room_error", { message: error.message || "Failed to transfer host" });
    }
  });

  socket.on("load_video", async (data) => {
    if (isRateLimited(socket.id)) return;
    try {
      const roomId   = safeTrim(data?.roomId);
      const videoId  = safeTrim(data?.videoId);
      const videoUrl = safeTrim(data?.videoUrl);
      const by       = safeTrim(data?.by);

      if (!roomId || !videoId || !videoUrl) return;
      if (!isHostUser(roomId, socket.id)) return;

      // FIX: validate YouTube video ID format before writing to DB
      if (!YT_ID_RE.test(videoId)) {
        socket.emit("room_error", { message: "Invalid YouTube video ID" });
        return;
      }
      // FIX: length cap on URL
      if (videoUrl.length > MAX_VIDEO_URL) {
        socket.emit("room_error", { message: "Video URL too long" });
        return;
      }

      const room = getRoomMeta(roomId);
      if (!room) return;

      await replaceRoomState(roomId, {
        hostUsername: room.hostUsername || by || "",
        videoId,
        videoUrl,
        currentTime:  0,
        isPlaying:    false,
      });

      await emitRoomStateToRoom(roomId);
      setTimeout(async () => { await emitRoomStateToRoom(roomId); }, 1200);
      emitSystemMessage(roomId, `${by || "Host"} loaded a new video`);
    } catch (error) {
      console.log("load_video error:", error);
    }
  });

  socket.on("play_video", async ({ roomId, currentTime = 0 }) => {
    if (isRateLimited(socket.id)) return;
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId || !isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, { currentTime: safeTime(currentTime), isPlaying: true });
      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("play_video error:", error);
    }
  });

  socket.on("pause_video", async ({ roomId, currentTime = 0 }) => {
    if (isRateLimited(socket.id)) return;
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId || !isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, { currentTime: safeTime(currentTime), isPlaying: false });
      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("pause_video error:", error);
    }
  });

  socket.on("seek_video", async ({ roomId, currentTime = 0 }) => {
    if (isRateLimited(socket.id)) return;
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId || !isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, { currentTime: safeTime(currentTime) });
      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("seek_video error:", error);
    }
  });

  socket.on("sync_progress", async ({ roomId, currentTime = 0, isPlaying = false }) => {
    // FIX: sync_progress has its own lighter rate limit (1 per 3.5s per host)
    // We don't run it through the global bucket to avoid evicting legit events.
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId || !isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, { currentTime: safeTime(currentTime), isPlaying });
      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("sync_progress error:", error);
    }
  });

  socket.on("send_message", (data) => {
    if (isRateLimited(socket.id)) return;
    try {
      const roomId  = safeTrim(data?.roomId);
      const message = safeTrim(data?.message);

      if (!roomId || !message) return;
      // FIX: server-side length guard
      if (message.length > MAX_MESSAGE) return;

      const room = getRoomMeta(roomId);
      if (!room) return;

      const user = findUserInRoomBySocket(roomId, socket.id);
      if (!user) return;

      io.to(roomId).emit("receive_message", {
        type:    "user",
        roomId,
        author:  user.username,
        message,
        time:    getTimestamp(),
      });
    } catch (error) {
      console.log("send_message error:", error);
    }
  });

  socket.on("leave_room", async () => {
    try {
      await leaveCurrentRoomIfAny(socket);
    } catch (error) {
      console.log("leave_room error:", error);
    }
  });

  socket.on("kick_user", async (data) => {
    if (isRateLimited(socket.id)) return;
    try {
      const roomId         = safeTrim(data?.roomId);
      const targetUsername = safeTrim(data?.targetUsername);

      if (!roomId || !targetUsername) {
        socket.emit("room_error", { message: "Invalid kick request" });
        return;
      }
      if (!isHostUser(roomId, socket.id)) {
        socket.emit("room_error", { message: "Only host can kick users" });
        return;
      }

      const room = getRoomMeta(roomId);
      if (!room) { socket.emit("room_error", { message: "Room not found" }); return; }

      const targetUser = findUserInRoomByUsername(roomId, targetUsername);
      if (!targetUser) {
        socket.emit("room_error", { message: "Selected user not found in room" });
        return;
      }
      if (targetUser.username === room.hostUsername) {
        socket.emit("room_error", { message: "Host cannot be kicked" });
        return;
      }

      const targetSocket = io.sockets.sockets.get(targetUser.socketId);
      if (targetSocket) {
        targetSocket.emit("kicked_from_room", { username: targetUser.username });
        await leaveCurrentRoomIfAny(targetSocket);
      }

      emitSystemMessage(roomId, `${targetUser.username} was removed from the room`);
    } catch (error) {
      console.log("kick_user error:", error);
      socket.emit("room_error", { message: error.message || "Failed to kick user" });
    }
  });

  socket.on("disconnect", async () => {
    try {
      await leaveCurrentRoomIfAny(socket);
      clearRateLog(socket.id); // FIX: clean up rate-limit memory on disconnect
      console.log("❌ User disconnected:", socket.id);
    } catch (error) {
      console.log("disconnect error:", error);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

