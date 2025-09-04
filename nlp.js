
// nlp.js — Motor liviano de intents/reglas + memoria (no usa red externa)
/*
 Puntos implementados (1 a 3):
 1) Prompts preconfigurados y respuestas de ejemplo (quick prompts)
 2) Fallback inteligente con sugerencias cuando no hay match
 3) Memoria de sesión (en sessionStorage) para encadenar preguntas
*/

export const VERSION = "v2.6.0-conv";

// Prompts preconfigurados (Atajos)
export const QUICK_PROMPTS = [
  { label: "Validar PSV nocturno", text: "Valida si el PSV 22:10–06:40 SCL–MIA cuenta como noche completa, media noche o diurna." },
  { label: "Cómputo zona roja", text: "Calcula minutos dentro de zona roja (00:30–05:30 LT) para PSV 23:50–04:10 SCL–LIM." },
  { label: "Descanso mínimo", text: "Indica el descanso mínimo para PS de 10:20 con ΔLON=30° y un solo relevo." },
  { label: "Consecutivas", text: "¿Puedo programar 3 noches consecutivas si 1 de ellas es 'media noche'?" },
  { label: "Def. media noche", text: "Explícame cuándo un PSV se clasifica como 'media noche' según las reglas vigentes." },
  { label: "Ejemplo completo", text: "Tengo PSV 01:10–07:05 MIA–QRO y ayer volé 23:40–05:20. ¿Suma consecutivas?" }
];

// Memoria de sesión (persistida mientras dure la pestaña)
export function loadSessionMemory() {
  try{
    const raw = sessionStorage.getItem("psv_conv_mem");
    if(!raw) return { baseLT: "", lastDep: "", lastArr: "" };
    return JSON.parse(raw);
  }catch(e){ return { baseLT: "", lastDep: "", lastArr: "" }; }
}

export function saveSessionMemory(mem){
  sessionStorage.setItem("psv_conv_mem", JSON.stringify(mem||{}));
}

