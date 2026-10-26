"use strict";
/* ==========================================================================
   Student Attendance Management System - RKGIT
   Pure browser app: HTML + CSS + JavaScript (face-api.js for face recognition).
   Data is stored in localStorage; attendance can be exported as CSV (Excel).
   ========================================================================== */

/* ---------- configuration ---------- */
// To work offline, download the face-api.js model files into a local "models" folder
// and change this to "models/".
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/";
const MATCH_DISTANCE = 0.5;       // lower = stricter matching (typical range 0.4 - 0.6)
const DUPLICATE_DISTANCE = 0.4;   // block enrolling one face under two roll numbers
const ENROLL_SHOTS = 6;
const MIN_SHOTS = 3;
const STORE_KEY = "sams.v1";
const ROLL_RE = /^[A-Za-z0-9_-]{3,20}$/;

/* ---------- small helpers ---------- */
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

/* ---------- data layer (localStorage) ---------- */
// { students: { roll: {name, descriptors:[[128 numbers]...], enrolledAt} },
//   attendance: { "YYYY-MM-DD": { roll: "HH:MM:SS" } } }
function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && d.students && d.attendance) return d;
  } catch (e) { /* corrupted or unavailable - start fresh */ }
  return { students: {}, attendance: {} };
}
let db = loadDb();

function saveDb() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    return true;
  } catch (e) {
    toast("Could not save data (browser storage is full or blocked).");
    return false;
  }
}

function isPresent(roll, day) {
  return Boolean(db.attendance[day] && db.attendance[day][roll]);
}

function markPresent(roll, day = dateKey(), time = timeStr()) {
  if (isPresent(roll, day)) return false;
  (db.attendance[day] ||= {})[roll] = time;
  saveDb();
  return true;
}

function markAbsent(roll, day) {
  if (db.attendance[day]) {
    delete db.attendance[day][roll];
    if (!Object.keys(db.attendance[day]).length) delete db.attendance[day];
    saveDb();
  }
}

function removeStudent(roll) {
  delete db.students[roll];
  for (const day of Object.keys(db.attendance)) markAbsent(roll, day);
  saveDb();
}

/* ---------- matching ---------- */
function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function bestMatch(descriptor, exceptRoll = null) {
  let best = { roll: null, d: Infinity };
  for (const [roll, s] of Object.entries(db.students)) {
    if (roll === exceptRoll) continue;
    for (const ref of s.descriptors) {
      const d = distance(descriptor, ref);
      if (d < best.d) best = { roll, d };
    }
  }
  return best;
}

