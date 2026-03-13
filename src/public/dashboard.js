/* Quest Cast Dashboard */
const $ = (s) => document.querySelector(s);
const img = $("#live-frame");
const overlay = $("#drag-overlay");
const crosshair = $("#crosshair");
let connected = false;

// --- Toast ---
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

// --- SSE for state broadcasts ---
function connectSSE() {
  const es = new EventSource("/cast/events");
  es.addEventListener("state", (e) => {
    const s = JSON.parse(e.data);
    if ("connected" in s || "running" in s) {
      const wasConnected = connected;
      if ("connected" in s) connected = s.connected && (s.running ?? connected);
      if ("running" in s) connected = (s.connected ?? connected) && s.running;
      $("#status-dot").className = connected ? "ok" : "";
      if (connected !== wasConnected) updateHeader();
    }
    if ("pose_loop" in s) updatePoseLoopUI(s.pose_loop);
  });
  es.addEventListener("toast", (e) => {
    const d = JSON.parse(e.data);
    toast(d.message);
  });
  es.onerror = () => {
    connected = false;
    $("#status-dot").className = "";
    updateHeader();
  };
}
connectSSE();

// --- Header toggle ---
function updateHeader() {
  $("#header-cast-btn").style.display = connected ? "none" : "";
  $("#status-bar").style.display = connected ? "flex" : "none";
}

// --- Status polling ---
async function pollStatus() {
  try {
    const r = await fetch("/cast/status");
    const s = await r.json();
    $("#s-fps").textContent = s.fps;
    $("#s-res").textContent = s.width + "\u00d7" + s.height;
    $("#s-frames").textContent = s.frame_count.toLocaleString();
    $("#s-bw").textContent = (s.bytes / 1048576).toFixed(1);
    if (s.pose) {
      $("#p-xyz").textContent =
        s.pose.x.toFixed(2) + ", " + s.pose.y.toFixed(2) + ", " + s.pose.z.toFixed(2);
      $("#p-yp").textContent =
        s.pose.yaw_deg.toFixed(1) + "\u00b0 yaw, " + s.pose.pitch_deg.toFixed(1) + "\u00b0 pitch";
    }
  } catch {}
}
setInterval(pollStatus, 1000);
pollStatus();

// --- Live frame refresh ---
let frameSeq = 0;
function refreshFrame() {
  const next = new Image();
  const seq = ++frameSeq;
  next.onload = function () {
    if (seq === frameSeq) img.src = next.src;
    requestAnimationFrame(refreshFrame);
  };
  next.onerror = function () {
    setTimeout(refreshFrame, 500);
  };
  next.src = "/cast/screenshot?t=" + Date.now();
}
refreshFrame();

// --- API helpers ---
async function api(method, path, body) {
  try {
    const opts = { method };
    if (body) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    return await r.json();
  } catch (e) {
    toast("Error: " + e.message);
  }
}

// --- Cast actions ---
async function startCast() { await api("POST", "/cast/start"); }

async function stopCast() {
  if (!confirm("Stop casting session?")) return;
  await api("POST", "/cast/stop");
}

async function setConfig(w, h) { await api("POST", "/cast/config", { width: w, height: h }); }
async function setEye(mode) { await api("POST", "/cast/eye", { mode }); }
async function sendHome() { await api("POST", "/cast/home"); }

async function sendClick() {
  const r = await api("POST", "/cast/click");
  if (r?.ok) toast("Click sent");
}

function saveScreenshot() {
  const a = document.createElement("a");
  a.href = "/cast/screenshot";
  a.download = "quest-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg";
  a.click();
  toast("Screenshot saved");
}

function openStream() { window.open("/cast/stream", "_blank"); }

// --- Pose ---
async function resetPose() {
  const r = await api("POST", "/cast/pose", { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  if (r?.ok) toast("Pose reset");
}

async function goHome() {
  const r = await api("POST", "/cast/pose", { x: 0, y: 0, z: 0 });
  if (r?.ok) toast("Moved to origin");
}

async function togglePoseLoop() {
  await api("POST", "/cast/pose-loop", { active: false });
  await api("POST", "/cast/reset-view");
}

function updatePoseLoopUI(active) {
  const btn = $("#pose-loop-btn");
  const label = $("#p-loop");
  btn.disabled = !active;
  if (label) label.textContent = active ? "~27 Hz" : "off";
}

// --- Keyboard controls ---
const keysDown = new Set();

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.repeat) return;
  keysDown.add(e.key.toLowerCase());

  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) e.preventDefault();
  if (e.key === "p" || e.key === "P") { saveScreenshot(); return; }
  if (e.key === " " || e.key === "Enter") { sendClick(); return; }
  if (e.key === "Escape") { resetPose(); return; }
});

document.addEventListener("keyup", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  keysDown.delete(e.key.toLowerCase());
});

let keyLoopRunning = false;
function startKeyLoop() {
  if (keyLoopRunning) return;
  keyLoopRunning = true;
  (function tick() {
    if (keysDown.size === 0) { keyLoopRunning = false; return; }
    const ms = parseFloat($("#move-speed").value) || 0.3;
    const ls = parseFloat($("#look-speed").value) || 0.15;
    let fwd = 0, strafe = 0, yaw = 0, pitch = 0, up = 0;
    if (keysDown.has("w") || keysDown.has("arrowup")) fwd += ms;
    if (keysDown.has("s") || keysDown.has("arrowdown")) fwd -= ms;
    if (keysDown.has("a") || keysDown.has("arrowleft")) strafe -= ms;
    if (keysDown.has("d") || keysDown.has("arrowright")) strafe += ms;
    if (keysDown.has("q")) up -= ms;
    if (keysDown.has("e")) up += ms;
    if (keysDown.has("j")) yaw -= ls;
    if (keysDown.has("l")) yaw += ls;
    if (keysDown.has("i")) pitch += ls;
    if (keysDown.has("k")) pitch -= ls;

    if (fwd || strafe || yaw || pitch || up) {
      api("POST", "/cast/pose", { dz: fwd, dx: strafe, dy: up, d_yaw: yaw, d_pitch: pitch });
    }
    setTimeout(tick, 80);
  })();
}
document.addEventListener("keydown", () => startKeyLoop());

// --- Arrow button clicks ---
$("#btn-fwd").addEventListener("click", () => {
  api("POST", "/cast/pose", { dz: parseFloat($("#move-speed").value) || 0.3 });
});
$("#btn-back").addEventListener("click", () => {
  api("POST", "/cast/pose", { dz: -(parseFloat($("#move-speed").value) || 0.3) });
});
$("#btn-left").addEventListener("click", () => {
  api("POST", "/cast/pose", { dx: -(parseFloat($("#move-speed").value) || 0.3) });
});
$("#btn-right").addEventListener("click", () => {
  api("POST", "/cast/pose", { dx: parseFloat($("#move-speed").value) || 0.3 });
});

// --- Mouse drag on video for free look ---
let dragging = false, dragStartX, dragStartY;
overlay.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  crosshair.style.display = "block";
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  const sens = parseFloat($("#look-speed").value) || 0.15;
  const yaw = dx * sens * 0.02;
  const pitch = dy * sens * 0.02;
  if (yaw || pitch) api("POST", "/cast/pose", { d_yaw: yaw, d_pitch: pitch });
});

window.addEventListener("mouseup", () => {
  dragging = false;
  crosshair.style.display = "none";
});

overlay.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  sendClick();
});
