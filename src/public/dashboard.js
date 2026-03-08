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

// --- Status polling ---
async function pollStatus() {
  try {
    const r = await fetch("/status");
    const s = await r.json();
    const wasConnected = connected;
    connected = s.connected && s.running;
    $("#status-dot").className = connected ? "ok" : "";
    if (connected !== wasConnected) updateSessionButton();
    $("#s-fps").textContent = s.fps;
    $("#s-res").textContent = s.width + "\u00d7" + s.height;
    $("#s-frames").textContent = s.frame_count.toLocaleString();
    $("#s-bw").textContent = (s.bytes / 1048576).toFixed(1);
    if (s.pose) {
      $("#p-xyz").textContent =
        s.pose.x.toFixed(2) +
        ", " +
        s.pose.y.toFixed(2) +
        ", " +
        s.pose.z.toFixed(2);
      $("#p-yp").textContent =
        s.pose.yaw_deg.toFixed(1) +
        "\u00b0 yaw, " +
        s.pose.pitch_deg.toFixed(1) +
        "\u00b0 pitch";
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
    if (seq === frameSeq) {
      img.src = next.src;
    }
    requestAnimationFrame(refreshFrame);
  };
  next.onerror = function () {
    setTimeout(refreshFrame, 500);
  };
  next.src = "/screenshot?t=" + Date.now();
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

async function sendMove(forward = 0, strafe = 0, yaw = 0, pitch = 0) {
  await api("POST", "/move", { forward, strafe, yaw, pitch });
}

async function setConfig(w, h) {
  const r = await api("POST", "/config", { width: w, height: h });
  if (r?.ok) toast("Resolution: " + w + "\u00d7" + h);
}

async function setEye(mode) {
  const r = await api("POST", "/eye", { mode });
  if (r?.ok) toast("Eye mode: " + mode);
}

async function sendHome() {
  const r = await api("POST", "/home");
  if (r?.ok) toast("Home");
}

async function stopCast() {
  if (!confirm("Stop casting session?")) return;
  await api("POST", "/stop");
  toast("Casting stopped");
  updateSessionButton();
}

async function restartCast() {
  await api("POST", "/restart");
  toast("Restarting cast…");
  updateSessionButton();
}

function updateSessionButton() {
  const btn = $("#session-btn");
  if (!btn) return;
  if (connected) {
    btn.textContent = "Stop Casting";
    btn.className = "danger";
    btn.onclick = stopCast;
  } else {
    btn.textContent = "Start Casting";
    btn.className = "";
    btn.onclick = restartCast;
  }
}

function saveScreenshot() {
  const a = document.createElement("a");
  a.href = "/screenshot";
  a.download =
    "quest-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg";
  a.click();
  toast("Screenshot saved");
}

function openStream() {
  window.open("/stream", "_blank");
}

async function sendClick() {
  const r = await api("POST", "/click");
  if (r?.ok) toast("Click sent");
}

async function resetPose() {
  const r = await api("POST", "/pose", { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  if (r?.ok) {
    toast("Pose reset");
    $("#yaw-slider").value = 0;
    $("#pitch-slider").value = 0;
    $("#yaw-val").textContent = "0";
    $("#pitch-val").textContent = "0";
  }
}

async function goHome() {
  const r = await api("POST", "/pose", { x: 0, y: 0, z: 0 });
  if (r?.ok) toast("Moved to origin");
}

// --- Keyboard controls ---
const keysDown = new Set();

document.addEventListener("keydown", (e) => {
  // Don't capture keys when typing in inputs
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  if (e.repeat) return;
  keysDown.add(e.key.toLowerCase());

  // Prevent arrow keys and space from scrolling the page
  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) {
    e.preventDefault();
  }

  if (e.key === "p" || e.key === "P") {
    saveScreenshot();
    return;
  }
  if (e.key === " " || e.key === "Enter") {
    sendClick();
    return;
  }
  if (e.key === "Escape") {
    resetPose();
    return;
  }
});

document.addEventListener("keyup", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  keysDown.delete(e.key.toLowerCase());
});

// Continuous key-driven movement + look
let keyLoopRunning = false;
function startKeyLoop() {
  if (keyLoopRunning) return;
  keyLoopRunning = true;
  (function tick() {
    if (keysDown.size === 0) {
      keyLoopRunning = false;
      return;
    }
    const ms = parseFloat($("#move-speed").value) || 0.3;
    const ls = parseFloat($("#look-speed").value) || 0.15;
    let fwd = 0,
      strafe = 0,
      yaw = 0,
      pitch = 0,
      up = 0;
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
      api("POST", "/pose", {
        dz: fwd,
        dx: strafe,
        dy: up,
        d_yaw: yaw,
        d_pitch: pitch,
      });
    }
    setTimeout(tick, 80);
  })();
}
document.addEventListener("keydown", () => startKeyLoop());

// --- Arrow button clicks ---
$("#btn-fwd").addEventListener("click", () => {
  const ms = parseFloat($("#move-speed").value) || 0.3;
  api("POST", "/pose", { dz: ms });
});
$("#btn-back").addEventListener("click", () => {
  const ms = parseFloat($("#move-speed").value) || 0.3;
  api("POST", "/pose", { dz: -ms });
});
$("#btn-left").addEventListener("click", () => {
  const ms = parseFloat($("#move-speed").value) || 0.3;
  api("POST", "/pose", { dx: -ms });
});
$("#btn-right").addEventListener("click", () => {
  const ms = parseFloat($("#move-speed").value) || 0.3;
  api("POST", "/pose", { dx: ms });
});

// --- Mouse drag on video for free look ---
let dragging = false,
  dragStartX,
  dragStartY;
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
  const pitch = -dy * sens * 0.02;
  if (yaw || pitch) api("POST", "/pose", { d_yaw: yaw, d_pitch: pitch });
});

window.addEventListener("mouseup", () => {
  dragging = false;
  crosshair.style.display = "none";
});

// Right-click on video = click at gaze center
overlay.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  sendClick();
});

// --- Sliders ---
$("#yaw-slider").addEventListener("input", function () {
  const v = parseFloat(this.value);
  $("#yaw-val").textContent = this.value;
  api("POST", "/pose", { d_yaw: v * 0.1 });
});
$("#pitch-slider").addEventListener("input", function () {
  const v = parseFloat(this.value);
  $("#pitch-val").textContent = this.value;
  api("POST", "/pose", { d_pitch: v * 0.1 });
});