/* ---------- CSV export (opens in Excel) ---------- */
function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // prevent spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsv() {
  const days = Object.keys(db.attendance).filter((d) => Object.keys(db.attendance[d]).length).sort();
  const header = ["Roll No", "Name", ...days, "Total Present", "Percentage"];
  const lines = [header.map(csvCell).join(",")];
  for (const [roll, s] of Object.entries(db.students).sort()) {
    const marks = days.map((d) => (isPresent(roll, d) ? "P" : "A"));
    const total = marks.filter((m) => m === "P").length;
    const pct = days.length ? ((total / days.length) * 100).toFixed(1) + "%" : "0%";
    lines.push([roll, s.name, ...marks, total, pct].map(csvCell).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

function downloadCsv() {
  const blob = new Blob([buildCsv()], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `attendance_${dateKey()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- AI models ---------- */
let modelsReady = false;
let detectorOptions = null;

function setModelStatus(text, cls = "") {
  const p = $("#modelStatus");
  p.textContent = text;
  p.className = "pill " + cls;
}

async function loadModels() {
  if (typeof faceapi === "undefined") {
    setModelStatus("AI library failed to load", "error");
    $("#liveStatus").textContent = "Check your internet connection and reload the page.";
    return;
  }
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    modelsReady = true;
    setModelStatus("AI models ready", "ready");
    $("#toggleLive").disabled = false;
    $("#enrollBtn").disabled = false;
    $("#liveStatus").textContent = "Idle";
  } catch (e) {
    console.error(e);
    setModelStatus("Model download failed", "error");
    $("#liveStatus").textContent = "Could not load models. Check MODEL_URL in script.js and your connection.";
  }
}

/* ---------- camera ---------- */
let stream = null;

async function startCamera() {
  if (stream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera access needs http://localhost or HTTPS.");
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 960 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  for (const id of ["#liveVideo", "#enrollVideo"]) {
    const v = $(id);
    v.srcObject = stream;
    await v.play().catch(() => {});
    v.parentElement.classList.add("on");
  }
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  for (const id of ["#liveVideo", "#enrollVideo"]) {
    $(id).srcObject = null;
    $(id).parentElement.classList.remove("on");
  }
}

/* ---------- live recognition ---------- */
let running = false;

function drawFace(ctx, box, label, status, canvasWidth) {
  const colors = { present: "#16a34a", already: "#d97706", unknown: "#dc2626" };
  const color = colors[status] || colors.unknown;
  const fs = Math.max(14, Math.round(canvasWidth / 40));
  ctx.lineWidth = Math.max(2, canvasWidth / 320);
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.strokeStyle = color;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  const tw = ctx.measureText(label).width + 14;
  const ty = box.y - fs - 10 >= 0 ? box.y - fs - 10 : box.y + box.height;
  ctx.fillStyle = color;
  ctx.fillRect(box.x, ty, tw, fs + 10);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, box.x + 7, ty + 5);
}

async function recognitionLoop() {
  const video = $("#liveVideo");
  const canvas = $("#overlay");
  while (running) {
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        const found = await faceapi
          .detectAllFaces(video, detectorOptions)
          .withFaceLandmarks(true)
          .withFaceDescriptors();
        if (!running) break;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        $("#liveStatus").textContent = found.length ? `${found.length} face(s) detected` : "No face detected";

        const newlyMarked = [];
        for (const f of found) {
          const m = bestMatch(f.descriptor);
          let label = "Not Recognized";
          let status = "unknown";
          if (m.roll && m.d <= MATCH_DISTANCE) {
            const student = db.students[m.roll];
            const isNew = markPresent(m.roll);
            status = isNew ? "present" : "already";
            label = `${student.name} (${m.roll}) - ${isNew ? "Present" : "Already Present"}`;
            if (isNew) newlyMarked.push(student.name);
          }
          drawFace(ctx, f.detection.box, label, status, canvas.width);
        }
        if (newlyMarked.length) {
          toast("Attendance marked: " + newlyMarked.join(", "));
          renderAll();
        }
      } catch (e) {
        console.error(e);
        $("#liveStatus").textContent = "Recognition error - see console";
        await sleep(1000);
      }
    }
    await sleep(120);
  }
}

async function startRecognition() {
  if (!modelsReady) return;
  if (!Object.keys(db.students).length) toast("No students enrolled yet - everyone will show as Not Recognized.");
  try {
    await startCamera();
  } catch (e) {
    toast(e.message || "Could not access the camera.");
    return;
  }
  running = true;
  $("#toggleLive").textContent = "Stop recognition";
  $("#liveStatus").textContent = "Running…";
  recognitionLoop();
}

function stopRecognition() {
  running = false;
  $("#toggleLive").textContent = "Start recognition";
  $("#liveStatus").textContent = "Stopped";
  const c = $("#overlay");
  c.getContext("2d").clearRect(0, 0, c.width, c.height);
}

$("#toggleLive").addEventListener("click", () => (running ? stopRecognition() : startRecognition()));

/* ---------- enrollment ---------- */
function enrollMsg(text, kind = "") {
  const m = $("#enrollMsg");
  m.textContent = text;
  m.className = "msg " + kind;
}

$("#startEnrollCam").addEventListener("click", () =>
  startCamera().catch((e) => enrollMsg(e.message || "Could not access the camera.", "error"))
);

$("#enrollBtn").addEventListener("click", async () => {
  if (!modelsReady) return;
  const roll = $("#roll").value.trim();
  const name = $("#name").value.replace(/\s+/g, " ").trim();
  if (!ROLL_RE.test(roll)) return enrollMsg("Roll number must be 3-20 characters (letters, digits, - or _).", "error");
  if (!name || name.length > 60) return enrollMsg("Enter a valid student name (max 60 characters).", "error");

  const btn = $("#enrollBtn");
  btn.disabled = true;
  try {
    await startCamera();
    await sleep(600);
    const video = $("#enrollVideo");
    const descriptors = [];
    for (let i = 1; i <= ENROLL_SHOTS; i++) {
      enrollMsg(`Capturing frame ${i} of ${ENROLL_SHOTS}… keep your face in view`);
      const det = await faceapi
        .detectSingleFace(video, detectorOptions)
        .withFaceLandmarks(true)
        .withFaceDescriptor();
      if (det) descriptors.push(Array.from(det.descriptor, (x) => +x.toFixed(4)));
      await sleep(600);
    }
    if (descriptors.length < MIN_SHOTS) {
      throw new Error(`Only ${descriptors.length} of ${ENROLL_SHOTS} frames had a clear face. Improve lighting, face the camera and try again.`);
    }
    for (const d of descriptors) {
      const m = bestMatch(d, roll);
      if (m.roll && m.d < DUPLICATE_DISTANCE) {
        throw new Error(`This face is already enrolled under roll number ${m.roll}.`);
      }
    }
    const existed = Boolean(db.students[roll]);
    db.students[roll] = { name, descriptors, enrolledAt: new Date().toISOString() };
    if (!saveDb()) throw new Error("Could not save the student.");
    enrollMsg(`${existed ? "Updated" : "Enrolled"} ${name} (${roll}) using ${descriptors.length} frames.`, "good");
    $("#roll").value = "";
    $("#name").value = "";
    renderAll();
  } catch (e) {
    enrollMsg(e.message || "Enrollment failed.", "error");
  } finally {
    btn.disabled = !modelsReady;
  }
});

/* ---------- rendering ---------- */
const chip = (present) => `<span class="chip ${present ? "p" : "a"}">${present ? "Present" : "Absent"}</span>`;
const sortedStudents = () => Object.entries(db.students).sort((a, b) => a[0].localeCompare(b[0]));

function renderDashboard() {
  const today = dateKey();
  const list = sortedStudents();
  const present = list.filter(([roll]) => isPresent(roll, today)).length;
  $("#todayLabel").textContent = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  $("#sTotal").textContent = list.length;
  $("#sPresent").textContent = present;
  $("#sAbsent").textContent = list.length - present;
  $("#roster").innerHTML = list.length
    ? list.map(([roll, s]) => `<li><span>${esc(s.name)} <small style="color:var(--muted)">${esc(roll)}</small></span>${chip(isPresent(roll, today))}</li>`).join("")
    : `<li class="empty">No students enrolled yet. Use the “Enroll Student” tab.</li>`;
}

function renderRecords() {
  const day = $("#recDate").value || dateKey();
  const list = sortedStudents();
  const present = list.filter(([roll]) => isPresent(roll, day)).length;
  $("#recSummary").textContent = list.length ? `${present} present, ${list.length - present} absent on ${day}` : "";
  $("#recordsBody").innerHTML = list.length
    ? list.map(([roll, s]) => {
        const p = isPresent(roll, day);
        return `<tr>
          <td>${esc(roll)}</td><td>${esc(s.name)}</td><td>${chip(p)}</td>
          <td>${p ? esc(db.attendance[day][roll]) : "—"}</td>
          <td>
            <button class="btn small" data-act="toggle" data-roll="${esc(roll)}">${p ? "Mark absent" : "Mark present"}</button>
            <button class="btn small danger" data-act="remove" data-roll="${esc(roll)}">Remove</button>
          </td></tr>`;
      }).join("")
    : `<tr><td colspan="5" class="empty">No students enrolled yet.</td></tr>`;
}

function renderAll() {
  renderDashboard();
  renderRecords();
}

$("#recDate").value = dateKey();
$("#recDate").addEventListener("change", renderRecords);
$("#exportCsv").addEventListener("click", () => {
  if (!Object.keys(db.students).length) return toast("Nothing to export yet.");
  downloadCsv();
});

$("#recordsBody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-roll]");
  if (!btn) return;
  const roll = btn.dataset.roll;
  const day = $("#recDate").value || dateKey();
  if (btn.dataset.act === "toggle") {
    if (isPresent(roll, day)) markAbsent(roll, day);
    else markPresent(roll, day, "manual");
  } else if (btn.dataset.act === "remove") {
    if (!confirm(`Remove ${roll} and all of their attendance records?`)) return;
    removeStudent(roll);
    toast("Student removed");
  }
  renderAll();
});

$("#clearAll").addEventListener("click", () => {
  if (!confirm("Delete ALL students and attendance data from this browser? This cannot be undone.")) return;
  db = { students: {}, attendance: {} };
  saveDb();
  renderAll();
  toast("All data cleared");
});

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
    if (btn.dataset.tab !== "live" && running) stopRecognition();
    if (btn.dataset.tab === "records") stopCamera();
    renderAll();
  })
);

/* ---------- start ---------- */
renderAll();
loadModels();
