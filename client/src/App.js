import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import "./App.css";
import YouTube from "react-youtube";

const socket = io("http://localhost:5000");

function App() {
  const [username, setUsername] = useState("");
  const [room, setRoom] = useState("");
  const [joined, setJoined] = useState(false);
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState([]);
  const [users, setUsers] = useState([]);
  const [videoId, setVideoId] = useState("");
  const [videoUrl, setVideoUrl] = useState("");

  const messagesEndRef = useRef(null);
  const playerRef = useRef(null);
  const lastTimeRef = useRef(0);
  const isRemoteActionRef = useRef(false);

  // Keeps the latest synced playback state received from host/server
  const syncStateRef = useRef({
    currentTime: 0,
    isPlaying: false,
    syncedAt: Date.now(),
  });

  const extractVideoId = (url) => {
    const regExp =
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
    const match = url.match(regExp);
    return match ? match[1] : "";
  };

  const isCurrentUserHost = users.find((u) => u.username === username)?.isHost;

  const updateSyncState = (currentTime, isPlaying) => {
    const safeTime = typeof currentTime === "number" ? currentTime : 0;

    lastTimeRef.current = safeTime;
    syncStateRef.current = {
      currentTime: safeTime,
      isPlaying,
      syncedAt: Date.now(),
    };
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  // Viewer-side drift correction
  useEffect(() => {
    const interval = setInterval(() => {
      if (!playerRef.current) return;
      if (isCurrentUserHost) return;

      const now = Date.now();
      const { currentTime, isPlaying, syncedAt } = syncStateRef.current;

      const targetTime = isPlaying
        ? currentTime + (now - syncedAt) / 1000
        : currentTime;

      const actualTime = playerRef.current.getCurrentTime?.() || 0;
      const diff = Math.abs(actualTime - targetTime);

      try {
        if (isPlaying) {
          // Pull back if viewer drifts too far while playing
          if (diff > 1) {
            isRemoteActionRef.current = true;
            playerRef.current.seekTo(targetTime, true);
          }

          // If viewer is somehow paused/stuck, force playback
          playerRef.current.playVideo?.();
        } else {
          // When paused, keep exact paused frame synced
          if (diff > 0.5) {
            isRemoteActionRef.current = true;
            playerRef.current.seekTo(targetTime, true);
          }

          playerRef.current.pauseVideo?.();
        }
      } catch (error) {
        console.log("Continuous sync error:", error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isCurrentUserHost]);

  const joinRoom = () => {
    const trimmedUsername = username.trim();
    const trimmedRoom = room.trim();

    if (!trimmedUsername || !trimmedRoom) {
      alert("Please enter your name and room name.");
      return;
    }

    socket.emit("join_room", {
      room: trimmedRoom,
      username: trimmedUsername,
    });

    setUsername(trimmedUsername);
    setRoom(trimmedRoom);
    setJoined(true);
  };

  const sendMessage = () => {
    if (!message.trim()) return;

    const messageData = {
      type: "user",
      room,
      author: username,
      message: message.trim(),
    };

    socket.emit("send_message", messageData);
    setMessage("");
  };

  const handleLoadVideo = () => {
    const extractedId = extractVideoId(videoUrl.trim());

    if (!extractedId) {
      alert("Please paste a valid YouTube link.");
      return;
    }

    setVideoId(extractedId);

    // Reset local sync state for newly loaded video
    updateSyncState(0, false);

    socket.emit("load_video", {
      room,
      videoId: extractedId,
      videoUrl: videoUrl.trim(),
      by: username,
    });

    setVideoUrl("");
  };

  const onPlayerReady = (event) => {
    playerRef.current = event.target;
  };

  const onPlay = () => {
    if (isRemoteActionRef.current) {
      isRemoteActionRef.current = false;
      return;
    }

    if (!isCurrentUserHost) return;

    const currentTime = playerRef.current?.getCurrentTime?.() || 0;
    updateSyncState(currentTime, true);
    socket.emit("play_video", { room, currentTime });
  };

  const onPause = () => {
    if (isRemoteActionRef.current) {
      isRemoteActionRef.current = false;
      return;
    }

    if (!isCurrentUserHost) return;

    const currentTime = playerRef.current?.getCurrentTime?.() || 0;
    updateSyncState(currentTime, false);
    socket.emit("pause_video", { room, currentTime });
  };

  const onStateChange = () => {
    if (isRemoteActionRef.current) return;
    if (!isCurrentUserHost) return;
    if (!playerRef.current) return;

    const currentTime = playerRef.current.getCurrentTime?.() || 0;
    const diff = Math.abs(currentTime - lastTimeRef.current);

    // Treat big time jump as seek by host
    if (diff > 2) {
      updateSyncState(currentTime, syncStateRef.current.isPlaying);
      socket.emit("seek_video", { room, currentTime });
    }

    lastTimeRef.current = currentTime;
  };

  useEffect(() => {
    const handleReceiveMessage = (data) => {
      setChat((prev) => [...prev, data]);
    };

    const handleRoomUsers = (usersList) => {
      setUsers(usersList);
    };

    const handleSeekVideo = ({ currentTime }) => {
      try {
        updateSyncState(currentTime, syncStateRef.current.isPlaying);
        isRemoteActionRef.current = true;
        playerRef.current?.seekTo?.(currentTime, true);
      } catch (error) {
        console.log("Seek sync error:", error);
      }
    };

    const handleVideoLoaded = (data) => {
      if (data?.videoId) {
        setVideoId(data.videoId);
        updateSyncState(0, false);
      }
    };

    const handlePlayVideo = ({ currentTime, timestamp }) => {
  try {
    // 🔥 calculate delay
    const latency = (Date.now() - (timestamp || Date.now())) / 1000;

    const adjustedTime = currentTime + latency;

    updateSyncState(adjustedTime, true);

    isRemoteActionRef.current = true;

    playerRef.current?.seekTo?.(adjustedTime, true);
    playerRef.current?.playVideo?.();
  } catch (error) {
    console.log("Play sync error:", error);
  }
};

  const handlePauseVideo = ({ currentTime, timestamp }) => {
  try {
    const latency = (Date.now() - (timestamp || Date.now())) / 1000;
    const adjustedTime = currentTime + latency;

    updateSyncState(adjustedTime, false);

    isRemoteActionRef.current = true;

    playerRef.current?.seekTo?.(adjustedTime, true);
    playerRef.current?.pauseVideo?.();
  } catch (error) {
    console.log("Pause sync error:", error);
  }
};

    socket.on("receive_message", handleReceiveMessage);
    socket.on("room_users", handleRoomUsers);
    socket.on("video_loaded", handleVideoLoaded);
    socket.on("play_video", handlePlayVideo);
    socket.on("pause_video", handlePauseVideo);
    socket.on("seek_video", handleSeekVideo);

    return () => {
      socket.off("receive_message", handleReceiveMessage);
      socket.off("room_users", handleRoomUsers);
      socket.off("video_loaded", handleVideoLoaded);
      socket.off("play_video", handlePlayVideo);
      socket.off("pause_video", handlePauseVideo);
      socket.off("seek_video", handleSeekVideo);
    };
  }, []);

  return (
    <div className="app">
      <div className="bg-orb orb1"></div>
      <div className="bg-orb orb2"></div>
      <div className="bg-orb orb3"></div>

      {!joined ? (
        <div className="join-page">
          <div className="join-card panel">
            <div className="logo-wrap">
              <div className="logo-circle">S</div>
              <div>
                <h1 className="app-title">SyncVerse</h1>
                <p className="app-subtitle">
                  Create a room, sync videos, and chat in real time.
                </p>
              </div>
            </div>

            <div className="join-form">
              <input
                className="theme-input"
                placeholder="Enter your name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              />

              <input
                className="theme-input"
                placeholder="Enter room name"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              />

              <button className="theme-button" onClick={joinRoom}>
                Join Room
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="room-layout">
          <aside className="left-sidebar panel">
            <div className="sidebar-top">
              <p className="sidebar-label">Room</p>
              <h2 className="sidebar-room">#{room}</h2>
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

                          {user.isHost && (
                            <span className="host-badge">Host</span>
                          )}
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
                  <h2>{room}</h2>
                  <p>
                    {isCurrentUserHost
                      ? "You control playback"
                      : "Watching together"}
                  </p>
                </div>
              </div>

              <div className="room-pill">
                {isCurrentUserHost ? "Host Room" : "Synced Room"}
              </div>
            </div>

            <div className="center-content">
              <div className="video-container panel-light">
                <div className="video-heading">
                  <p className="video-status">
                    {isCurrentUserHost
                      ? "You control the synced playback"
                      : "Video playback is synced with the room"}
                  </p>
                </div>

                {isCurrentUserHost ? (
                  <div className="video-top">
                    <input
                      type="text"
                      placeholder="Paste YouTube link..."
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      className="video-input"
                    />

                    <button
                      type="button"
                      className="video-button"
                      onClick={handleLoadVideo}
                    >
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

                    {!isCurrentUserHost && (
                      <div className="video-lock-overlay"></div>
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
              <p className="chat-side-subtitle">
                Chat with everyone in the room
              </p>
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
                  <div
                    key={i}
                    className={`message-row ${isMine ? "right" : "left"}`}
                  >
                    <div
                      className={`message-bubble ${isMine ? "mine" : "other"}`}
                    >
                      <p className="message-author">
                        {isMine ? `You (${msg.author})` : msg.author}
                      </p>

                      <p className="message-text">{msg.message}</p>

                      {msg.time && (
                        <span className="message-time">{msg.time}</span>
                      )}
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