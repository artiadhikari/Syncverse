import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import io from "socket.io-client";
import YouTube from "react-youtube";
import "./App.css";

const socket = io(
  process.env.REACT_APP_BACKEND_URL || "http://localhost:5000",
  {
    transports: ["websocket", "polling"],
    reconnection: true,
  }
);
console.log("Backend URL:", process.env.REACT_APP_BACKEND_URL);
function App() {
  const [username, setUsername] = useState("");
  const [joined, setJoined] = useState(false);
  const [mode, setMode] = useState("");
  const [roomName, setRoomName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  const [message, setMessage] = useState("");
  const [chat, setChat] = useState([]);
  const [users, setUsers] = useState([]);

  const [videoId, setVideoId] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoStatusText, setVideoStatusText] = useState("Waiting for a video...");
  const [isSocketConnected, setIsSocketConnected] = useState(socket.connected);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [isLocallyPaused, setIsLocallyPaused] = useState(false);
  const [playerInstanceKey, setPlayerInstanceKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [openUserMenu, setOpenUserMenu] = useState(null);
  const [floatingMenuPosition, setFloatingMenuPosition] = useState({ top: 0, left: 0 });
  const [floatingMenuUser, setFloatingMenuUser] = useState(null);

  const playerRef = useRef(null);
  const videoWrapperRef = useRef(null);
  const messagesEndRef = useRef(null);
  const isRemoteActionRef = useRef(false);
  const isPlayerReadyRef = useRef(false);
  const pendingRoomStateRef = useRef(null);
  const lastSyncSentAtRef = useRef(0);
  const latestRoomStateRef = useRef(null);
  const toastTimeoutRef = useRef(null);
  const isLocallyPausedRef = useRef(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);

  useEffect(() => {
    isLocallyPausedRef.current = isLocallyPaused;
  }, [isLocallyPaused]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const currentWrapper = videoWrapperRef.current;
      const fullscreenElement =
        document.fullscreenElement || document.webkitFullscreenElement || null;

      setIsFullscreen(!!currentWrapper && fullscreenElement === currentWrapper);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  const isCurrentUserHost = useMemo(() => {
    return users.find((u) => u.username === username)?.isHost || false;
  }, [users, username]);

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const aIsYou = a.username === username;
      const bIsYou = b.username === username;

      if (a.isHost && !b.isHost) return -1;
      if (!a.isHost && b.isHost) return 1;

      if (aIsYou && !bIsYou) return -1;
      if (!aIsYou && bIsYou) return 1;

      return a.username.localeCompare(b.username);
    });
  }, [users, username]);

  const showToast = (message, type = "info") => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);

    setToast({ message, type });

    toastTimeoutRef.current = setTimeout(() => {
      setToast(null);
    }, 2500);
  };

  const extractVideoId = (url) => {
    const regExp =
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
    const match = url.match(regExp);
    return match ? match[1] : "";
  };

  const closeUserMenu = () => {
    setOpenUserMenu(null);
    setFloatingMenuUser(null);
  };
  const openLeaveModal = () => {
  setShowLeaveModal(true);
};

const closeLeaveModal = () => {
  setShowLeaveModal(false);
};

