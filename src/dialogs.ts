import type {
  BatchPlan,
  BatchSourceClip,
  OutputMode,
} from "./batchPlanner.js";

export interface BatchModeOption {
  mode: OutputMode;
  enabled: boolean;
  plan?: BatchPlan;
  issues?: string[];
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function asDataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

function dialogFoundation(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;height:100%;background:#353535;color:#d4d4d4;font:12px/1.4 "AbletonSansSmall",-apple-system,BlinkMacSystemFont,sans-serif}
    body{padding:18px}
    h1{font-size:17px;line-height:1.2;margin:0 0 8px;color:#f0f0f0}
    p{margin:0 0 10px}
    .muted{color:#939393}
    .warning{margin:10px 0;padding:9px 10px;border-left:3px solid #ffa85c;background:#292929}
    .error{color:#ffb0a8}
    .options{display:grid;gap:7px;margin:12px 0}
    label.option{display:block;padding:9px 10px;border:1px solid #161616;border-radius:4px;background:#292929;cursor:pointer}
    label.option:has(input:checked){border-color:#ffa85c;background:#302a25}
    label.option.disabled{opacity:.5;cursor:not-allowed}
    input{margin:0 8px 0 0;vertical-align:-1px}
    .detail{display:block;margin:3px 0 0 22px;color:#9d9d9d}
    .list{max-height:185px;overflow:auto;border:1px solid #171717;background:#282828}
    .row{display:grid;grid-template-columns:minmax(105px,.8fr) minmax(135px,1fr) minmax(150px,1.1fr);gap:8px;padding:6px 8px;border-bottom:1px solid #3b3b3b}
    .row:last-child{border-bottom:0}
    .row.header{position:sticky;top:0;background:#202020;color:#999;font-size:10px;text-transform:uppercase}
    .buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
    button{height:24px;padding:0 15px;border:1px solid #111;border-radius:13px;background:#4a4a4a;color:#e5e5e5;font:inherit;cursor:pointer}
    button.primary{background:#ffa85c;color:#171717;font-weight:700}
    button:disabled{opacity:.45;cursor:not-allowed}
    ul{margin:7px 0 0;padding-left:20px}
  </style>
  <script>
    function send(result) {
      const message={method:"close_and_send",params:[JSON.stringify(result)]};
      if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live){
        window.webkit.messageHandlers.live.postMessage(message);
      }else if(window.chrome&&window.chrome.webview){
        window.chrome.webview.postMessage(message);
      }
    }
    document.addEventListener("keydown",event=>{
      if(event.key==="Escape")send({confirmed:false});
      if(event.key==="Enter"&&!event.repeat){
        const primary=document.querySelector("button.primary:not(:disabled)");
        if(primary)primary.click();
      }
    });
    ${script}
  </script>
</head>
<body>${body}</body>
</html>`;
}

function optionLabel(option: BatchModeOption): string {
  return option.mode === "shared"
    ? "One shared LTC track (recommended)"
    : "One LTC track per source MIDI track";
}

function optionDetail(option: BatchModeOption): string {
  if (!option.enabled) {
    return option.issues?.[0] ?? "This mode is not available for the selection.";
  }
  const trackCount = option.plan?.destinations.length ?? 0;
  return option.mode === "shared"
    ? "Creates separate WAV-backed clips on one track; gaps remain empty."
    : `Creates ${trackCount} destination track${trackCount === 1 ? "" : "s"}, grouped by source MIDI track.`;
}

export function buildBatchPreflightDialogUrl(
  options: BatchModeOption[],
  partialClips: BatchSourceClip[],
): string {
  const firstPlan = options.find((option) => option.plan)?.plan;
  const clips = firstPlan?.clips ?? [];
  const defaultMode = options.find(
    (option) => option.mode === "shared" && option.enabled,
  )?.mode ?? options.find((option) => option.enabled)?.mode;

  const optionRows = options.map((option) => {
    const checked = option.mode === defaultMode ? " checked" : "";
    const disabled = option.enabled ? "" : " disabled";
    return `<label class="option${option.enabled ? "" : " disabled"}">
      <input type="radio" name="mode" value="${option.mode}"${checked}${disabled}>
      ${escapeHtml(optionLabel(option))}
      <span class="detail${option.enabled ? "" : " error"}">${escapeHtml(optionDetail(option))}</span>
    </label>`;
  }).join("");

  const rows = clips.map((clip) => `<div class="row">
    <span>${escapeHtml(clip.source.sourceTrackName)}</span>
    <span>${escapeHtml(clip.source.name)}</span>
    <span>${escapeHtml(clip.fileName)}.wav</span>
  </div>`).join("");

  const partialWarning = partialClips.length === 0
    ? ""
    : `<div class="warning"><strong>${partialClips.length} boundary-crossing MIDI clip${partialClips.length === 1 ? "" : "s"} will be skipped.</strong>
      <div class="muted">Only clips fully contained by the Arrangement time selection are generated.</div>
      <ul>${partialClips.slice(0, 8).map((clip) =>
        `<li>${escapeHtml(clip.sourceTrackName)} — ${escapeHtml(clip.name)}</li>`
      ).join("")}${partialClips.length > 8 ? "<li>…</li>" : ""}</ul>
    </div>`;

  const body = `<h1>Create batch LTC</h1>
    <p>${clips.length} fully contained MIDI clip${clips.length === 1 ? "" : "s"} will create ${clips.length} separate LTC WAV file${clips.length === 1 ? "" : "s"}.</p>
    <p class="muted">Every output clip keeps its source bounds and color. Selection overhang and gaps stay empty. Output is explicitly unwarped.</p>
    ${partialWarning}
    <div class="options">${optionRows}</div>
    <div class="list">
      <div class="row header"><span>Source track</span><span>MIDI clip</span><span>Output file</span></div>
      ${rows}
    </div>
    <div class="buttons">
      <button onclick='send({confirmed:false})'>Cancel</button>
      <button class="primary" onclick="confirmBatch()">Create LTC</button>
    </div>`;

  return asDataUrl(dialogFoundation(
    "Create batch LTC",
    body,
    `function confirmBatch(){
      const selected=document.querySelector('input[name="mode"]:checked:not(:disabled)');
      if(selected)send({confirmed:true,mode:selected.value});
    }`,
  ));
}

export function buildNoticeDialogUrl(
  title: string,
  message: string,
  details: string[] = [],
): string {
  const detailList = details.length === 0
    ? ""
    : `<ul>${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>`;
  const body = `<h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${detailList}
    <div class="buttons"><button class="primary" onclick='send({confirmed:true})'>OK</button></div>`;
  return asDataUrl(dialogFoundation(title, body));
}
