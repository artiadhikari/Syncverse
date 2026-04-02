import { useEffect, useMemo, useRef, useState } from "react";
import io from "socket.io-client";
import YouTube from "react-youtube";
import "./App.css";

const socket = io("http://localhost:5000", {
  transports: ["websocket", "polling"],
  reconnection: true,
});

function App() {
  const [username, setUsername] = useState("");
  const [joined, setJoined] = useState(false);
  const [mode, setMode] = useState("");
  const [roomName, setRoomName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  const [message, setMessage] = useState("");
  const [chat, setChat] = useState([]);
  const [users, setUsers] = useState([]);

  const [videoId, setVideoId] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoStatusText, setVideoStatusText] = useState("Waiting for a video...");
  const [isSocketConnected, setIsSocketConnected] = useState(socket.connected);
  const [isVideoLoading, setIsVideoLoading] = useState(false);

  const playerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const isRemoteActionRef = useRef(false);
  const isPlayerReadyRef = useRef(false);
  const pendingRoomStateRef = useRef(null);
  const lastSyncSentAtRef = useRef(0);

  const isCurrentUserHost = useMemo(() => {
    return users.find((u) => u.username === username)?.isHost || false;
  }, [users, username]);

  const extractVideoId = (url) => {
    const regExp =
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
    const match = url.match(regExp);
    return match ? match[1] : "";
  };

  const resetRoomState = () => {
    setChat([]);
    setUsers([]);
    setMessage("");
    setVideoId("");
    setVideoUrl("");
    setIsVideoLoading(false);
    setVideoStatusText("Waiting for a video...");
    playerRef.current = null;
    isPlayerReadyRef.current = false;
    pendingRoomStateRef.current = null;
  };

  const createRoom = () => {
    const trimmedUsername = username.trim();
    const trimmedRoomName = roomName.trim();

    console.log("🟡 createRoom clicked", {
      trimmedUsername,
      trimmedRoomName,
      isPrivate,
      socketConnected: socket.connected,
    });

    if (!trimmedUsername || !trimmedRoomName) {
      alert("Please enter your name and room name.");
      return;
    }

    if (!socket.connected) {
      alert("Backend is not connected.");
      return;
    }

    resetRoomState();

    socket.emit("create_room", {
      username: trimmedUsername,
      roomName: trimmedRoomName,
      isPrivate,
    });
  };

  const joinRoom = () => {
    const trimmedUsername = username.trim();
    const trimmedInviteCode = inviteCode.trim().toUpperCase();
    const trimmedRoomId = roomId.trim();

    console.log("🟡 joinRoom clicked", {
      trimmedUsername,
      trimmedInviteCode,
      trimmedRoomId,
      socketConnected: socket.connected,
    });

    if (!trimmedUsername || (!trimmedInviteCode && !trimmedRoomId)) {
      alert("Please enter your name and invite code or room ID.");
      return;
    }

    if (!socket.connected) {
      alert("Backend is not connected.");
      return;
    }

    resetRoomState();

    socket.emit("join_room", {
      username: trimmedUsername,
      roomId: trimmedRoomId || undefined,
      inviteCode: trimmedInviteCode || undefined,
    });
  };

  const sendMessage = () => {
    if (!message.trim() || !roomId) return;

    socket.emit("send_message", {
      type: "user",
      roomId,
      author: username,
      message: message.trim(),
    });

    setMessage("");
  };

  const handleLoadVideo = () => {
    const trimmedUrl = videoUrl.trim();
    const extractedId = extractVideoId(trimmedUrl);

    if (!extractedId) {
      alert("Please paste a valid YouTube link.");
      return;
    }

    socket.emit("load_video", {
      roomId,
      videoId: extractedId,
      videoUrl: trimmedUrl,
      by: username,
    });

    setIsVideoLoading(true);
    setVideoId(extractedId);
    setVideoUrl("");
  };

  const copyInviteCode = async () => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      alert("Invite code copied!");
    } catch (error) {
      console.log(error);
    }
  };

  const applyRoomState = (state) => {
    if (!state || !state.videoId) return;

    if (!playerRef.current || !isPlayerReadyRef.current) {
      pendingRoomStateRef.current = state;
      return;
    }

    try {
      const targetTime = Number(state.currentTime) || 0;
      const shouldPlay = !!state.isPlaying;
      const current = playerRef.current.getCurrentTime?.() || 0;
      const diff = Math.abs(current - targetTime);

      isRemoteActionRef.current = true;

      if (diff > 1.5) {
        playerRef.current.seekTo?.(targetTime, true);
      }

      if (shouldPlay) {
        playerRef.current.playVideo?.();
      } else {
        playerRef.current.pauseVideo?.();
      }

      setTimeout(() => {
        isRemoteActionRef.current = false;
      }, 250);
    } catch (error) {
      console.log("applyRoomState error:", error);
    }
  };

  const onPlayerReady = (event) => {
    playerRef.current = event.target;
    isPlayerReadyRef.current = true;
    setIsVideoLoading(false);

    if (pendingRoomStateRef.current) {
      applyRoomState(pendingRoomStateRef.current);
      pendingRoomStateRef.current = null;
    }
  };

  const onPlay = () => {
    if (isRemoteActionRef.current) return;
    if (!isCurrentUserHost) return;

    const currentTime = playerRef.current?.getCurrentTime?.() || 0;
    socket.emit("play_video", { roomId, currentTime });
  };

  const onPause = () => {
    if (isRemoteActionRef.current) return;
    if (!isCurrentUserHost) return;

    const currentTime = playerRef.current?.getCurrentTime?.() || 0;
    socket.emit("pause_video", { roomId, currentTime });
  };

  const onStateChange = (event) => {
    if (!playerRef.current) return;
    if (isRemoteActionRef.current) return;
    if (!isCurrentUserHost) return;

    const currentTime = playerRef.current.getCurrentTime?.() || 0;

    if (event?.data !== 1 && event?.data !== 2) return;

    socket.emit("seek_video", { roomId, currentTime });
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  useEffect(() => {
    const syncInterval = setInterval(() => {
      if (!joined) return;
      if (!isCurrentUserHost) return;
      if (!playerRef.current) return;
      if (!videoId) return;

      const now = Date.now();
      if (now - lastSyncSentAtRef.current < 4000) return;

      lastSyncSentAtRef.current = now;

      const currentTime = playerRef.current.getCurrentTime?.() || 0;
      const playerState = playerRef.current.getPlayerState?.();
      const isPlaying = playerState === 1;

      socket.emit("sync_progress", {
        roomId,
        currentTime,
        isPlaying,
      });
    }, 2000);

    return () => clearInterval(syncInterval);
  }, [joined, isCurrentUserHost, videoId, roomId]);

  useEffect(() => {
    const handleConnect = () => {
      console.log("✅ frontend connected:", socket.id);
      setIsSocketConnected(true);
    };

    const handleDisconnect = () => {
      console.log("❌ frontend disconnected");
      setIsSocketConnected(false);
    };

    const handleConnectError = (err) => {
      console.log("❌ connect_error:", err.message);
      setIsSocketConnected(false);
    };

    const handleReceiveMessage = (data) => {
      setChat((prev) => [...prev, data]);
    };

    const handleRoomUsers = (usersList) => {
      setUsers(usersList || []);
    };

    const handleRoomState = (state) => {
      console.log("📺 room_state:", state);

      if (!state?.videoId) return;

      setVideoId(state.videoId);
      setVideoStatusText(
        isCurrentUserHost
          ? "You control the synced playback"
          : "Video playback is synced with the room"
      );

      applyRoomState(state);
    };

    const handleRoomCreated = (data) => {
      console.log("✅ room_created:", data);

      setJoined(true);
      setRoomId(data.roomId);
      setRoomName(data.roomName);
      setInviteCode(data.inviteCode || "");
      setVideoStatusText("Room created. You are the host.");
    };

    const handleRoomJoined = (data) => {
      console.log("✅ room_joined:", data);

      setJoined(true);
      setRoomId(data.roomId);
      setRoomName(data.roomName);
      setInviteCode(data.inviteCode || "");
      setVideoStatusText("Joined room successfully.");
    };

    const handleRoomMeta = (data) => {
      setRoomId(data.roomId || "");
      setRoomName(data.roomName || "");
      setInviteCode(data.inviteCode || "");
    };

    const handleRoomError = (err) => {
      console.log("❌ room_error:", err);
      alert(err?.message || "Something went wrong");
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("receive_message", handleReceiveMessage);
    socket.on("room_users", handleRoomUsers);
    socket.on("room_state", handleRoomState);
    socket.on("room_created", handleRoomCreated);
    socket.on("room_joined", handleRoomJoined);
    socket.on("room_meta", handleRoomMeta);
    socket.on("room_error", handleRoomError);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("receive_message", handleReceiveMessage);
      socket.off("room_users", handleRoomUsers);
      socket.off("room_state", handleRoomState);
      socket.off("room_created", handleRoomCreated);
      socket.off("room_joined", handleRoomJoined);
      socket.off("room_meta", handleRoomMeta);
      socket.off("room_error", handleRoomError);
    };
  }, [isCurrentUserHost]);

  return (
    <div className="app">
      {!joined ? (
        <div className="join-page">
          <div className="join-card panel">
            <h1 className="app-title">SyncVerse</h1>
            <p className="app-subtitle">
              Create a room, sync videos, and chat in real time.
            </p>

            

            <div className="join-form">
              <input
                className="theme-input"
                placeholder="Enter your name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />

              {!mode && (
                <div className="entry-actions">
                  <button className="theme-button" onClick={() => setMode("create")}>
                    Create Room
                  </button>
                  <button
                    className="theme-button secondary-button"
                    onClick={() => setMode("join")}
                  >
                    Join Room
                  </button>
                </div>
              )}

              {mode === "create" && (
                <>
                  <input
                    className="theme-input"
                    placeholder="Enter room name"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createRoom()}
                  />

                  <div className="privacy-toggle">
                    <button
                      className={isPrivate ? "toggle-btn active" : "toggle-btn"}
                      onClick={() => setIsPrivate(true)}
                    >
                      Private
                    </button>
                    <button
                      className={!isPrivate ? "toggle-btn active" : "toggle-btn"}
                      onClick={() => setIsPrivate(false)}
                    >
                      Public
                    </button>
                  </div>

                  <div className="entry-actions">
                    <button type="button" className="theme-button" onClick={createRoom}>
                      Create Now
                    </button>
                    <button
                      type="button"
                      className="theme-button secondary-button"
                      onClick={() => setMode("")}
                    >
                      Back
                    </button>
                  </div>
                </>
              )}

              {mode === "join" && (
                <>
                  <input
                    className="theme-input"
                    placeholder="Enter invite code or room ID"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                  />

                  <div className="entry-actions">
                    <button type="button" className="theme-button" onClick={joinRoom}>
                      Join Now
                    </button>
                    <button
                      type="button"
                      className="theme-button secondary-button"
                      onClick={() => setMode("")}
                    >
                      Back
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="room-layout">
          <aside className="left-sidebar panel">
            <div className="sidebar-top">
              <p className="sidebar-label">Room</p>
              <h2 className="sidebar-room">{roomName}</h2>
              <p className="sidebar-subtext">ID: {roomId}</p>
            </div>

            <div className="sidebar-block">
              <h3 className="sidebar-title">Invite</h3>
              <div className="invite-card">
                <p className="invite-label">Code</p>
                <div className="invite-row">
                  <span className="invite-code">{inviteCode || "Public room"}</span>
                  {!!inviteCode && (
                    <button className="copy-button" onClick={copyInviteCode}>
                      Copy
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="sidebar-block">
              <h3 className="sidebar-title">Online Users</h3>
              <div className="user-list">
                {users.map((user, i) => {
                  const isYou = user.username === username;

                  return (
                    <div key={i} className="user-card">
                      <div className="user-left">
                        <span className="online-dot"></span>
                        <div className="user-avatar">
                          {user.username?.charAt(0)?.toUpperCase() || "U"}
                        </div>
                        <div className="user-meta">
                          <span className="user-name">
                            {isYou ? `You (${user.username})` : user.username}
                          </span>
                          {user.isHost && <span className="host-badge">Host</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="center-panel panel">
            <div className="chat-header">
              <div className="chat-user-info">
                <div className="header-avatar">
                  {username?.charAt(0)?.toUpperCase() || "U"}
                </div>
                <div>
                  <h2>{roomName}</h2>
                  <p>{videoStatusText}</p>
                </div>
              </div>

              <div className="room-pill">
                {isCurrentUserHost ? "Host Room" : "Synced Room"}
              </div>
            </div>

            <div className="center-content">
              <div className="video-container panel-light">
                {isCurrentUserHost ? (
                  <div className="video-top">
                    <input
                      type="text"
                      placeholder="Paste YouTube link..."
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      className="video-input"
                    />
                    <button type="button" className="video-button" onClick={handleLoadVideo}>
                      Load
                    </button>
                  </div>
                ) : (
                  <div className="viewer-sync-banner">
                    Watching in synced mode • Only host controls playback
                  </div>
                )}

                {videoId ? (
                  <div className="video-player-wrapper">
                    <div className="video-player">
                      <YouTube
                        key={videoId}
                        videoId={videoId}
                        onReady={onPlayerReady}
                        onPlay={onPlay}
                        onPause={onPause}
                        onStateChange={onStateChange}
                        opts={{
                          width: "100%",
                          height: "100%",
                          playerVars: {
                            autoplay: 0,
                            controls: isCurrentUserHost ? 1 : 0,
                            disablekb: isCurrentUserHost ? 0 : 1,
                            modestbranding: 1,
                            rel: 0,
                            fs: isCurrentUserHost ? 1 : 0,
                          },
                        }}
                      />
                    </div>

                    {isVideoLoading && (
                      <div className="video-loading-overlay">
                        <div className="video-loading-content">
                          <div className="video-loading-spinner"></div>
                          <p>Loading video...</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="video-empty">
                    <div className="video-empty-icon">▶</div>
                    <h3>Load a YouTube video</h3>
                    <p>
                      {isCurrentUserHost
                        ? "Paste a link above and watch together in sync."
                        : "Waiting for the host to load a video."}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </main>

          <aside className="right-sidebar panel">
            <div className="right-top">
              <h3 className="sidebar-title">Live Chat</h3>
              <p className="chat-side-subtitle">Chat with everyone in the room</p>
            </div>

            <div className="chat-messages">
              {chat.map((msg, i) => {
                if (msg.type === "system") {
                  return (
                    <div key={i} className="system-row">
                      <div className="system-message">
                        {msg.message}
                        {msg.time ? ` • ${msg.time}` : ""}
                      </div>
                    </div>
                  );
                }

                const isMine = msg.author === username;

                return (
                  <div key={i} className={`message-row ${isMine ? "right" : "left"}`}>
                    <div className={`message-bubble ${isMine ? "mine" : "other"}`}>
                      <p className="message-author">
                        {isMine ? `You (${msg.author})` : msg.author}
                      </p>
                      <p className="message-text">{msg.message}</p>
                      {msg.time && <span className="message-time">{msg.time}</span>}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-wrap">
              <div className="chat-input-area">
                <input
                  className="message-input"
                  value={message}
                  placeholder="Type message..."
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                />
                <button
                  className="send-button"
                  onClick={sendMessage}
                  disabled={!message.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;