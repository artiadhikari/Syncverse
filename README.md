# SyncVerse

SyncVerse is a real-time collaborative video watching platform that enables multiple users to join a shared room and watch videos in synchronized playback. The system ensures consistent video state across all participants, including play, pause, and seek actions, controlled by a designated host.

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
* Render (Backend)

---

## Deployment Instructions

### Backend on Render

1. Add `render.yaml` to the repo root. This repo already includes a `render.yaml` file for the backend service.
2. In Render, connect the repository and choose branch `main`.
3. Set the following Render environment variables:
   * `MONGO_URI` = your MongoDB Atlas connection string
   * `CLIENT_URL` = your Vercel frontend URL, for example `https://your-app.vercel.app`
4. Render will use:
   * Build command: `npm install`
   * Start command: `npm start`
   * Working directory: `server`

If you deleted the previous Render deployment, simply re-create it from the repo or push the updated `render.yaml` file again.

### Frontend on Vercel

1. Create a new Vercel project from the repository.
2. Set the root directory to `client`.
3. Configure this Vercel environment variable:
   * `REACT_APP_BACKEND_URL` = `https://<your-render-backend>.onrender.com`
4. Use:
   * Build command: `npm run build`
   * Output directory: `build`

---

## Environment Variables

### Frontend

`REACT_APP_BACKEND_URL=https://<your-render-backend>.onrender.com`

### Backend

`MONGO_URI=your_mongodb_connection_string`

`CLIENT_URL=https://<your-vercel-frontend>.vercel.app`

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