const confirmLeaveRoom = async () => {
  try {
    const fullscreenElement =
      document.fullscreenElement || document.webkitFullscreenElement || null;

    if (fullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      }
    }
  } catch (error) {
    console.log("Exit fullscreen error:", error);
  }

  // 🔥 STOP SYNC FIRST
  isRemoteActionRef.current = true;
  isPlayerReadyRef.current = false;
  pendingRoomStateRef.current = null;
  latestRoomStateRef.current = null;

  // 🔥 STOP PLAYER
  if (playerRef.current) {
    try {
      playerRef.current.pauseVideo?.();
    } catch {}
  }
  playerRef.current = null;

  // 🔥 LEAVE ROOM
  if (socket.connected && roomId) {
    socket.emit("leave_room");
  }

  // 🔥 RESET UI
  resetRoomState();
  setJoined(false);
  setMode("");
  setRoomName("");
  setRoomId("");
  setInviteCode("");
  setShowLeaveModal(false);

  showToast("You left the room", "info");
};

  const toggleFullscreen = async () => {
    const el = videoWrapperRef.current;
    if (!el) return;

    try {
      const fullscreenElement =
        document.fullscreenElement || document.webkitFullscreenElement || null;

      if (!fullscreenElement) {
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        } else if (el.webkitRequestFullscreen) {
          await el.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          await document.webkitExitFullscreen();
        }
      }
    } catch (error) {
      console.log("Fullscreen error:", error);
    }
  };

  const resetRoomState = () => {
    setChat([]);
    setUsers([]);
    setMessage("");
    setVideoId("");
    setVideoUrl("");
    setIsVideoLoading(false);
    setVideoStatusText("Waiting for a video...");
    setIsLocallyPaused(false);
    setIsFullscreen(false);
    isLocallyPausedRef.current = false;
    closeUserMenu();
    playerRef.current = null;
    isPlayerReadyRef.current = false;
    pendingRoomStateRef.current = null;
    latestRoomStateRef.current = null;
    setPlayerInstanceKey(0);
  };

  const openFloatingUserMenu = (event, menuKey, user) => {
    event.stopPropagation();

    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 160;
    const gap = 8;

    let left = rect.right + gap;
    let top = rect.top;

    if (left + menuWidth > window.innerWidth - 12) {
      left = rect.left - menuWidth - gap;
    }

    if (top + 110 > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - 122);
    }

    if (openUserMenu === menuKey) {
      closeUserMenu();
      return;
    }

    setOpenUserMenu(menuKey);
    setFloatingMenuUser(user);
    setFloatingMenuPosition({ top, left });
  };

  const createRoom = () => {
    const trimmedUsername = username.trim();
    const trimmedRoomName = roomName.trim();

    if (!trimmedUsername) {
      showToast("Name not entered", "error");
      return;
    }

    if (!trimmedRoomName) {
      showToast("Room name not entered", "error");
      return;
    }

    if (!socket.connected) {
      showToast("Backend not connected", "error");
      return;
    }

    resetRoomState();

    socket.emit("create_room", {
      username: trimmedUsername,
      roomName: trimmedRoomName,
      isPrivate: true,
    });
  };

  const joinRoom = () => {
    const trimmedUsername = username.trim();
    const trimmedInviteCode = inviteCode.trim().toUpperCase();
    const trimmedRoomId = roomId.trim();

    if (!trimmedUsername) {
      showToast("Name not entered", "error");
      return;
    }

    if (!trimmedInviteCode && !trimmedRoomId) {
      showToast("Invite code or room ID not entered", "error");
      return;
    }

    if (!socket.connected) {
      showToast("Backend not connected", "error");
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

  const transferHost = (targetUsername) => {
    if (!roomId || !targetUsername) return;

    socket.emit("transfer_host", {
      roomId,
      targetUsername,
    });

    closeUserMenu();
  };

  const kickUser = (targetUsername) => {
    if (!roomId || !targetUsername) return;

    socket.emit("kick_user", {
      roomId,
      targetUsername,
    });

    closeUserMenu();
  };

  const handleLoadVideo = () => {
    const trimmedUrl = videoUrl.trim();
    const extractedId = extractVideoId(trimmedUrl);

    if (!trimmedUrl) {
      showToast("YouTube link not entered", "error");
      return;
    }

    if (!extractedId) {
      showToast("Please paste a valid YouTube link", "error");
      return;
    }

    setIsLocallyPaused(false);
    isLocallyPausedRef.current = false;

    const isSameVideo = extractedId === videoId;

    socket.emit("load_video", {
      roomId,
      videoId: extractedId,
      videoUrl: trimmedUrl,
      by: username,
    });

    setIsVideoLoading(true);

    if (isSameVideo) {
      setPlayerInstanceKey((prev) => prev + 1);
    } else {
      setVideoId(extractedId);
    }

    setVideoUrl("");
  };

  const copyInviteCode = async () => {
    if (!inviteCode) return;

    try {
      await navigator.clipboard.writeText(inviteCode);
      showToast("Code copied successfully", "success");
    } catch (error) {
      console.log(error);
      showToast("Could not copy code", "error");
    }
  };

  const applyRoomState = (state, options = {}) => {
  try {
    if (!state || !state.videoId) return;

    const forceSync = !!options.forceSync;

    if (
      !playerRef.current ||
      !isPlayerReadyRef.current ||
      typeof playerRef.current?.getCurrentTime !== "function" ||
      typeof playerRef.current?.seekTo !== "function"
    ) {
      pendingRoomStateRef.current = { ...state, __forceSync: forceSync };
      return;
    }

    // 🔥 EXTRA SAFETY (THIS WAS MISSING)
    let current = 0;
    try {
      current = playerRef.current.getCurrentTime();
    } catch {
      return;
    }

    const now = Date.now();
    const networkDelay = state.sentAt ? (now - state.sentAt) / 1000 : 0;
    const baseTime = Number(state.currentTime) || 0;
    const targetTime = state.isPlaying ? baseTime + networkDelay : baseTime;

    const shouldPlay = forceSync
      ? !!state.isPlaying
      : isLocallyPausedRef.current
      ? false
      : !!state.isPlaying;

    const diff = Math.abs(current - targetTime);
    const seekThreshold = state.isPlaying ? 1 : 0.35;

   isRemoteActionRef.current = true;

try {
  if (diff > seekThreshold) {
    playerRef.current.seekTo(targetTime, true);
  }
} catch {
  return;
}

const playerState = playerRef.current.getPlayerState?.();

if (shouldPlay && playerState !== 1) {
  playerRef.current.playVideo?.();
} else if (!shouldPlay && playerState !== 2) {
  playerRef.current.pauseVideo?.();
}

setTimeout(() => {
  isRemoteActionRef.current = false;
}, 500);
  } catch (err) {
    console.log("🔥 Sync crash prevented:", err);
  }
};

  const syncToHostNow = () => {
    const state = latestRoomStateRef.current;
    if (!state) return;

    setIsLocallyPaused(false);
    isLocallyPausedRef.current = false;
    applyRoomState(state, { forceSync: true });
  };

  const pauseLocallyNow = () => {
    if (!playerRef.current) return;

    setIsLocallyPaused(true);
    isLocallyPausedRef.current = true;
    playerRef.current.pauseVideo?.();
  };

  const onPlayerReady = (event) => {
    if (!event || !event.target) return;
    playerRef.current = event.target;
    isPlayerReadyRef.current = true;
    setIsVideoLoading(false);

    if (pendingRoomStateRef.current) {
      const pendingState = pendingRoomStateRef.current;
      const forceSync = !!pendingState.__forceSync;
      const cleanState = { ...pendingState };
      delete cleanState.__forceSync;

      applyRoomState(cleanState, { forceSync });
      pendingRoomStateRef.current = null;
    }
  };

  const onPlay = () => {
    if (!playerRef.current) return;
    if (isRemoteActionRef.current) return;

    const currentTime = playerRef.current.getCurrentTime?.() || 0;

    if (!isCurrentUserHost) {
      syncToHostNow();
      return;
    }

    socket.emit("play_video", { roomId, currentTime });
  };

  const onPause = () => {
    if (!playerRef.current) return;
    if (isRemoteActionRef.current) return;

    const currentTime = playerRef.current.getCurrentTime?.() || 0;

    if (!isCurrentUserHost) {
      setIsLocallyPaused(true);
      isLocallyPausedRef.current = true;
      return;
    }

    socket.emit("pause_video", { roomId, currentTime });
  };

  const onStateChange = (event) => {
    if (!playerRef.current) return;
    if (isRemoteActionRef.current) return;

    const currentTime = playerRef.current.getCurrentTime?.() || 0;

  if (!isCurrentUserHost) {
  if (event?.data === 3 && !isLocallyPausedRef.current) {
    const state = latestRoomStateRef.current;
    if (state) {
      applyRoomState(state); 
    }
  }
  return;
}

    if (event?.data === 3) {
      socket.emit("seek_video", { roomId, currentTime });
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  useEffect(() => {
    const syncInterval = setInterval(() => {
      if (!joined || !playerRef.current || !isPlayerReadyRef.current) return;
      if (!isCurrentUserHost) return;
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
    const closeMenuOnOutsideClick = () => {
      closeUserMenu();
    };

    const closeMenuOnEscape = (e) => {
    if (e.key === "Escape") {
  closeUserMenu();
  closeLeaveModal();
}
    };

    window.addEventListener("click", closeMenuOnOutsideClick);
    window.addEventListener("keydown", closeMenuOnEscape);
    window.addEventListener("resize", closeMenuOnOutsideClick);
    window.addEventListener("scroll", closeMenuOnOutsideClick, true);

    return () => {
      window.removeEventListener("click", closeMenuOnOutsideClick);
      window.removeEventListener("keydown", closeMenuOnEscape);
      window.removeEventListener("resize", closeMenuOnOutsideClick);
      window.removeEventListener("scroll", closeMenuOnOutsideClick, true);
    };
  }, []);

  useEffect(() => {
    closeUserMenu();
  }, [users]);

  useEffect(() => {
    const handleConnect = () => {
      setIsSocketConnected(true);
    };

    const handleDisconnect = () => {
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
      if (!state?.videoId) return;

      latestRoomStateRef.current = state;

      const isNewVideo = state.videoId !== videoId;

      if (isNewVideo) {
        setVideoId(state.videoId);
        setIsVideoLoading(true);
        setIsLocallyPaused(false);
        isLocallyPausedRef.current = false;

        pendingRoomStateRef.current = { ...state, __forceSync: true };
        return;
      }

  if (!isLocallyPausedRef.current) {
  setTimeout(() => {
    applyRoomState(state);
  }, 100);
}
};

    const handleRoomCreated = (data) => {
      setJoined(true);
      setRoomId(data.roomId);
      setRoomName(data.roomName);
      setInviteCode(data.inviteCode || "");
      setVideoStatusText("Playback in your hands");
      setIsLocallyPaused(false);
      isLocallyPausedRef.current = false;
      showToast("Room created successfully", "success");
    };

    const handleRoomJoined = (data) => {
      setJoined(true);
      setRoomId(data.roomId);
      setRoomName(data.roomName);
      setInviteCode(data.inviteCode || "");
      setVideoStatusText("Watching in perfect sync");
      setIsLocallyPaused(false);
      isLocallyPausedRef.current = false;
      showToast("Joined room successfully", "success");
    };

    const handleRoomMeta = (data) => {
      setRoomId(data.roomId || "");
      setRoomName(data.roomName || "");
      setInviteCode(data.inviteCode || "");
    };

    const handleHostChanged = (data) => {
      if (!data?.hostUsername) return;

      setIsLocallyPaused(false);
      isLocallyPausedRef.current = false;

      if (data.hostUsername === username) {
        showToast("You are now the host", "success");
        setVideoStatusText("Playback in your hands");
      } else {
        showToast(`${data.hostUsername} is now the host`, "info");
        setVideoStatusText("Watching in perfect sync");
      }
    };

    const handleKicked = (data) => {
      if (data?.username !== username) return;

      showToast("You were removed from the room", "error");
      resetRoomState();
      setJoined(false);
      setMode("");
      setRoomName("");
      setRoomId("");
      setInviteCode("");
    };

    const handleRoomError = (err) => {
      console.log("❌ room_error:", err);
      showToast(err?.message || "Something went wrong", "error");
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
    socket.on("host_changed", handleHostChanged);
    socket.on("kicked_from_room", handleKicked);
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
      socket.off("host_changed", handleHostChanged);
      socket.off("kicked_from_room", handleKicked);
      socket.off("room_error", handleRoomError);
    };
  }, [isCurrentUserHost, videoId, username]);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}

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

            {!isSocketConnected && (
              <p className="inline-status inline-status-error">
              Backend waking up... please wait
              </p>
            )}

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
          <button
  type="button"
  className="leave-btn"
  onClick={openLeaveModal}
  title="Leave room"
>
  ⏻
</button>
          <aside className="left-sidebar panel">
            <div className="sidebar-top">
              <p className="sidebar-label">Room :</p>
              <h2 className="sidebar-room">{roomName}</h2>
              <p className="sidebar-subtext">
                {isCurrentUserHost
                  ? "You lead the watch session."
                  : "Synced into the room."}
              </p>
            </div>

            <div className="sidebar-block">
              <h3 className="sidebar-title">Invite</h3>
              <div className="invite-card">
                <p className="invite-label">Code</p>
                <div className="invite-row">
                  <span className="invite-code">{inviteCode}</span>
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
                {sortedUsers.map((user, i) => {
                  const isYou = user.username === username;
                  const canManageUser =
                    isCurrentUserHost && !user.isHost && user.username !== username;

                  const menuKey = `${user.username}-${i}`;
                  const isMenuOpen = openUserMenu === menuKey;

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
                          {user.isHost && <span className="host-badge inline-badge">Host</span>}
                        </div>
                      </div>

                      {canManageUser && (
                        <div
                          className="user-menu-wrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="user-menu-trigger"
                            onClick={(e) => openFloatingUserMenu(e, menuKey, user)}
                            title="User options"
                          >
                            ⋮
                          </button>

                          {isMenuOpen &&
                            floatingMenuUser?.username === user.username &&
                            createPortal(
                              <div
                                className="floating-user-menu"
                                style={{
                                  top: `${floatingMenuPosition.top}px`,
                                  left: `${floatingMenuPosition.left}px`,
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  className="user-menu-item"
                                  onClick={() => transferHost(user.username)}
                                >
                                  Make Host
                                </button>
                                <button
                                  className="user-menu-item danger"
                                  onClick={() => kickUser(user.username)}
                                >
                                  Kick User
                                </button>
                              </div>,
                              document.body
                            )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="center-panel panel">
            <div className="chat-header">
              <div className="chat-user-info">
                <div className="brand-avatar">S</div>
                <div>
                  <h2>SyncVerse</h2>
                  <p>{videoStatusText}</p>
                </div>
              </div>

              <div className="room-pill">
                {isCurrentUserHost ? "Host" : "Synced User"}
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
                  <div className="viewer-sync-top">
                    <div className="viewer-sync-inputlike">
                      <span className="viewer-sync-inputlike-text">
                        Host is controlling playback •{" "}
                        {isLocallyPaused ? "you paused locally" : "you are watching in sync"}
                      </span>
                    </div>

                    {videoId && (
                      <button
                        type="button"
                        className="video-button viewer-split-button"
                        onClick={isLocallyPaused ? syncToHostNow : pauseLocallyNow}
                      >
                        {isLocallyPaused ? "Sync" : "Pause"}
                      </button>
                    )}
                  </div>
                )}

                {videoId ? (
                  <div className="video-player-wrapper" ref={videoWrapperRef}>
                    {!isCurrentUserHost && (
                      <button
                        type="button"
                        className="custom-fullscreen-btn"
                        onClick={toggleFullscreen}
                        title={isFullscreen ? "Exit full screen" : "Full screen"}
                        aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
                      >
                        {isFullscreen ? (
                          <svg
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            aria-hidden="true"
                          >
                            <path
                              d="M9 4H5v4M15 4h4v4M9 20H5v-4M15 20h4v-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : (
                          <svg
                            viewBox="0 0 24 24"
                            width="18"
                            height="18"
                            aria-hidden="true"
                          >
                            <path
                              d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>
                    )}

                    <div className="video-player">
                      <YouTube
                        key={`${videoId}-${playerInstanceKey}`}
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
                            iv_load_policy: 3,
                               playsinline: 1
                          },
                        }}
                      />
                      {!isCurrentUserHost && <div className="video-lock-overlay"></div>}
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
                        ? "Paste a link above and start watching together."
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
              <p className="chat-side-subtitle">Talk with everyone in the room</p>
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
          {showLeaveModal &&
  createPortal(
    <div className="modal-overlay" onClick={closeLeaveModal}>
      <div className="leave-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Leave room?</h3>
        <p>You will exit this watch session.</p>

        <div className="modal-actions">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={closeLeaveModal}
          >
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-danger"
            onClick={confirmLeaveRoom}
          >
            Leave
          </button>
        </div>
      </div>
    </div>,
    document.body
  )}
        </div>
      )}
    </div>
  );
}

export default App;