const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const roomUsers = {};
const roomState = {};

// ---------- HELPERS ----------
const getRoomUsers = (room) => roomUsers[room] || [];

const getRoomState = (room) => roomState[room] || null;

const findUserInRoom = (room, socketId) => {
  return getRoomUsers(room).find((user) => user.socketId === socketId);
};

const isHostUser = (room, socketId) => {
  const user = findUserInRoom(room, socketId);
  return !!user?.isHost;
};

const emitRoomUsers = (room) => {
  io.to(room).emit("room_users", getRoomUsers(room));
};

const emitSystemMessage = (room, message) => {
  io.to(room).emit("receive_message", {
    type: "system",
    message,
    time: new Date().toLocaleTimeString(),
  });
};

const makeFirstUserHostIfNeeded = (room) => {
  if (!roomUsers[room] || roomUsers[room].length === 0) return;

  const hasHost = roomUsers[room].some((user) => user.isHost);
  if (!hasHost) {
    roomUsers[room][0].isHost = true;
  }
};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ---------- JOIN ROOM ----------
  socket.on("join_room", (data) => {
    try {
      const room = data?.room?.trim();
      const username = data?.username?.trim();

      if (!room || !username) return;

      socket.join(room);
      socket.room = room;
      socket.username = username;

      if (!roomUsers[room]) {
        roomUsers[room] = [];
      }

      const isHost = roomUsers[room].length === 0;

      roomUsers[room].push({
        socketId: socket.id,
        username,
        isHost,
      });

      emitRoomUsers(room);
      emitSystemMessage(room, `${username} joined the room`);

      // Send saved room state to only the newly joined user
      const savedState = getRoomState(room);

      if (savedState) {
        socket.emit("video_loaded", {
          videoId: savedState.videoId,
          videoUrl: savedState.videoUrl,
        });

        socket.emit("seek_video", {
          currentTime: savedState.currentTime || 0,
        });

        if (savedState.isPlaying) {
          socket.emit("play_video", {
            currentTime: savedState.currentTime || 0,
          });
        } else {
          socket.emit("pause_video", {
            currentTime: savedState.currentTime || 0,
          });
        }
      }
    } catch (error) {
      console.log("join_room error:", error);
    }
  });

  // ---------- LOAD VIDEO (HOST ONLY) ----------
  socket.on("load_video", (data) => {
    try {
      const room = data?.room;
      const videoId = data?.videoId;
      const videoUrl = data?.videoUrl;
      const by = data?.by;

      if (!room || !videoId || !videoUrl) return;
      if (!isHostUser(room, socket.id)) return;

      roomState[room] = {
        videoId,
        videoUrl,
        currentTime: 0,
        isPlaying: false,
      };

      io.to(room).emit("video_loaded", {
        videoId,
        videoUrl,
        by,
      });

      io.to(room).emit("seek_video", {
        currentTime: 0,
      });

      emitSystemMessage(room, `${by || "Host"} loaded a new video`);
    } catch (error) {
      console.log("load_video error:", error);
    }
  });

  // ---------- PLAY VIDEO (HOST ONLY) ----------
  socket.on("play_video", ({ room, currentTime = 0 }) => {
    try {
      if (!room) return;
      if (!isHostUser(room, socket.id)) return;

      if (roomState[room]) {
        roomState[room].isPlaying = true;
        roomState[room].currentTime = currentTime;
      }

    socket.to(room).emit("play_video", {
  currentTime,
  timestamp: Date.now(),
});
    } catch (error) {
      console.log("play_video error:", error);
    }
  });

  // ---------- PAUSE VIDEO (HOST ONLY) ----------
  socket.on("pause_video", ({ room, currentTime = 0 }) => {
    try {
      if (!room) return;
      if (!isHostUser(room, socket.id)) return;

      if (roomState[room]) {
        roomState[room].isPlaying = false;
        roomState[room].currentTime = currentTime;
      }

      socket.to(room).emit("pause_video", {
  currentTime,
  timestamp: Date.now(), 
});
    } catch (error) {
      console.log("pause_video error:", error);
    }
  });

  // ---------- SEEK VIDEO (HOST ONLY) ----------
  socket.on("seek_video", ({ room, currentTime = 0 }) => {
    try {
      if (!room) return;
      if (!isHostUser(room, socket.id)) return;

      const safeTime = Number(currentTime) || 0;

      if (roomState[room]) {
        roomState[room].currentTime = safeTime;
      }

      socket.to(room).emit("seek_video", { currentTime: safeTime });
    } catch (error) {
      console.log("seek_video error:", error);
    }
  });

  // ---------- SEND MESSAGE ----------
  socket.on("send_message", (data) => {
    try {
      const room = data?.room;
      const message = data?.message?.trim();
      const author = data?.author?.trim();

      if (!room || !message || !author) return;

      const messageData = {
        ...data,
        message,
        author,
        time: new Date().toLocaleTimeString(),
      };

      io.to(room).emit("receive_message", messageData);
    } catch (error) {
      console.log("send_message error:", error);
    }
  });

  // ---------- DISCONNECT ----------
  socket.on("disconnect", () => {
    try {
      const room = socket.room;
      const username = socket.username;

      if (!room || !roomUsers[room]) {
        console.log("User disconnected:", socket.id);
        return;
      }

      const leavingUser = findUserInRoom(room, socket.id);
      const wasHost = !!leavingUser?.isHost;

      roomUsers[room] = roomUsers[room].filter(
        (user) => user.socketId !== socket.id
      );

      if (roomUsers[room].length > 0) {
        makeFirstUserHostIfNeeded(room);
      }

      emitRoomUsers(room);

      if (username) {
        emitSystemMessage(room, `${username} left the room`);
      }

      if (wasHost && roomUsers[room]?.length > 0) {
        const newHost = roomUsers[room].find((user) => user.isHost);
        if (newHost) {
          emitSystemMessage(room, `${newHost.username} is now the host`);
        }
      }

      if (roomUsers[room].length === 0) {
        delete roomUsers[room];
        delete roomState[room];
      }

      console.log("User disconnected:", socket.id);
    } catch (error) {
      console.log("disconnect error:", error);
    }
  });
});

server.listen(5000, () => {
  console.log("Server running on port 5000");
});