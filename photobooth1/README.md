# LDR Photobooth (Test Build)

A photobooth web app for long-distance couples/friends — create or join a
room, connect live over video, and capture a side-by-side photo together.

## How it works
- **frontend/** — plain HTML/CSS/JS. Uses WebRTC for live video between two
  browsers, with Firebase Firestore used purely as a signaling channel
  (helping the two browsers find each other — no video ever passes through
  Firebase itself).
- **backend/** — a minimal Flask app, currently just used for local testing.
  Not required for deployment on Vercel, since the frontend is a static site.

## Running locally
```
cd backend
pip install -r requirements.txt
python app.py
```
Then open http://localhost:5000

## Deploying
Deploy the `frontend` folder as a static site (e.g. on Vercel, set Root
Directory to `frontend`). No backend needed for the deployed version.

## Setup required
Before running, fill in `frontend/firebase-config.js` with your own Firebase
project config, and make sure Firestore is created with rules allowing
read/write (test mode) for the room signaling to work.
