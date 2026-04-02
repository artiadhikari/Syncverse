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

const generateRoomId = () => `room_${Math.random().toString(36).slice(2, 10)}`;
const generateInviteCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const getRoomUsers = (roomId) => roomUsers[roomId] || [];
const getRoomMeta = (roomId) => rooms[roomId] || null;

const findUserInRoom = (roomId, socketId) => {
  return getRoomUsers(roomId).find((user) => user.socketId === socketId);
};

const findRoomByInviteCode = (inviteCode) => {
  if (!inviteCode) return null;
  return Object.values(rooms).find(
    (room) => room.inviteCode === inviteCode.trim().toUpperCase()
  );
};

const findPublicRoomByName = (roomName) => {
  if (!roomName) return null;
  return Object.values(rooms).find(
    (room) =>
      !room.isPrivate &&
      room.roomName.trim().toLowerCase() === roomName.trim().toLowerCase()
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
    inviteCode: room.isPrivate ? room.inviteCode : "",
    isPrivate: room.isPrivate,
    hostUsername: room.hostUsername,
  });
};

const emitSystemMessage = (roomId, message) => {
  io.to(roomId).emit("receive_message", {
    type: "system",
    message,
    time: new Date().toLocaleTimeString(),
  });
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
  io.to(roomId).emit("room_state", state);
};

const emitRoomStateToOthers = async (roomId, socket) => {
  const state = await getRoomState(roomId);
  if (!state) return;
  socket.to(roomId).emit("room_state", state);
};

const syncRoomHosts = async (roomId) => {
  const room = getRoomMeta(roomId);
  const users = getRoomUsers(roomId);

  if (!room || !users.length) return;

  let hostUsername = room.hostUsername;

  const hostStillExists = users.some((u) => u.username === hostUsername);

  if (!hostStillExists) {
    hostUsername = users[0].username;
    rooms[roomId].hostUsername = hostUsername;
    await updateRoomState(roomId, { hostUsername });
  }

  roomUsers[roomId] = users.map((user) => ({
    ...user,
    isHost: user.username === hostUsername,
  }));
};

const isHostUser = async (roomId, socketId) => {
  const room = getRoomMeta(roomId);
  const user = findUserInRoom(roomId, socketId);

  if (!room || !user) return false;
  return room.hostUsername === user.username;
};

const leaveCurrentRoomIfAny = async (socket) => {
  const oldRoomId = socket.roomId;
  const oldUsername = socket.username;

  if (!oldRoomId || !roomUsers[oldRoomId]) return;

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
    delete roomUsers[oldRoomId];
    delete rooms[oldRoomId];
  }

  socket.roomId = null;
  socket.username = null;
};

const joinUserToRoom = async ({ socket, roomId, username }) => {
  await leaveCurrentRoomIfAny(socket);

  socket.join(roomId);
  socket.roomId = roomId;
  socket.username = username;

  if (!roomUsers[roomId]) {
    roomUsers[roomId] = [];
  }

  const existingIndex = roomUsers[roomId].findIndex(
    (user) => user.username === username
  );

  if (existingIndex !== -1) {
    roomUsers[roomId][existingIndex].socketId = socket.id;
  } else {
    roomUsers[roomId].push({
      socketId: socket.id,
      username,
      isHost: false,
    });
  }

  const existingState = await getRoomState(roomId);

  if (!existingState) {
    await replaceRoomState(roomId, {
      hostUsername: rooms[roomId]?.hostUsername || username,
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
  socket.emit("room_state", latestState || {});
};

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("create_room", async (data) => {
    console.log("📩 create_room received:", data);

    try {
      const username = data?.username?.trim();
      const roomName = data?.roomName?.trim();
      const isPrivate = !!data?.isPrivate;

      if (!username || !roomName) {
        socket.emit("room_error", {
          message: "Username and room name are required",
        });
        return;
      }

      if (!isPrivate) {
        const existingPublicRoom = findPublicRoomByName(roomName);
        if (existingPublicRoom) {
          socket.emit("room_error", {
            message: "A public room with this name already exists",
          });
          return;
        }
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
        isPrivate,
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

      console.log("✅ room created successfully:", roomId);

      socket.emit("room_created", {
        roomId,
        roomName,
        inviteCode: isPrivate ? inviteCode : "",
        isPrivate,
        hostUsername: username,
      });

      emitSystemMessage(roomId, `${username} created the room`);
    } catch (error) {
      console.log("❌ create_room error:", error);
      socket.emit("room_error", {
        message: "Failed to create room",
      });
    }
  });

  socket.on("join_room", async (data) => {
    console.log("📩 join_room received:", data);

    try {
      const username = data?.username?.trim();
      const roomIdInput = data?.roomId?.trim();
      const inviteCodeInput = data?.inviteCode?.trim()?.toUpperCase();
      const roomNameInput = data?.roomName?.trim();

      if (!username) {
        socket.emit("room_error", {
          message: "Username is required",
        });
        return;
      }

      let room = null;

      if (roomIdInput && rooms[roomIdInput]) {
        room = rooms[roomIdInput];
      } else if (inviteCodeInput) {
        room = findRoomByInviteCode(inviteCodeInput);
      } else if (roomNameInput) {
        room = findPublicRoomByName(roomNameInput);
      }

      if (!room) {
        socket.emit("room_error", {
          message: "Room not found",
        });
        return;
      }

      if (room.isPrivate && !inviteCodeInput && !roomIdInput) {
        socket.emit("room_error", {
          message: "Invite code is required for private room",
        });
        return;
      }

      if (
        room.isPrivate &&
        inviteCodeInput &&
        room.inviteCode !== inviteCodeInput
      ) {
        socket.emit("room_error", {
          message: "Invalid invite code",
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
        inviteCode: room.isPrivate ? room.inviteCode : "",
        isPrivate: room.isPrivate,
        hostUsername: room.hostUsername,
      });

      emitSystemMessage(room.roomId, `${username} joined the room}`);
    } catch (error) {
      console.log("❌ join_room error:", error);
      socket.emit("room_error", {
        message: "Failed to join room",
      });
    }
  });

  socket.on("load_video", async (data) => {
    try {
      const roomId = data?.roomId?.trim();
      const videoId = data?.videoId?.trim();
      const videoUrl = data?.videoUrl?.trim();
      const by = data?.by?.trim();

      if (!roomId || !videoId || !videoUrl) return;
      if (!(await isHostUser(roomId, socket.id))) return;

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
      emitSystemMessage(roomId, `${by || "Host"} loaded a new video`);
    } catch (error) {
      console.log("load_video error:", error);
    }
  });

  socket.on("play_video", async ({ roomId, currentTime = 0 }) => {
    try {
      const safeRoomId = roomId?.trim();
      if (!safeRoomId) return;
      if (!(await isHostUser(safeRoomId, socket.id))) return;

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
      const safeRoomId = roomId?.trim();
      if (!safeRoomId) return;
      if (!(await isHostUser(safeRoomId, socket.id))) return;

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
      const safeRoomId = roomId?.trim();
      if (!safeRoomId) return;
      if (!(await isHostUser(safeRoomId, socket.id))) return;

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
      const safeRoomId = roomId?.trim();
      if (!safeRoomId) return;
      if (!(await isHostUser(safeRoomId, socket.id))) return;

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
      const roomId = data?.roomId?.trim();
      const message = data?.message?.trim();
      const author = data?.author?.trim();

      if (!roomId || !message || !author) return;

      io.to(roomId).emit("receive_message", {
        type: "user",
        roomId,
        author,
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