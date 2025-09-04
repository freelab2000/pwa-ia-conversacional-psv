
import { VERSION, QUICK_PROMPTS, loadSessionMemory, saveSessionMemory, loadHistory, saveHistory, detectIntent, fallbackReply, loadPSVs, POLICY, minutesToHHMM } from './nlp.js';

const $ = sel => document.querySelector(sel);
const chatLog = $("#chatLog");
const input = $("#userInput");
const quick = $("#quickPrompts");

function addMsg(role, html){
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const who = document.createElement("div");
  who.className = "role";
  who.textContent = role === "user" ? "Tú" : "Asistente";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = html;
  wrap.appendChild(who); wrap.appendChild(bubble);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function mdEscape(s){
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

function renderQuickPrompts(){
  quick.innerHTML = "";
  QUICK_PROMPTS.forEach(p=>{
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p.label;
    b.title = p.text;
    b.addEventListener("click", ()=>{
      input.value = p.text;
      input.focus();
    });
    quick.appendChild(b);
  });
}

// Sugerencias dinámicas
function showSuggestions(list){
  const row = document.createElement("div");
  row.className = "suggest-list";
  list.forEach(t=>{
    const s = document.createElement("button");
    s.className = "suggest";
    s.textContent = t;
    s.addEventListener("click", ()=>{
      input.value = t;
      input.focus();
    });
    row.appendChild(s);
  });
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Estado / Memoria UI
function syncMemUI(mem){
  $("#memBaseLT").value = mem.baseLT||"";
  $("#memLastDep").value = mem.lastDep||"";
  $("#memLastArr").value = mem.lastArr||"";
}
function readMemFromUI(){
  return {
    baseLT: $("#memBaseLT").value.trim(),
    lastDep: $("#memLastDep").value.trim().toUpperCase(),
    lastArr: $("#memLastArr").value.trim().toUpperCase()
  };
}

async function handleSend(){
  const text = input.value.trim();
  if(!text) return;
  const mem = loadSessionMemory();
  const hist = loadHistory();

  addMsg("user", mdEscape(text));
  input.value = "";

  // NLU + lógica
  const res = detectIntent(text);
  if(res){
    // Actualizar memoria con hints del contexto
    const ctx = res.context || {};
    const newMem = { ...mem };
    if(ctx.lastDep) newMem.lastDep = ctx.lastDep;
    if(ctx.lastArr) newMem.lastArr = ctx.lastArr;
    saveSessionMemory(newMem);

    // Mensaje bot
    addMsg("bot", res.reply);
    hist.push({ role:"user", text }, { role:"bot", text: res.reply });
    saveHistory(hist); renderPSVList(); renderPolicy();
    return;
  }

  // Fallback inteligente
  const fb = fallbackReply(text);
  addMsg("bot", fb.reply);
  showSuggestions(fb.suggestions);
  hist.push({ role:"user", text }, { role:"bot", text: fb.reply });
  saveHistory(hist); renderPSVList(); renderPolicy();
}

function handleSuggest(){
  const fb = fallbackReply("");
  showSuggestions(fb.suggestions);
}

function handleExport(){
  const hist = loadHistory();
  const payload = {
    exportedAt: new Date().toISOString(),
    version: VERSION,
    history: hist
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `conv-psv-${Date.now()}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}

function handleClear(){
  saveHistory([]);
  chatLog.innerHTML = "";
  addMsg("bot", "Conversación reiniciada. ¿En qué te ayudo hoy?");
}

function handleSaveMem(){
  saveSessionMemory(readMemFromUI());
  addMsg("bot", "Memoria de sesión actualizada.");
}



function renderPSVList(){

  const list = loadPSVs();
  const box = document.querySelector("#psvList");
  if(!box) return;
  if(!list.length){ box.classList.add("empty"); box.textContent = "Sin registros aún."; return; }
  box.classList.remove("empty");
  box.innerHTML = "";
  list.forEach(p=>{
    const row = document.createElement("div");
    row.className = "psv-item";
    const left = document.createElement("div");
    left.innerHTML = `<strong>${p.dep}–${p.arr}</strong> ${p.route? "· "+p.route:""}<div class='meta'>ZR ${p.zr} min</div>`;
    const right = document.createElement("div");
    right.innerHTML = `<span class='tag'>${p.tag}</span>`;
    row.appendChild(left); row.appendChild(right);
    box.appendChild(row);
  });
}


function renderPolicy(){
  const el = document.querySelector("#policyBox");
  if(!el) return;
  el.innerHTML = `
  PD base: <code>${minutesToHHMM(POLICY.PD_BASE_MINUTES)}</code> · Offset PS: <code>+${POLICY.PD_OFFSET_FROM_PS} min</code><br/>
  ΔLON: base <code>${POLICY.LON_BASE_EXTRA} min</code> si > <code>${POLICY.LON_TRIGGER_DEG}°</code>, +<code>${POLICY.LON_STEP_MIN} min</code> c/ <code>${POLICY.LON_STEP_DEG}°</code> extra<br/>
  HV máx: <code>${minutesToHHMM(POLICY.HV_MAX_MIN)}</code> · PS máx: <code>${minutesToHHMM(POLICY.PS_MAX_MIN)}</code>`;
}

// Init
window.addEventListener("DOMContentLoaded", ()=>{
  renderQuickPrompts();
  syncMemUI(loadSessionMemory());

  $("#btnSend").addEventListener("click", handleSend);
  $("#btnSuggest").addEventListener("click", handleSuggest);
  $("#btnExport").addEventListener("click", handleExport);
  $("#btnClear").addEventListener("click", handleClear);
  $("#btnSaveMem").addEventListener("click", handleSaveMem);
  input.addEventListener("keydown", (e)=>{
    if((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==="enter"){ handleSend(); return; }
    if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); handleSend(); }
  });

  addMsg("bot", "Listo. Usa los atajos o escribe tu consulta. Sugerencia: <span class='kbd'>Agrega PSV 22:10–06:40 SCL–MIA</span>"); renderPSVList(); renderPolicy();
});

// PWA
if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  });
}
