# SyncVerse

SyncVerse is a real-time collaborative video watching platform that enables multiple users to join a shared room and watch videos in synchronized playback. The system ensures consistent video state across all participants, including play, pause, and seek actions, controlled by a designated host.

---

## Live Demo

Frontend: https://syncverse-peach.vercel.app
Backend: https://syncverse-production.up.railway.app

---

## Overview

SyncVerse addresses the challenge of asynchronous media consumption in shared environments. It provides a seamless experience for users to watch videos together in real time, regardless of their location. The platform maintains synchronization through event-driven communication and ensures that new participants joining a session are aligned with the current playback state.

---

## Features

* Real-time room creation and joining using unique identifiers
* Host-controlled playback for synchronized viewing
* Automatic synchronization for late-joining users
* Real-time communication using WebSockets
* Integrated chat functionality within rooms
* Responsive user interface across devices

---

## Tech Stack

### Frontend

* React.js
* CSS

### Backend

* Node.js
* Express.js
* Socket.IO

### Database

* MongoDB Atlas

### Deployment

* Vercel (Frontend)
* Railway (Backend)

---

## Architecture

The application follows a client-server architecture:

* The frontend communicates with the backend using HTTP and WebSocket protocols
* The backend manages room lifecycle, user sessions, and synchronization logic
* Socket.IO enables real-time event broadcasting across connected clients
* MongoDB is used for persistent storage of room and playback state

---

## Environment Variables

### Frontend

REACT_APP_BACKEND_URL=https://syncverse-production.up.railway.app

### Backend

MONGO_URI=your_mongodb_connection_string

---

## Local Setup

### Clone the repository

git clone https://github.com/artiadhikari/Syncverse.git

### Install dependencies

cd client
npm install

cd ../server
npm install

### Run the application

Start backend:

npm start

Start frontend:

npm start

---

## Key Implementation Details

* Playback synchronization is achieved using event-based communication via Socket.IO
* Host actions trigger updates that are propagated to all connected clients
* Late joiners receive the current playback state and timestamp upon joining
* The backend maintains the authoritative state to ensure consistency across clients

---

## Future Enhancements
* Support for additional media platforms
* Improved reconnection and error handling strategies
* Enhanced user interface and interaction feedback
* Scalability improvements for larger concurrent rooms

---

## Author

Arti Adhikari

---

## License

This project is intended for educational and demonstration purposes.
