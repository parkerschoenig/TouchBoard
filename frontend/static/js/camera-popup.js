// Camera pop-ups: when Frigate sees something, show that camera full screen
// for a few seconds over whatever page is up.
//
// The server pushes {type: "camera_event", camera, label, stream_url, ...}
// for every new Frigate detection. Each screen filters them with its own
// profile option:
//   camera_popup: {
//     enabled: false,
//     labels: ["person"],    // which detections pop up (none ticked = person)
//     cameras: [],           // which cameras (empty = every camera)
//     seconds: 30,           // how long it stays up; a new detection extends it
//     cooldown: 120          // then the same camera stays quiet this long
//   }
// Test pop-ups (from the editor) skip the filters.

import { renderWidget } from "./widgets.js";

const pretty = (s) => String(s || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

export function createCameraPopups(getOptions) {
  let cur = null;                    // { camera, back, until, tick, labelEl, test }
  const quietUntil = {};             // camera → time it may pop up again

  const cfg = () => {
    const c = getOptions()?.camera_popup || {};
    return {
      enabled: !!c.enabled,
      labels: Array.isArray(c.labels) && c.labels.length ? c.labels : ["person"],
      cameras: Array.isArray(c.cameras) ? c.cameras : [],
      seconds: clamp(c.seconds, 5, 600, 30),
      cooldown: clamp(c.cooldown, 0, 3600, 120),
    };
  };

  function close() {
    if (!cur) return;
    clearInterval(cur.tick);
    cur.back.remove();
    // only real detections start the quiet time; a test mustn't silence the camera
    if (!cur.test) quietUntil[cur.camera] = Date.now() + cfg().cooldown * 1000;
    cur = null;
  }

  function describe(ev) {
    return [pretty(ev.sub_label || ev.label), ev.zones?.length ? `in ${pretty(ev.zones[0])}` : ""].filter(Boolean).join(" ");
  }

  function open(ev, seconds) {
    const back = document.createElement("div");
    back.className = "cam-pop";
    back.dataset.holdsPage = "1";            // the display stays put while it's up
    back.innerHTML = `
      <div class="cam-pop-box" role="dialog">
        <div class="cam-pop-head">
          <span class="cam-pop-dot"></span>
          <b class="cam-pop-label"></b>
          <span class="cam-pop-cam"></span>
          <button type="button" class="cam-pop-close" aria-label="Close">✕</button>
        </div>
        <div class="cam-pop-video"></div>
        <div class="cam-pop-bar"><i></i></div>
      </div>`;
    const labelEl = back.querySelector(".cam-pop-label");
    labelEl.textContent = describe(ev);
    back.querySelector(".cam-pop-cam").textContent = pretty(ev.camera)
      + (ev.test ? (cfg().enabled ? " · test" : " · test (pop-ups are off on this screen)") : "");
    back.setAttribute("aria-label", `${labelEl.textContent} at ${pretty(ev.camera)}`);
    back.querySelector(".cam-pop-video").appendChild(
      renderWidget({ id: -9000, type: "stream", title: "", config: { stream_url: ev.stream_url } }, { data: { url: ev.stream_url } }, { hideTitle: true }));
    back.addEventListener("click", close);   // tap anywhere to dismiss
    document.body.appendChild(back);

    const bar = back.querySelector(".cam-pop-bar i");
    const total = seconds * 1000;
    cur = { camera: ev.camera, back, labelEl, until: Date.now() + total, total, test: !!ev.test };
    cur.tick = setInterval(() => {
      const left = cur.until - Date.now();
      bar.style.width = `${Math.max(0, Math.min(100, (left / cur.total) * 100))}%`;
      if (left <= 0) close();
    }, 200);
  }

  function onEvent(ev) {
    const c = cfg();
    if (!ev.test) {
      if (!c.enabled) return;
      if (!c.labels.includes(ev.label)) return;
      if (c.cameras.length && !c.cameras.includes(ev.camera)) return;
    }
    if (cur && cur.camera === ev.camera) {            // same camera: keep it up longer
      cur.until = Date.now() + c.seconds * 1000;
      cur.total = c.seconds * 1000;
      cur.labelEl.textContent = describe(ev);
      if (cur.test && !ev.test) { cur.test = false; cur.back.querySelector(".cam-pop-cam").textContent = pretty(ev.camera); }
      return;
    }
    if (!ev.test && (quietUntil[ev.camera] || 0) > Date.now()) return;
    if (cur) { clearInterval(cur.tick); cur.back.remove(); cur = null; }   // newest camera wins
    open(ev, c.seconds);
  }

  return { onEvent, close, isOpen: () => !!cur };
}
