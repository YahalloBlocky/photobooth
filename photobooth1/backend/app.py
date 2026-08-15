"""
Minimal backend for the LDR Photobooth test build.

Right now this just serves the frontend files. The actual live video
connection between two people happens directly in the browser via
WebRTC + Firebase (no backend needed for that part).

This file exists so you have a real Python server to build on top of
later -- e.g. an endpoint that removes photo backgrounds using rembg.
"""

from flask import Flask, send_from_directory
import os
import sys

# Path to the frontend folder (assumes backend/ and frontend/ are siblings)
FRONTEND_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "frontend")
)

# Fail loudly and clearly instead of a confusing 404 later
if not os.path.isdir(FRONTEND_DIR):
    print(f"\nERROR: Could not find the frontend folder at:\n  {FRONTEND_DIR}")
    print("Make sure your folders look like this:\n")
    print("  photobooth/")
    print("  ├── frontend/   <-- must be a SIBLING of backend/")
    print("  │   ├── index.html")
    print("  │   ├── style.css")
    print("  │   ├── script.js")
    print("  │   └── firebase-config.js")
    print("  └── backend/")
    print("      ├── app.py   <-- you are running this file")
    print("      └── requirements.txt\n")
    sys.exit(1)

app = Flask(__name__, static_folder=None)  # we'll handle static serving ourselves


@app.route("/")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:filename>")
def serve_static_file(filename):
    # Serves style.css, script.js, firebase-config.js, etc.
    return send_from_directory(FRONTEND_DIR, filename)


@app.route("/api/health")
def health_check():
    """Simple test route to confirm the backend is running."""
    return {"status": "ok", "message": "Backend is alive"}


# -----------------------------------------------------------------
# Future idea: background removal endpoint
#
# @app.route("/api/remove-background", methods=["POST"])
# def remove_background():
#     # Receive an image, run it through rembg, return the result
#     pass
# -----------------------------------------------------------------


if __name__ == "__main__":
    app.run(debug=True, port=5000)