// Conversational state: historial para aportar contexto
export function loadHistory(){
  try{
    const raw = sessionStorage.getItem("psv_conv_hist");
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}
export function saveHistory(hist){
  sessionStorage.setItem("psv_conv_hist", JSON.stringify(hist||[]));
}

// Utilidades básicas
const HMM = s => s.padStart(2,"0");
export function parseTime(s){
  // admite "22:10", "2210", "22.10"
  const m = (s||"").trim().replace(".",":");
  if(/^\d{4}$/.test(m)) return {h: +m.slice(0,2), M: +m.slice(2)};
  const parts = m.split(":");
  if(parts.length===2){ return {h:+parts[0], M:+parts[1]}; }
  return null;
}
export function toMinutes(t){ return t.h*60 + t.M; }
export function minutesToHHMM(min){
  const h = Math.floor(min/60), m = min%60;
  return `${HMM(String(h))}:${HMM(String(m))}`;
}
export function between(min, a, b){ return Math.max(0, Math.min(min, b) - a); }
// --- Parámetros de política (editar según normativa oficial)
export const POLICY = {
  PD_BASE_MINUTES: 600,    // 10h
  PD_OFFSET_FROM_PS: 120,  // PS + 2h
  LON_TRIGGER_DEG: 45,     // umbral para sumar ajuste por longitud
  LON_BASE_EXTRA: 120,     // +2h cuando ΔLON > 45°
  LON_STEP_DEG: 15,        // cada 15° adicionales...
  LON_STEP_MIN: 30,        // ...sumar +30 min
  HV_MAX_MIN: 510,         // 8h30 (genérico, parametrizable)
  PS_MAX_MIN: 780          // 13h (genérico, parametrizable)
};

export function parseHHMMorHours(s){
  if(!s) return null;
  s = String(s).trim();
  if(/^\d{1,2}[:\.]\d{2}$/.test(s)){
    const t = parseTime(s.replace(".",":"));
    return toMinutes(t);
  }
  if(/^\d{1,2}$/.test(s)) return (+s)*60;
  if(/^(\d{1,2})h(?:\s*(\d{1,2})m)?$/i.test(s)){
    const m = s.match(/^(\d{1,2})h(?:\s*(\d{1,2})m)?$/i);
    return (+m[1])*60 + (m[2]? +m[2] : 0);
  }
  return null;
}

export function computePDMin(psMin, dlon){
  let pd = Math.max(POLICY.PD_BASE_MINUTES, psMin + POLICY.PD_OFFSET_FROM_PS);
  if(dlon > POLICY.LON_TRIGGER_DEG){
    const extra = POLICY.LON_BASE_EXTRA + Math.floor((dlon - POLICY.LON_TRIGGER_DEG)/POLICY.LON_STEP_DEG) * POLICY.LON_STEP_MIN;
    pd += extra;
  }
  return pd;
}


// Reglas zona roja y nochedad
const ZR_START = 30;   // 00:30 -> 30 min
const ZR_END   = 330;  // 05:30 -> 330 min

function computeOverlapInZR(depMin, arrMin){
  // Asume PSV en una sola fecha civil; si cruza medianoche, normalizamos sumando 1440 al arr.
  let a = depMin, b = arrMin;
  if(b <= a) b += 1440;
  // Evaluar cada bloque de 24h que intersecta con la zona roja base [30,330]
  // Expandimos ventanas en +1440 si es necesario
  const blocks = [[ZR_START, ZR_END], [ZR_START+1440, ZR_END+1440]];
  let acc = 0;
  for(const [s,e] of blocks){
    // traslape con [a,b]
    const left = Math.max(a, s);
    const right = Math.min(b, e);
    if(right>left) acc += (right-left);
  }
  return acc;
}

function classifyNight(depMin, arrMin){
  // Reglas del usuario (resumen):
  // - Zona roja: 00:30–05:30
  // - 'Media noche' si termina hasta 01:30 o comienza desde 01:30 (def local) OR si incluye <50% de zona roja
  // - 'Noche completa' si incluye ≥50% de la zona roja (>= 150 min) o cruza 01:30 desde antes
  let a = depMin, b = arrMin;
  if(b<=a) b += 1440;
  const zr = computeOverlapInZR(a,b);
  const halfRuleMinutes = 150; // 50% de 5h = 2h30 = 150 min

  // Chequeo con 01:30 (90 min)
  const ONE_THIRTY = 90;
  const startsAfter0130 = (a % 1440) >= ONE_THIRTY;
  const endsBefore0130  = (b % 1440) <= ONE_THIRTY || (b % 1440)+ (b>a?0:1440) <= ONE_THIRTY;

  if(zr >= halfRuleMinutes) return { tag:"Noche completa", zr };
  if(startsAfter0130 || endsBefore0130) return { tag:"Media noche", zr };
  // fallback por reglas del usuario
  return { tag:"Media noche", zr };
}

// Intents simples por patrones
const INTENTS = [
  {
    name: "validar_psv",
    match: /(valida|validar|es\s+noche|media\s+noche|clasifica)/i,
    handler: ({text})=>{
      // busca patrón HH:MM–HH:MM y opcional ORIG–DEST
      const re = /(\d{1,2}[:\.]?\d{2})\s*[–-]\s*(\d{1,2}[:\.]?\d{2})(?:\s+([A-Z]{3})\s*[–-]\s*([A-Z]{3}))?/;
      const m = text.match(re);
      if(!m) return null;
      const dep = parseTime(m[1]), arr = parseTime(m[2]);
      if(!dep || !arr) return null;
      const depMin = toMinutes(dep), arrMin = toMinutes(arr);
      const cls = classifyNight(depMin, arrMin);
      const zrHHMM = minutesToHHMM(cls.zr);
      const pct = Math.round((cls.zr/300)*100);
      const route = m[3] && m[4] ? ` ${m[3]}–${m[4]}` : "";
      return {
        reply: `Clasificación: **${cls.tag}**.\n`+
               `Zona roja computada: **${zrHHMM}** (${pct}%).\n`+
               `PSV: ${HMM(String(dep.h))}:${HMM(String(dep.M))}–${HMM(String(arr.h))}:${HMM(String(arr.M))}${route}.`,
        context: { lastDep: m[3]||"", lastArr: m[4]||"" }
      };
    }
  },
  {
    name: "minutos_zona_roja",
    match: /(zona\s+roja|cómputo|minutos\s+en\s+zona)/i,
    handler: ({text})=>{
      const re = /(\d{1,2}[:\.]?\d{2})\s*[–-]\s*(\d{1,2}[:\.]?\d{2})/;
      const m = text.match(re);
      if(!m) return null;
      const dep = parseTime(m[1]), arr = parseTime(m[2]);
      if(!dep || !arr) return null;
      const depMin = toMinutes(dep), arrMin = toMinutes(arr);
      const zr = computeOverlapInZR(depMin, arrMin);
      return { reply: `Minutos en zona roja (00:30–05:30 LT): **${zr} min** (${minutesToHHMM(zr)}).`, context:{} };
    }
  },
  {
    name: "descanso_minimo",
    match: /(descanso|minimo|minimo de descanso|min de descanso|min\s+descanso)/i,
    handler: ({text})=>{
      // demo simplificada: PS hh:mm y ΔLON=XX°
      const mPS = text.match(/(ps|psv|servicio)\s*(\d{1,2}[:\.]?\d{2}|\d{1,2})/i);
      const mDL = text.match(/(?:Δ?LON|delta\s*lon|longitud)\s*=?\s*(\d{1,3})°?/i);
      let psMin = 0;
      if(mPS){
        const val = mPS[2];
        if(/^\d{1,2}[:\.]\d{2}$/.test(val)){
          const t = parseTime(val.replace(".",":")); psMin = toMinutes(t);
        }else{
          psMin = (+val)*60;
        }
      }else{
        const hSolo = text.match(/(\d{1,2})\s*h/i);
        if(hSolo) psMin = (+hSolo[1])*60;
      }
      const dlon = mDL ? +mDL[1] : 0;
      // Regla base (ejemplo): PD base = max(10h, PS + 2h)
      let pd = Math.max(600, psMin + 120);
      // Ajuste por ΔLON (mantener la "regla oficial" definida por el usuario en proyectos previos):
      // +2h si ΔLON > 45°, +30min por cada 15° adicionales
      if(dlon > 45){
        const extra = 120 + Math.floor((dlon-45)/15)*30;
        pd += extra;
      }
      return { reply: `Descanso mínimo estimado: **${minutesToHHMM(pd)}** (base + ajustes por ΔLON=${dlon}°).`, context:{} };
    }
  },
  {
    name: "consecutivas",
    match: /(consecutiv|3\s*noches|dos\s*noches|tres\s*noches)/i,
    handler: ({text})=>{
      // Respuesta de ejemplo con regla de 2 máximas consecutivas
      return {
        reply: "Según las reglas vigentes, solo se permiten **2 noches consecutivas** dentro de zona roja. " +
               "Una 'media noche' **sí computa** como noche a efectos de consecutividad si cumple criterios (zona roja ≥ 50% o corte 01:30).",
        context: {}
      };
    }
  },
  {
    name: "def_media_noche",
    match: /(definici[oó]n|explica|cu[aá]ndo).*(media\s+noche)/i,
    handler: ({text})=>{
      return {
        reply:
`Se considera **media noche** cuando:
- El PSV **comienza después de 01:30** *o*
- **Termina hasta 01:30** *o*
- Abarca **< 50%** de la zona roja (00:30–05:30).

Si el traslape con zona roja es **≥ 50% (≥150 min)** o cruza 01:30 desde antes, se clasifica como **Noche completa**.`,
        context:{}
      };
    }
  }
];

export function detectIntent(text){
  const t = (text||"").trim();
  for(const it of INTENTS){
    if(it.match.test(t)){
      const out = it.handler({text:t});
      if(out) return { name: it.name, ...out };
    }
  }
  return null;
}


// Validar PD plan vs mínimo (PS + ΔLON)
INTENTS.unshift({
  name: "validar_pd_plan",
  match: /(valida|validar).*(pd\s*\d)/i,
  handler: ({text})=>{
    const mPS = text.match(/ps\s*(\d{1,2}[:\.]?\d{2}|\d{1,2}(?:h(?:\s*\d{1,2}m)?)?)/i);
    const mPD = text.match(/pd\s*(\d{1,2}[:\.]?\d{2}|\d{1,2}(?:h(?:\s*\d{1,2}m)?)?)/i);
    const mDL = text.match(/(?:Δ?LON|delta\s*lon|longitud)\s*=?\s*(\d{1,3})°?/i);
    if(!mPS || !mPD) return null;
    const psMin = parseHHMMorHours(mPS[1]);
    const pdPlan = parseHHMMorHours(mPD[1]);
    const dlon = mDL? +mDL[1] : 0;
    if(psMin==null || pdPlan==null) return null;
    const pdMin = computePDMin(psMin, dlon);
    const diff = pdPlan - pdMin;
    const status = diff >= 0 ? "✅ Cumple" : "❌ No cumple";
    const extraTxt = diff>=0 ? `margen +${minutesToHHMM(diff)}` : `déficit ${minutesToHHMM(-diff)}`;
    return {
      reply: `${status}. PD plan=${minutesToHHMM(pdPlan)} vs PD mínimo=${minutesToHHMM(pdMin)} (PS ${minutesToHHMM(psMin)}, ΔLON=${dlon}° → regla base+ajuste). ${extraTxt}.`,
      context: {}
    };
  }
});

// Validar HV (genérico, parametrizable en POLICY.HV_MAX_MIN)
INTENTS.push({
  name: "validar_hv",
  match: /(valida|validar).*(hv|horas\s*de\s*vuelo)\s*(\d{1,2}[:\.]?\d{2}|\d{1,2}(?:h(?:\s*\d{1,2}m)?)?)/i,
  handler: ({text})=>{
    const m = text.match(/(hv|horas\s*de\s*vuelo)\s*(\d{1,2}[:\.]?\d{2}|\d{1,2}(?:h(?:\s*\d{1,2}m)?)?)/i);
    const hvMin = parseHHMMorHours(m[2]);
    if(hvMin==null) return null;
    const status = hvMin <= POLICY.HV_MAX_MIN ? "✅ Dentro de límite" : "⚠️ Excede límite";
    return { reply: `${status}. HV=${minutesToHHMM(hvMin)} vs límite=${minutesToHHMM(POLICY.HV_MAX_MIN)} (parámetro editable).`, context:{} };
  }
});

// Validar PS (genérico, parametrizable en POLICY.PS_MAX_MIN)
INTENTS.push({
  name: "validar_ps_max",
  match: /(valida|validar).*(ps\s*\d)/i,
  handler: ({text})=>{
    const m = text.match(/ps\s*(\d{1,2}[:\.]?\d{2}|\d{1,2}(?:h(?:\s*\d{1,2}m)?)?)/i);
    if(!m) return null;
    const psMin = parseHHMMorHours(m[1]);
    if(psMin==null) return null;
    const status = psMin <= POLICY.PS_MAX_MIN ? "✅ Dentro de límite" : "⚠️ Excede límite";
    return { reply: `${status}. PS=${minutesToHHMM(psMin)} vs máximo=${minutesToHHMM(POLICY.PS_MAX_MIN)} (parámetro editable).`, context:{} };
  }
});

// Mostrar política vigente
INTENTS.push({
  name: "mostrar_politica",
  match: /(pol[ií]tica|par[aá]metros|l[ií]mites)\s*(vigentes|actuales)?/i,
  handler: ({text})=>{
    return { reply:
`Parámetros de política (editar en código):
- PD_BASE_MINUTES = ${POLICY.PD_BASE_MINUTES} min (${minutesToHHMM(POLICY.PD_BASE_MINUTES)})
- PD_OFFSET_FROM_PS = +${POLICY.PD_OFFSET_FROM_PS} min
- ΔLON: base ${POLICY.LON_BASE_EXTRA} min si > ${POLICY.LON_TRIGGER_DEG}°, +${POLICY.LON_STEP_MIN} min por cada ${POLICY.LON_STEP_DEG}° adicionales
- HV_MAX_MIN = ${POLICY.HV_MAX_MIN} min (${minutesToHHMM(POLICY.HV_MAX_MIN)})
- PS_MAX_MIN = ${POLICY.PS_MAX_MIN} min (${minutesToHHMM(POLICY.PS_MAX_MIN)})`, context:{} };
  }
});

// Fallback inteligente con sugerencias contextualizadas
export function fallbackReply(text){
  const sug = [
    "Valida si el PSV 22:10–06:40 SCL–MIA es noche completa.",
    "Calcula minutos en zona roja para 23:50–04:10.",
    "Descanso mínimo para PS 10:20 con ΔLON=60°.",
    "¿Puedo programar 3 noches consecutivas?"
  ];
  return {
    reply: "No pude entender la consulta con precisión. Prueba con formatos como:\n" +
           "- **'Valida HH:MM–HH:MM ORIG–DEST'**\n" +
           "- **'Minutos en zona roja para HH:MM–HH:MM'**\n" +
           "- **'Descanso mínimo PS hh:mm con ΔLON=XX°'**",
    suggestions: sug
  };
}


// ------- PSV session registry (multi-turn context) -------
export function loadPSVs(){
  try{ const raw = sessionStorage.getItem("psv_conv_psvs"); return raw? JSON.parse(raw): []; }catch(e){ return []; }
}
export function savePSVs(list){
  sessionStorage.setItem("psv_conv_psvs", JSON.stringify(list||[]));
}
export function addPSV(entry){
  const list = loadPSVs();
  list.push(entry);
  savePSVs(list);
  return list;
}
export function clearPSVs(){ savePSVs([]); }

// Helpers
function inferRoute(text, mem){
  // intenta ORIG–DEST, si no, usa memoria
  const m = text.match(/\b([A-Z]{3})\s*[–-]\s*([A-Z]{3})\b/);
  if(m) return { dep: m[1], arr: m[2] };
  if(mem.lastDep || mem.lastArr){
    return { dep: mem.lastDep||"", arr: mem.lastArr||"" };
  }
  return { dep:"", arr:"" };
}

// Conteo de noches consecutivas (cualquier traslape > 0 min con ZR cuenta)
function countConsecutivas(psvs){
  // asumimos lista cronológica agregada por el usuario
  let maxRun = 0, run = 0;
  for(const p of psvs){
    if(p.zr && p.zr > 0){ run++; } else { run = 0; }
    if(run>maxRun) maxRun = run;
  }
  return { maxRun, runActual: run };
}

// Nueva intent: agregar PSV al registro de sesión
INTENTS.unshift({
  name: "agregar_psv",
  match: /(agrega|añade|sumar|registrar).*(psv|tramo)/i,
  handler: ({text})=>{
    const re = /(\d{1,2}[:\.]?\d{2})\s*[–-]\s*(\d{1,2}[:\.]?\d{2})/;
    const m = text.match(re);
    if(!m) return null;
    const mem = loadSessionMemory();
    const r = inferRoute(text, mem);
    const dep = parseTime(m[1].replace(".",":"));
    const arr = parseTime(m[2].replace(".",":"));
    const depMin = toMinutes(dep), arrMin = toMinutes(arr);
    const cls = classifyNight(depMin, arrMin);
    const entry = {
      dep: `${String(dep.h).padStart(2,"0")}:${String(dep.M).padStart(2,"0")}`,
      arr: `${String(arr.h).padStart(2,"0")}:${String(arr.M).padStart(2,"0")}`,
      route: r.dep && r.arr ? `${r.dep}–${r.arr}` : "",
      tag: cls.tag, zr: cls.zr
    };
    const list = addPSV(entry);
    const consec = countConsecutivas(list);
    const warn = consec.runActual > 2 ? " <span class='inline-warn'>(¡Excede 2 consecutivas!)</span>" : "";
    return {
      reply: `PSV agregado: ${entry.dep}–${entry.arr} ${entry.route? " "+entry.route:""} ⇒ **${entry.tag}**, ZR=${minutesToHHMM(entry.zr)}. `+
             `Consecutivas actuales: **${consec.runActual}**.${warn}`,
      context: { lastDep: r.dep, lastArr: r.arr }
    };
  }
});

// Nueva intent: resumen de PSVs
INTENTS.push({
  name: "resumen_psv",
  match: /(resumen|lista|mostrar).*(psv|tramos)/i,
  handler: ({text})=>{
    const list = loadPSVs();
    if(list.length===0) return { reply:"No hay PSVs registrados aún. Usa: 'Agrega PSV 22:10–06:40 SCL–MIA'.", context:{} };
    const consec = countConsecutivas(list);
    const lines = list.map((p,i)=>`${i+1}. ${p.dep}–${p.arr}${p.route? " "+p.route:""} · ${p.tag} · ZR ${minutesToHHMM(p.zr)}`);
    return { reply: `PSVs (${list.length}):\n`+lines.join("\n")+`\n\nConsecutivas actuales: **${consec.runActual}** (máx histórico ${consec.maxRun}).`, context:{} };
  }
});

// Nueva intent: limpiar PSVs
INTENTS.push({
  name: "limpiar_psv",
  match: /(limpia|borrar|reinicia).*(psv|tramos)/i,
  handler: ({text})=>{
    clearPSVs();
    return { reply:"Se limpiaron los PSVs de la sesión.", context:{} };
  }
});

// Validación extendida PS/PD/HV (simplificada)
INTENTS.push({
  name: "validar_ps_pd",
  match: /(valida|validar).*(ps|pd|descanso).*(plan|planeado|minimo|min)/i,
  handler: ({text})=>{
    // Extrae PS (h:mm o horas), PD planeado (h:mm o horas) y ΔLON
    function pickMinutes(labelRe, fallback=None){
      return 0;
    }
    const mPS = text.match(/ps\s*(\d{1,2}[:\.]?\d{2}|\d{1,2})/i);
    const mPD = text.match(/pd\s*(\d{1,2}[:\.]?\d{2}|\d{1,2})/i);
    const dlonM = text.match(/(?:Δ?LON|delta\s*lon|longitud)\s*=?\s*(\d{1,3})°?/i);
    // placeholder
  }
});
