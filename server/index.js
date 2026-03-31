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

const roomUsers = {}; // stores users in each room

io.on("connection", (socket) => {
  console.log("User connected:", socket.id); // when user connects

  // when user joins a room
  socket.on("join_room", (data) => {
    const { room, username } = data;

    socket.join(room); // add user to room
    socket.room = room; // save room on socket
    socket.username = username; // save username on socket

    // create room array if not exists
    if (!roomUsers[room]) {
      roomUsers[room] = [];
    }

    // add user to room list
    roomUsers[room].push({
      socketId: socket.id,
      username: username,
    });

    console.log(`${username} joined room ${room}`);

    // send updated users list to everyone in room
    io.to(room).emit("room_users", roomUsers[room]);

    // send join system message to everyone in room
    io.to(room).emit("receive_message", {
      type: "system", // system message
      message: `${username} joined the room`,
    });
  });

  // when user sends a normal message
  socket.on("send_message", (data) => {
    console.log("Message received:", data);

    // send message to other users in same room
    socket.to(data.room).emit("receive_message", data);
  });

  // when user disconnects
  socket.on("disconnect", () => {
    const room = socket.room;
    const username = socket.username;

    if (room && roomUsers[room]) {
      // remove disconnected user from room list
      roomUsers[room] = roomUsers[room].filter(
        (user) => user.socketId !== socket.id
      );

      console.log(`${username} disconnected from room ${room}`);

      // send updated users list
      io.to(room).emit("room_users", roomUsers[room]);

      // send leave system message
      io.to(room).emit("receive_message", {
        type: "system", // system message
        message: `${username} left the room`,
      });
    }

    console.log("User disconnected");
  });
});

server.listen(5000, () => {
  console.log("Server running on port 5000");
});