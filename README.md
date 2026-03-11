# Cam App (LAN MVP)

Initial project for viewing cameras on LAN (without login) using WebRTC directly between the device and viewer, without a third-party app.

## Basic Architecture
- Device opens `publish.html` and turns the camera on
- Viewer opens `index.html` and receives the stream via WebRTC
- A simple server (`serve-web.ps1`) handles the signaling between the two

## Requirements
- Windows 10/11
- PowerShell
- Node.js (for ONVIF discovery and generating MediaMTX config)
- MediaMTX (for IP cameras)
- Chrome/Edge on the device and viewer

## Quick Steps
1) Start the server (static + signaling)

- PowerShell (Administrator):

```powershell
.\scripts\serve-web.ps1 -Root .\web -Port 5173 -HostName +
```

- Optional: define the folder for recordings received from the viewer:

```powershell
.\scripts\serve-web.ps1 -Root .\web -Port 5173 -HostName + -RecordingsDir .\recordings
```

Open in browser: `http://YOUR_LOCAL_IP:5173` (e.g., `http://192.168.1.6:5173`)

2) On the device, open the publisher:
- URL: `http://YOUR_LOCAL_IP:5173/publish.html` (e.g., `http://192.168.1.6:5173/publish.html`)
- Signal Base URL: `http://YOUR_LOCAL_IP:5173` (e.g., `http://192.168.1.6:5173`)
- Camera name: optional
- Path: `cam1` (if left blank, use a unique identifier)
- Click **Start**

3) In the viewer:
- Open `http://YOUR_LOCAL_IP:5173` (e.g., `http://192.168.1.6:5173`)
- Signal Base URL and Media Base URL are configured on the admin page and are read-only here.

- Click **Connect**
- Optional: check **Save recordings to server** to send the files to your PC (`recordings/`).

- Optional: click **Record** and choose the format to save to your PC
- Optional: enable **Motion Detection** on the connected camera to record automatically.

- Use the **Audio** button to listen to one camera at a time.

4) Cameras in the list
- Cameras appear automatically when the publisher starts.

- In the viewer, click the camera name to edit the **Nickname** locally.

## Admin (server settings)
- Open `http://YOUR_LOCAL_IP:5173/admin.html` on the server.

- Configure Signal Base URL and Media Base URL (the viewer uses these values ​​and the fields are read-only).

- Configure the recording folder (absolute or relative path to the project).

- Adjust: force HTTPS, detailed logs, default recording format/name, and automatic recording parameters.

- Check the MediaMTX status and open the logs via the admin page.

- The settings are saved in `server-config.json` on the server (does not use localStorage).

## Motion Detection and Recording
- The detection runs in the viewer (browser) analyzing the received video.

- Adjust **Sensitivity** and **Stop After** on each connected camera.

- When motion is detected, automatic recording starts and stops after a few seconds without movement.

- With **Save recordings to server**, the files are sent to `recordings/` on the server (configurable with `-RecordingsDir`).

- Without this option, the browser downloads the file locally.

5) Discover IP cameras
- Activate ONVIF/RTSP on the camera (in the manufacturer's panel) and set username/password.

- Ensure that `mediamtx.exe` is inside `mediamtx/` (see the section below).

- Run discovery (Node.js) to generate `web/ip-cameras.json`:

```powershell
node .\scripts\onvif-discover.js --watch
```

- Configure the RTSP URLs (copy the `id` from `ip-cameras.json`):

```powershell
Copy-Item .\scripts\ip-cameras-rtsp.sample.json .\scripts\ip-cameras-rtsp.json
```

- To discover RTSP via ONVIF using the camera account:

```powershell
node .\scripts\onvif-rtsp.js --id YOUR_ID --user YOUR_USERNAME --pass YOUR_PASSWORD
```

- Or for all discovered cameras:

```powershell
node .\scripts\onvif-rtsp.js --all --user YOUR_USERNAME --pass YOUR_PASSWORD
```
Edit `scripts/ip-cameras-rtsp.json``` if you want to manually adjust the `rtspUrl`.

- Always restart MediaMTX after changing `ip-cameras-rtsp.json`:

```powershell
.\scripts\mediamtx.ps1 restart
```

- Common examples:

- Intelbras: `rtsp://username:password@IP:554/cam/realmonitor?channel=1&subtype=0`

- Tapo: `rtsp://username:password@IP:554/stream1`

- Start MediaMTX automatically (generates configuration and starts the service):

```powershell
.\scripts\mediamtx.ps1 start
```

- To stop:

```powershell
.\scripts\mediamtx.ps1 stop
```

- In the viewer, click **Watch** to open the IP camera via WHEP.

## HTTPS local (no flags on Android)
- Generate and install a self-signed certificate (Administrator):

```powershell
.\scripts\https-setup.ps1 -Port 5173 -IpAddress YOUR_LOCAL_IP
```

- Start the server with HTTPS:

```powershell
.\scripts\serve-web.ps1 -Root .\web -Port 5173 -HostName + -Scheme https
```

- Access with `https://YOUR_LOCAL_IP:5173` and adjust the Signal Base URL to `https://YOUR_LOCAL_IP:5173`.

- The browser may display an insecure site warning the first time.

- If Chrome shows the warning, tap **Advanced** and **Continue**.

- If using IP cameras via MediaMTX, the HTTPS viewer may block `http://YOUR_IP:8889` (mixed content).

- Simple option: Use the HTTP viewer for IP cameras.

- Complete option: Configure MediaMTX for HTTPS and use `https://YOUR_IP:8889`.

## MediaMTX (Windows installation)
- Download the Windows version (zip) from `https://github.com/bluenviron/mediamtx/releases`.

- Extract the file and copy `mediamtx.exe` to `mediamtx/` (e.g., `C:\dev\cam-app\mediamtx\mediamtx.exe`).

- The script `.\scripts\mediamtx.ps1 start` automatically generates `mediamtx/mediamtx.yml`.

- To update the configuration after editing RTSP, run `.\scripts\mediamtx.ps1 restart`.

- The page `http://YOUR_LOCAL_IP:8889` may return a 404 error, and this is expected (the viewer uses WHEP via `/whep/...`).

## Important Notes
- Camera in the browser requires HTTPS. For local development on Chrome Android:

- Access `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
- Add `http://YOUR_LOCAL_IP:5173` (e.g., `http://192.168.1.6:5173`) and restart the browser.
- Direct WebRTC works best on LAN. One path = one active camera.

- On the server, open TCP port 5173 in the Windows Firewall (inbound) or create a rule for PowerShell/`serve-web.ps1`.

- PowerShell (Administrator):

```powershell
New-NetFirewallRule -DisplayName "Cam App LAN 5173" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173
```

- Server recording uses `POST /recordings` and saves to `recordings/` (configurable with `-RecordingsDir`).

- If ONVIF discovery does not find cameras, allow UDP 3702 in the firewall (inbound/outbound).

- To watch IP cameras via MediaMTX, allow TCP 8889.
- MP4 recording depends on the browser. If it fails, use WebM.

- MediaMTX logs are located in `logs/mediamtx.log` and `logs/mediamtx.err.log`.

Next steps (when it evolves)
- Backend with registration and login
- Proprietary Android app with CameraX and direct WebRTC