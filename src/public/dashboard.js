import { h, render } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// --- API helper ---
async function api(method, path, body) {
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  return r.json();
}

// Helper: pick button class based on whether it matches current server state
function bc(active) { return active ? "" : "secondary"; }

// --- App ---
function App() {
  // Single source of truth: server status (polled every second)
  const [s, setS] = useState({ connected: false, running: false });
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const active = s.connected && s.running;
  const pose = s.pose || {};

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  // SSE — single source of truth for all state
  useEffect(() => {
    let es;
    function connect() {
      es = new EventSource("/cast/events");
      es.addEventListener("status", (e) => {
        setS(JSON.parse(e.data));
      });
      es.addEventListener("toast", (e) => {
        showToast(JSON.parse(e.data).message);
      });
      es.onerror = () => {
        setS((prev) => ({ ...prev, connected: false, running: false }));
        es.close();
        setTimeout(connect, 2000);
      };
    }
    connect();
    return () => es?.close();
  }, [showToast]);

  // Double-buffered frame refresh: fetch next frame while current displays
  const imgRef = useRef(null);
  useEffect(() => {
    let run = true;
    // Two offscreen buffers, alternating
    const buf = [new Image(), new Image()];
    let idx = 0;
    function fetch_next() {
      if (!run) return;
      const img = buf[idx];
      idx = 1 - idx;
      img.onload = () => {
        if (!run) return;
        if (imgRef.current) imgRef.current.src = img.src;
        // Immediately start loading the next frame
        requestAnimationFrame(fetch_next);
      };
      img.onerror = () => { if (run) setTimeout(fetch_next, 500); };
      img.src = "/cast/screenshot?t=" + Date.now();
    }
    fetch_next();
    return () => { run = false; };
  }, []);

  // Keyboard + mouse (imperative)
  const overlayRef = useRef(null);
  const crosshairRef = useRef(null);

  useEffect(() => {
    const keysDown = new Set();
    let keyLoop = false, dragging = false, dx0, dy0;

    function spd() { return parseFloat(document.getElementById("move-speed")?.value) || 0.3; }
    function look() { return parseFloat(document.getElementById("look-speed")?.value) || 0.15; }

    function tick() {
      if (keysDown.size === 0) { keyLoop = false; return; }
      const m = spd(), l = look();
      let fwd = 0, str = 0, yaw = 0, pit = 0, up = 0;
      if (keysDown.has("w") || keysDown.has("arrowup")) fwd += m;
      if (keysDown.has("s") || keysDown.has("arrowdown")) fwd -= m;
      if (keysDown.has("a") || keysDown.has("arrowleft")) str -= m;
      if (keysDown.has("d") || keysDown.has("arrowright")) str += m;
      if (keysDown.has("q")) up -= m;
      if (keysDown.has("e")) up += m;
      if (keysDown.has("j")) yaw -= l;
      if (keysDown.has("l")) yaw += l;
      if (keysDown.has("i")) pit += l;
      if (keysDown.has("k")) pit -= l;
      if (fwd || str || yaw || pit || up)
        api("POST", "/cast/pose", { dz: fwd, dx: str, dy: up, d_yaw: yaw, d_pitch: pit });
      setTimeout(tick, 80);
    }

    const kd = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.repeat) return;
      keysDown.add(e.key.toLowerCase());
      if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) e.preventDefault();
      if (e.key === "p" || e.key === "P") { doScreenshot(); return; }
      if (e.key === " " || e.key === "Enter") { doClick(); return; }
      if (e.key === "Escape") { doResetPose(); return; }
      if (!keyLoop) { keyLoop = true; tick(); }
    };
    const ku = (e) => { if (e.target.tagName === "INPUT") return; keysDown.delete(e.key.toLowerCase()); };
    const md = (e) => { if (e.button !== 0) return; dragging = true; dx0 = e.clientX; dy0 = e.clientY; if (crosshairRef.current) crosshairRef.current.style.display = "block"; };
    const mm = (e) => {
      if (!dragging) return;
      const dx = e.clientX - dx0, dy = e.clientY - dy0;
      dx0 = e.clientX; dy0 = e.clientY;
      const sn = look();
      const yaw = dx * sn * 0.02, pitch = dy * sn * 0.02;
      if (yaw || pitch) api("POST", "/cast/pose", { d_yaw: yaw, d_pitch: pitch });
    };
    const mu = () => { dragging = false; if (crosshairRef.current) crosshairRef.current.style.display = "none"; };
    const ctx = (e) => { e.preventDefault(); doClick(); };

    document.addEventListener("keydown", kd);
    document.addEventListener("keyup", ku);
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    const ov = overlayRef.current;
    if (ov) { ov.addEventListener("mousedown", md); ov.addEventListener("contextmenu", ctx); }
    return () => {
      document.removeEventListener("keydown", kd);
      document.removeEventListener("keyup", ku);
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
      if (ov) { ov.removeEventListener("mousedown", md); ov.removeEventListener("contextmenu", ctx); }
    };
  }, []);

  // Actions
  const doClick = async () => { const r = await api("POST", "/cast/click"); if (r?.ok) showToast("Click sent"); };
  const doScreenshot = () => {
    const a = document.createElement("a");
    a.href = "/cast/screenshot";
    a.download = "quest-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg";
    a.click();
    showToast("Screenshot saved");
  };
  const doResetPose = async () => {
    await api("POST", "/cast/reset-view");
    showToast("Back to HMD view");
  };

  // Derive display state from server
  const curRes = s.width && s.height ? s.width + "x" + s.height : "";
  const curEye = s.eye || "left";

  return html`
    <header>
      <div id="status-dot" class=${active ? "ok" : ""}></div>
      <h1>Quest Cast</h1>
      ${active ? html`
        <div id="status-bar">
          <span><span class="val">${s.fps ?? "--"}</span> fps</span>
          <span><span class="val">${s.width ? s.width + "\u00d7" + s.height : "--"}</span></span>
          <span><span class="val">${s.frame_count?.toLocaleString() ?? "--"}</span> frames</span>
          <span><span class="val">${s.bytes ? (s.bytes / 1048576).toFixed(1) : "--"}</span> MB</span>
          <button onclick=${() => { if (confirm("Stop casting?")) api("POST", "/cast/stop"); }}>Stop</button>
        </div>
      ` : html`
        <div id="header-cast-btn">
          <button onclick=${() => api("POST", "/cast/start")}>Cast</button>
        </div>
      `}
    </header>

    <div class="main">
      <div class="video-pane">
        <${VideoPane} active=${active} imgRef=${imgRef} crosshairRef=${crosshairRef} overlayRef=${overlayRef} />
      </div>

      <div class="sidebar">
        <${Panel} title="Movement">
          <div class="btn-row" style="justify-content:center;">
            <div style="display:grid; grid-template-columns: repeat(3,40px); grid-template-rows: repeat(2,34px); gap:4px;">
              <div></div>
              <button class="secondary" onclick=${() => api("POST", "/cast/pose", { dz: parseFloat(document.getElementById("move-speed")?.value) || 0.3 })}>\u25B2</button>
              <div></div>
              <button class="secondary" onclick=${() => api("POST", "/cast/pose", { dx: -(parseFloat(document.getElementById("move-speed")?.value) || 0.3) })}>\u25C0</button>
              <button class="secondary" onclick=${() => api("POST", "/cast/pose", { dz: -(parseFloat(document.getElementById("move-speed")?.value) || 0.3) })}>\u25BC</button>
              <button class="secondary" onclick=${() => api("POST", "/cast/pose", { dx: parseFloat(document.getElementById("move-speed")?.value) || 0.3 })}>\u25B6</button>
            </div>
          </div>
          <div class="speed-row">
            <label>Speed</label>
            <input type="number" id="move-speed" value="0.3" min="0.01" max="2" step="0.05" />
            <label>Look</label>
            <input type="number" id="look-speed" value="0.15" min="0.01" max="1" step="0.01" />
          </div>
        <//>

        <${Panel} title="Offset from HMD">
          <div class="pose-readout">
            <span>${pose.x?.toFixed(2) ?? "0"}, ${pose.y?.toFixed(2) ?? "0"}, ${pose.z?.toFixed(2) ?? "0"}</span>
            <span>${pose.yaw_deg?.toFixed(1) ?? "0"}\u00b0 yaw, ${pose.pitch_deg?.toFixed(1) ?? "0"}\u00b0 pitch</span>
            <span>loop: ${s.pose_loop ? "~27 Hz" : "off"}</span>
          </div>
          <div class="btn-row">
            <button class="secondary" style="flex:1;" onclick=${async () => { const r = await api("POST", "/cast/pose", { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }); if (r?.ok) showToast("Origin"); }}>Origin</button>
            <button class=${s.pose_loop ? "" : "secondary"} style="flex:1;" onclick=${doResetPose}>${s.pose_loop ? "Back to HMD" : "Reset"}</button>
          </div>
        <//>

        <${Panel} title="Display">
          <div class="btn-row">
            <button class=${bc(curRes === "2064x1162")} onclick=${() => api("POST", "/cast/config", { width: 2064, height: 1162 })}>2064</button>
            <button class=${bc(curRes === "1920x1080")} onclick=${() => api("POST", "/cast/config", { width: 1920, height: 1080 })}>1080p</button>
            <button class=${bc(curRes === "1280x720")} onclick=${() => api("POST", "/cast/config", { width: 1280, height: 720 })}>720p</button>
          </div>
          <div class="btn-row" style="margin-top:6px;">
            <button class=${bc(curEye === "left")} onclick=${() => api("POST", "/cast/eye", { mode: "left" })}>L Eye</button>
            <button class=${bc(curEye === "right")} onclick=${() => api("POST", "/cast/eye", { mode: "right" })}>R Eye</button>
            <button class=${bc(curEye === "stereo")} onclick=${() => api("POST", "/cast/eye", { mode: "stereo" })}>Stereo</button>
          </div>
        <//>

        <${Panel} title="Actions">
          <div class="btn-row">
            <button style="flex:1;" onclick=${doClick}>Click</button>
            <button class="secondary" style="flex:1;" onclick=${() => api("POST", "/cast/home")}>Home</button>
          </div>
          <div class="btn-row" style="margin-top:6px;">
            <button style="flex:1;" onclick=${doScreenshot}>Screenshot</button>
            <button class="secondary" style="flex:1;" onclick=${() => window.open("/cast/stream", "_blank")}>MJPEG</button>
          </div>
        <//>

        <${Panel} title="Keys">
          <div class="keybind-hint">
            <b>WASD</b> / <b>Arrows</b> move \u00a0 <b>IJKL</b> look \u00a0 <b>QE</b> up/down<br />
            <b>Drag</b> free look \u00a0 <b>Right-click</b> click<br />
            <b>Space</b> click \u00a0 <b>P</b> screenshot \u00a0 <b>Esc</b> back to HMD<br />
            Movement overrides HMD tracking from origin
          </div>
        <//>
      </div>
    </div>

    ${toast && html`<div class="toast show">${toast}</div>`}
  `;
}

function VideoPane({ active, imgRef, crosshairRef, overlayRef }) {
  if (!active) {
    return html`<div class="video-placeholder">
      <button onclick=${() => api("POST", "/cast/start")}>Start Casting</button>
    </div>`;
  }
  return html`
    <img id="live-frame" ref=${imgRef} alt="Quest view" />
    <div id="crosshair" ref=${crosshairRef}></div>
    <div id="drag-overlay" ref=${overlayRef}></div>
  `;
}

function Panel({ title, children }) {
  return html`<div class="panel"><h2>${title}</h2>${children}</div>`;
}

render(html`<${App} />`, document.body);
