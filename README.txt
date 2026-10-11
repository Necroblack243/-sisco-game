SISCO multiplayer (2 to 5 players, any phone or computer)

WHAT IS INSIDE
- Accounts (username + password) or guest play, saved win counts and a leaderboard
- Play vs computer (1 to 4 opponents, Easy / Medium / Hard)
- Rooms with a 4-letter code so friends can join from anywhere
- Matches of 1 to 10 rounds (host chooses) with a running score and a match champion
- One-tap WhatsApp invite
- Installable as an app on Android and Windows (see below)
- For a permanent online link, read DEPLOY-ONLINE.txt

PLAY ON THE SAME WI-FI OR LAN CABLE (Windows host)
1. Install Node.js (LTS) from https://nodejs.org  (one time only).
2. Unzip this folder. Double-click start-sisco.bat.
3. The window shows addresses like http://192.168.1.5:3000
4. On the host PC open http://localhost:3000 , make an account (or continue as guest), press Create room.
5. Friends on Android, Windows, iPhone or Mac open the 192.168... address in their browser,
   log in or play as guest, type the room code and press Join.
6. Host can Add computer player, then press Start game.
If friends cannot connect: allow Node.js through Windows Firewall when prompted (tick Private networks).

PLAY OVER THE INTERNET
Option A (quick, free): keep the server running on your PC and use a tunnel such as
  cloudflared:  cloudflared tunnel --url http://localhost:3000
  or ngrok:     ngrok http 3000
  Share the https link it prints. Everyone opens that link.
Option B (always on): upload this folder to a Node host (Render, Railway, Fly.io, a VPS).
  Start command: node server.js   (the host sets PORT automatically).
  Accounts are saved in data/users.json. Many free hosts erase files on restart, so attach a
  persistent disk and set the DATA_DIR environment variable to its path to keep accounts.

INSTALL AS AN APP
Open the https link in Chrome or Edge. Android: menu > Install app (or Add to Home screen).
Windows: click the install icon in the address bar. Installing needs https (the internet link
or localhost). On a plain http://192.168... address you can still use Add to Home screen as a shortcut.

Notes
- Rooms live in memory; restarting the server ends running games (accounts are kept).
- If a player's connection drops, they rejoin automatically. After 20 seconds offline on
  their turn, a random number is called for them so the game does not stall.
- Passwords are stored hashed (scrypt), never in plain text.
