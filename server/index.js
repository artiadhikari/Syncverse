require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const connectDB = require("./config/db");
const PlaybackState = require("./models/PlaybackState");

const app = express();
app.use(cors());
app.use(express.json());

connectDB();

app.get("/", (req, res) => {
  res.send("SyncVerse server is running");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const rooms = {};
const roomUsers = {};

// ---------- Helpers ----------

const generateRoomId = () => `room_${Math.random().toString(36).slice(2, 10)}`;
const generateInviteCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const safeTrim = (value) => (typeof value === "string" ? value.trim() : "");
const safeUpper = (value) => safeTrim(value).toUpperCase();

const getRoomMeta = (roomId) => rooms[roomId] || null;
const getRoomUsers = (roomId) => roomUsers[roomId] || [];

const findUserInRoomBySocket = (roomId, socketId) => {
  return getRoomUsers(roomId).find((user) => user.socketId === socketId);
};

const findUserInRoomByUsername = (roomId, username) => {
  return getRoomUsers(roomId).find(
    (user) => user.username.toLowerCase() === username.toLowerCase()
  );
};

const findRoomByInviteCode = (inviteCode) => {
  if (!inviteCode) return null;

  return Object.values(rooms).find(
    (room) => room.inviteCode === safeUpper(inviteCode)
  );
};

const emitRoomUsers = (roomId) => {
  io.to(roomId).emit("room_users", getRoomUsers(roomId));
};

const emitRoomMeta = (roomId) => {
  const room = getRoomMeta(roomId);
  if (!room) return;

  io.to(roomId).emit("room_meta", {
    roomId: room.roomId,
    roomName: room.roomName,
    inviteCode: room.inviteCode,
    hostUsername: room.hostUsername,
  });
};

const emitSystemMessage = (roomId, message) => {
  io.to(roomId).emit("receive_message", {
    type: "system",
    message,
    time: new Date().toLocaleTimeString([],{
      hour: "numeric",
  minute: "2-digit",

    }),
  });
};

const emitHostChanged = (roomId, hostUsername) => {
  io.to(roomId).emit("host_changed", { hostUsername });
};

const createRoomState = ({
  hostUsername = "",
  videoId = "",
  videoUrl = "",
  currentTime = 0,
  isPlaying = false,
} = {}) => ({
  hostUsername,
  videoId,
  videoUrl,
  currentTime: Number(currentTime) || 0,
  isPlaying: !!isPlaying,
  updatedAt: new Date(),
});

const getRoomState = async (roomId) => {
  return await PlaybackState.findOne({ room: roomId }).lean();
};

const replaceRoomState = async (roomId, state = {}) => {
  const payload = {
    room: roomId,
    ...createRoomState(state),
  };

  return await PlaybackState.findOneAndUpdate(
    { room: roomId },
    { $set: payload },
    { new: true, upsert: true }
  ).lean();
};

const updateRoomState = async (roomId, updates = {}) => {
  const payload = {
    ...(updates.hostUsername !== undefined && {
      hostUsername: updates.hostUsername,
    }),
    ...(updates.videoId !== undefined && { videoId: updates.videoId }),
    ...(updates.videoUrl !== undefined && { videoUrl: updates.videoUrl }),
    ...(updates.currentTime !== undefined && {
      currentTime: Number(updates.currentTime) || 0,
    }),
    ...(updates.isPlaying !== undefined && {
      isPlaying: !!updates.isPlaying,
    }),
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
  io.to(roomId).emit("room_state", {
    ...state,
    sentAt: Date.now(), 
  });
};

const emitRoomStateToOthers = async (roomId, socket) => {
  const state = await getRoomState(roomId);
  if (!state) return;
  socket.to(roomId).emit("room_state", {
     ...state,
    sentAt: Date.now(),
  });
};

const isHostUser = (roomId, socketId) => {
  const room = getRoomMeta(roomId);
  const user = findUserInRoomBySocket(roomId, socketId);

  if (!room || !user) return false;
  return room.hostUsername === user.username;
};

const syncRoomHosts = async (roomId) => {
  const room = getRoomMeta(roomId);
  const users = getRoomUsers(roomId);

  if (!room) return;

  if (!users.length) {
    room.hostUsername = "";
    await updateRoomState(roomId, { hostUsername: "" });
    return;
  }

  let hostUsername = room.hostUsername;
  const hostStillExists = users.some((user) => user.username === hostUsername);

  if (!hostStillExists) {
    hostUsername = users[0].username;
    rooms[roomId].hostUsername = hostUsername;
    await updateRoomState(roomId, { hostUsername });

    emitHostChanged(roomId, hostUsername);
    emitSystemMessage(roomId, `${hostUsername} is now the host`);
  }

  roomUsers[roomId] = users.map((user) => ({
    ...user,
    isHost: user.username === hostUsername,
  }));
};

const cleanupRoomIfEmpty = async (roomId) => {
  const users = getRoomUsers(roomId);

  if (users.length > 0) return;

  delete roomUsers[roomId];
  delete rooms[roomId];

  try {
    await PlaybackState.deleteOne({ room: roomId });
  } catch (error) {
    console.log("cleanupRoomIfEmpty error:", error);
  }
};

const leaveCurrentRoomIfAny = async (socket) => {
  const oldRoomId = socket.roomId;
  const oldUsername = socket.username;

  if (!oldRoomId || !roomUsers[oldRoomId]) {
    socket.roomId = null;
    socket.username = null;
    return;
  }

  socket.leave(oldRoomId);

  roomUsers[oldRoomId] = roomUsers[oldRoomId].filter(
    (user) => user.socketId !== socket.id
  );

  if (roomUsers[oldRoomId].length > 0) {
    await syncRoomHosts(oldRoomId);
    emitRoomUsers(oldRoomId);
    emitRoomMeta(oldRoomId);

    if (oldUsername) {
      emitSystemMessage(oldRoomId, `${oldUsername} left the room`);
    }
  } else {
    await cleanupRoomIfEmpty(oldRoomId);
  }

  socket.roomId = null;
  socket.username = null;
};

const joinUserToRoom = async ({ socket, roomId, username }) => {
  await leaveCurrentRoomIfAny(socket);

  const normalizedUsername = safeTrim(username);
  if (!normalizedUsername) {
    throw new Error("Username is required");
  }

  socket.join(roomId);
  socket.roomId = roomId;
  socket.username = normalizedUsername;

  if (!roomUsers[roomId]) {
    roomUsers[roomId] = [];
  }

  const existingUser = findUserInRoomByUsername(roomId, normalizedUsername);

  if (existingUser) {
    throw new Error("Username already taken in this room");
  }

  roomUsers[roomId].push({
    socketId: socket.id,
    username: normalizedUsername,
    isHost: false,
  });

  const existingState = await getRoomState(roomId);

  if (!existingState) {
    await replaceRoomState(roomId, {
      hostUsername: rooms[roomId]?.hostUsername || normalizedUsername,
      videoId: "",
      videoUrl: "",
      currentTime: 0,
      isPlaying: false,
    });
  }

  await syncRoomHosts(roomId);
  emitRoomUsers(roomId);
  emitRoomMeta(roomId);

const latestState = await getRoomState(roomId);
socket.emit("room_state", latestState ? { ...latestState, sentAt: Date.now() } : {});
};

// ---------- Socket ----------

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("create_room", async (data) => {
    try {
      const username = safeTrim(data?.username);
      const roomName = safeTrim(data?.roomName);

      if (!username || !roomName) {
        socket.emit("room_error", {
          message: "Username and room name are required",
        });
        return;
      }

      let roomId = generateRoomId();
      while (rooms[roomId]) {
        roomId = generateRoomId();
      }

      let inviteCode = generateInviteCode();
      while (findRoomByInviteCode(inviteCode)) {
        inviteCode = generateInviteCode();
      }

      rooms[roomId] = {
        roomId,
        roomName,
        inviteCode,
        hostUsername: username,
        createdAt: new Date(),
      };

      roomUsers[roomId] = [];

      await replaceRoomState(roomId, {
        hostUsername: username,
        videoId: "",
        videoUrl: "",
        currentTime: 0,
        isPlaying: false,
      });

      await joinUserToRoom({
        socket,
        roomId,
        username,
      });

      socket.emit("room_created", {
        roomId,
        roomName,
        inviteCode,
        hostUsername: username,
      });

      emitSystemMessage(roomId, `${username} created the room`);
    } catch (error) {
      console.log("❌ create_room error:", error);
      socket.emit("room_error", {
        message: error.message || "Failed to create room",
      });
    }
  });

  socket.on("join_room", async (data) => {
    try {
      const username = safeTrim(data?.username);
      const roomIdInput = safeTrim(data?.roomId);
      const inviteCodeInput = safeUpper(data?.inviteCode);

      if (!username) {
        socket.emit("room_error", {
          message: "Username is required",
        });
        return;
      }

      let room = null;

      if (inviteCodeInput) {
        room = findRoomByInviteCode(inviteCodeInput);
      } else if (roomIdInput && rooms[roomIdInput]) {
        room = rooms[roomIdInput];
      }

      if (!room) {
        socket.emit("room_error", {
          message: "Room not found",
        });
        return;
      }

      await joinUserToRoom({
        socket,
        roomId: room.roomId,
        username,
      });

      socket.emit("room_joined", {
        roomId: room.roomId,
        roomName: room.roomName,
        inviteCode: room.inviteCode,
        hostUsername: room.hostUsername,
      });

      emitSystemMessage(room.roomId, `${username} joined the room`);
    } catch (error) {
      console.log("❌ join_room error:", error);
      socket.emit("room_error", {
        message: error.message || "Failed to join room",
      });
    }
  });

  socket.on("transfer_host", async (data) => {
    try {
      const roomId = safeTrim(data?.roomId);
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
      if (!room) {
        socket.emit("room_error", { message: "Room not found" });
        return;
      }

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
      await syncRoomHosts(roomId);

      emitRoomUsers(roomId);
      emitRoomMeta(roomId);
      emitHostChanged(roomId, targetUser.username);
      emitSystemMessage(roomId, `${targetUser.username} is now the host`);
    } catch (error) {
      console.log("transfer_host error:", error);
      socket.emit("room_error", {
        message: error.message || "Failed to transfer host",
      });
    }
  });

  socket.on("load_video", async (data) => {
    try {
      const roomId = safeTrim(data?.roomId);
      const videoId = safeTrim(data?.videoId);
      const videoUrl = safeTrim(data?.videoUrl);
      const by = safeTrim(data?.by);

      if (!roomId || !videoId || !videoUrl) return;
      if (!isHostUser(roomId, socket.id)) return;

      const room = getRoomMeta(roomId);
      if (!room) return;

      await replaceRoomState(roomId, {
        hostUsername: room.hostUsername || by || "",
        videoId,
        videoUrl,
        currentTime: 0,
        isPlaying: false,
      });

      await emitRoomStateToRoom(roomId);
      setTimeout(async () => {
  await emitRoomStateToRoom(roomId);
}, 1200);
      emitSystemMessage(roomId, `${by || "Host"} loaded a new video`);
    } catch (error) {
      console.log("load_video error:", error);
    }
  });

  socket.on("play_video", async ({ roomId, currentTime = 0 }) => {
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId) return;
      if (!isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, {
        currentTime,
        isPlaying: true,
      });

      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("play_video error:", error);
    }
  });

  socket.on("pause_video", async ({ roomId, currentTime = 0 }) => {
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId) return;
      if (!isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, {
        currentTime,
        isPlaying: false,
      });

      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("pause_video error:", error);
    }
  });

  socket.on("seek_video", async ({ roomId, currentTime = 0 }) => {
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId) return;
      if (!isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, {
        currentTime,
      });

      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("seek_video error:", error);
    }
  });

  socket.on("sync_progress", async ({ roomId, currentTime = 0, isPlaying = false }) => {
    try {
      const safeRoomId = safeTrim(roomId);
      if (!safeRoomId) return;
      if (!isHostUser(safeRoomId, socket.id)) return;

      await updateRoomState(safeRoomId, {
        currentTime,
        isPlaying,
      });

      await emitRoomStateToOthers(safeRoomId, socket);
    } catch (error) {
      console.log("sync_progress error:", error);
    }
  });

  socket.on("send_message", (data) => {
    try {
      const roomId = safeTrim(data?.roomId);
      const message = safeTrim(data?.message);

      if (!roomId || !message) return;

      const room = getRoomMeta(roomId);
      if (!room) return;

      const user = findUserInRoomBySocket(roomId, socket.id);
      if (!user) return;

      io.to(roomId).emit("receive_message", {
        type: "user",
        roomId,
        author: user.username,
        message,
        time: new Date().toLocaleTimeString(),
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
  try {
    const roomId = safeTrim(data?.roomId);
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
    if (!room) {
      socket.emit("room_error", { message: "Room not found" });
      return;
    }

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
    socket.emit("room_error", {
      message: error.message || "Failed to kick user",
    });
  }
});

  socket.on("disconnect", async () => {
    try {
      await leaveCurrentRoomIfAny(socket);
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