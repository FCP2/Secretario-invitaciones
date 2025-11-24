// ===== Estado global =====
let catalogo = [];          // personas [{ID, Nombre, Cargo, ...}]
let catalogIndex = {};      // índice por ID -> persona
let actores = [];           // actores [{ID, Nombre, Cargo, ...}]
let actoresIndex = {};      // índice por ID -> actor
let sexos = [];             // [{id, nombre}]
let PARTIDOS = [];          // [{nombre}]
let invIndex = {};          // índice de invitaciones por ID (se llena en reloadUI)

let currentStatus = "";     // filtro activo
let currentId = null;       // invitación activa en modal gestionar
let currentRange = { from: "", to: "" };
let personaTS = null;
let actorTS = null;
let lastSeenISO = null;  // servidor nos devolverá "now" para encadenar

// Para recordar el último grupo usado
let LAST_GROUP_TOKEN = '';

// ===== Utils DOM =====
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const coloresPartidos = {
  'MORENA':'#831E30','PAN':'#0056a4','PRI':'#FF0000','PRD':'#ffcf00',
  'PT':'#F8AE42','PVEM':'#78be20','MC':'#f58025','INDEPENDIENTE':'#888','OTRO':'#666'
};
function colorPorPartido(valor) {
  if (!valor) return 'OTRO';
  const v = valor.toUpperCase().replace(/\s+/g,'');
  if (v.includes('MORENA')) return 'MORENA';
  if (v.includes('PAN'))    return 'PAN';
  if (v.includes('PRI'))    return 'PRI';
  if (v.includes('PRD'))    return 'PRD';
  if (v.includes('PT'))     return 'PT';
  if (v.includes('PVEM'))   return 'PVEM';
  if (v.includes('MC'))     return 'MC';
  return 'OTRO';
}
function partidoPillHtml(partido) {
  if (!partido) return '';
  const key = colorPorPartido(partido);            // devuelve 'MORENA','PAN',...
  const color = coloresPartidos[key] || coloresPartidos['OTRO'];
  // contrast: PRD (amarillo) needs dark text
  const darkTextFor = new Set(['PRD']);
  const textColor = darkTextFor.has(key) ? '#222' : '#fff';
  // escape texto de partido (simple)
  const safeText = String(partido).replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<span class="badge rounded-pill" style="background:${color}; color:${textColor}; font-weight:600;">${safeText}</span>`;
}


//HELPERS ROL========
// wrapper para llamadas al API (usa tu apiGet/apiPost existentes)
async function fetchCurrentUser() {
  if (window.CACHED_USER) return window.CACHED_USER;
  try {
    const r = await apiGet('/api/auth/me'); // tu wrapper
    if (r && r.ok) {
      window.CACHED_USER = { id: r.id, usuario: r.usuario, rol: r.rol };
      return window.CACHED_USER;
    } else {
      window.CACHED_USER = null;
      return null;
    }
  } catch (e) {
    window.CACHED_USER = null;
    return null;
  }
}

function roleAllowed(role, rolesAttr) {
  if (!role) return false;
  if (!rolesAttr) return false;
  const allowed = rolesAttr.split(',').map(s=>s.trim()).filter(Boolean);
  return allowed.includes(role);
}

async function applyRoleUI() {
  const user = await fetchCurrentUser();
  const role = user ? (user.rol || user.role) : null;
  document.querySelectorAll('[data-roles]').forEach(el => {
    const rolesAttr = el.getAttribute('data-roles') || '';
    const allowed = roleAllowed(role, rolesAttr);
    if (!allowed) {
      if (el.hasAttribute('data-disable-only')) {
        el.disabled = true;
        el.classList.add('disabled');
        // opcional: evitar clicks
        el.addEventListener('click', e => e.stopImmediatePropagation(), { capture: true });
      } else {
        // ocultar
        el.style.display = 'none';
      }
    } else {
      el.style.display = '';
      el.disabled = false;
    }
  });

  // optional: mostrar rol en UI
  const roleEl = document.getElementById('currentRoleBadge');
  if (roleEl) {
    roleEl.textContent = role || 'Invitado';
    roleEl.classList.remove('d-none');
  }
}

// Llamar al inicio de tu app (después del login) y después de renderizar modales
document.addEventListener('DOMContentLoaded', () => {
  applyRoleUI();
});

// Reaplicar cuando abres modales dinámicos
document.addEventListener('shown.bs.modal', (e) => {
  applyRoleUI();
});
// ===== Fetch helpers (no cache) =====
async function fetchJSON(url, opts = {}) {
  const u = new URL(url, window.location.origin);
  u.searchParams.set('_ts', Date.now()); // cache-buster
  const res = await fetch(u, { cache: 'no-store', credentials: 'same-origin', ...opts });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const apiGet  = (url) => fetchJSON(url);
const apiPost = (url, body={}) => fetchJSON(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// ===== Catálogos =====
async function loadPartidos(){
  try{
    PARTIDOS = await apiGet('/api/partidos');
    const fill = (selId) => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = '<option value="">-- Seleccione partido --</option>' +
        PARTIDOS.map(p => `<option value="${p.nombre}">${p.nombre}</option>`).join('');
      if (cur) sel.value = cur;
    };
    fill('cPartido');
    fill('ePartido');
  }catch(e){
    console.warn('No se pudieron cargar partidos', e);
  }
}

async function loadPersonas(force = false) {
  window.STATE = window.STATE || {};
  if (!force && Array.isArray(STATE.personas) && STATE.personas.length) return STATE.personas;

  let rows = [];
  try {
    rows = await apiGet('/api/personas');
  } catch (e) {
    console.warn('Fallo /api/personas, intentando /api/catalog...', e);
    try {
      const cat = await apiGet('/api/catalog');
      // api_catalog puede devolver array directo o {personas: [...]}
      rows = Array.isArray(cat) ? cat : (Array.isArray(cat?.personas) ? cat.personas : []);
    } catch (e2) {
      console.error('No se pudieron cargar personas:', e2);
      rows = [];
    }
  }

  STATE.personas = (Array.isArray(rows) ? rows : []).map(p => {
    // normalizar nombres posibles para region
    const regionId = p.RegionID ?? p.region_id ?? p.regionId ?? p.region_id ?? p.region ?? null;
    const regionNombre = p.RegionNombre ?? p.region_nombre ?? p.regionName ?? p.region_name ?? (typeof p.region === 'object' ? (p.region.nombre || p.region.name) : null);

    return {
      ID:    p.ID ?? p.id ?? p.Id ?? null,
      Nombre: p.Nombre ?? p.nombre ?? '',
      Cargo: p.Cargo ?? p.cargo ?? '',
      Telefono: p['Teléfono'] ?? p.Telefono ?? p.telefono ?? '',
      Correo:   p.Correo ?? p.correo ?? '',
      Unidad:   p['Unidad/Región'] ?? p.unidad_region ?? p.Unidad ?? '',
      SexoID:   p.SexoID ?? p.sexo_id ?? null,
      // particulares
      ParticularNombre: p.ParticularNombre ?? p.particular_nombre ?? '',
      ParticularCargo:  p.ParticularCargo  ?? p.particular_cargo  ?? '',
      ParticularTel:    p.ParticularTel    ?? p.particular_tel    ?? '',
      Activo: p.Activo ?? p.activo ?? true,
      // --- campos de región (nuevos) ---
      RegionID: regionId ?? null,
      RegionNombre: regionNombre ?? null
    };
  }).filter(p => p.ID != null);

  // índice para lecturas rápidas en el modal (incluye región)
  catalogIndex = {};
  for (const p of STATE.personas) catalogIndex[p.ID] = p;

  return STATE.personas;
}


async function loadCatalog(force = false) {
  try {
    if (!force && Array.isArray(STATE.catalogPersonas) && STATE.catalogPersonas.length) {
      return STATE.catalogPersonas;
    }

    const rows = await apiGet('/api/catalog'); // tu endpoint actual
    STATE.catalogPersonas = Array.isArray(rows) ? rows : [];

    // Reconstruye el índice ID -> persona
    window.catalogIndex = {};
    for (const p of STATE.catalogPersonas) {
      if (p.ID != null) {
        catalogIndex[String(p.ID)] = p;
      }
    }

    // Si tienes un render del combo/personas, llámalo aquí:
    if (typeof renderPersonasSelect === 'function') {
      renderPersonasSelect(STATE.catalogPersonas);
    }

    return STATE.catalogPersonas;
  } catch (e) {
    console.error('Error al cargar catálogo:', e);
    STATE.catalogPersonas = [];
    window.catalogIndex = {};
    if (typeof renderPersonasSelect === 'function') {
      renderPersonasSelect([]);
    }
    return [];
  }
}

async function loadActores() {
  let data = [];
  try { data = await apiGet('/api/actores'); } catch (e) { console.warn('No se pudieron cargar actores', e); }
  actores = Array.isArray(data) ? data : [];
  actoresIndex = {};
  const sel = $('#selActor');
  if (sel) sel.innerHTML = '<option value=""></option>';

  for (const a of actores) {
    actoresIndex[a.ID] = a;
    if (sel) {
      const opt = document.createElement('option');
      opt.value = String(a.ID);
      opt.textContent = a.Nombre || '';
      sel.appendChild(opt);
    }
  }
}
// === Cargar catálogo de regiones y poblar #npRegion y #epRegion ===
async function loadRegiones() {
  try {
    // Intentamos usar tu wrapper apiGet si existe (envía cookies automáticamente)
    let body = null;
    if (typeof apiGet === 'function') {
      try {
        body = await apiGet('/api/regiones'); // tu endpoint existente
      } catch (err) {
        console.warn('apiGet("/api/regiones") falló, intentando fetch directo...', err);
        body = null;
      }
    }

    // fallback a fetch directo si apiGet no devolvió array
    if (!body) {
      try {
        const res = await fetch('/api/regiones', { credentials: 'same-origin', cache: 'no-store' });
        if (res.ok) {
          body = await res.json().catch(() => null);
        } else {
          console.warn('/api/regiones status', res.status, res.statusText);
          // intenta la ruta alternativa si existe
          const res2 = await fetch('/api/regiones/list', { credentials: 'same-origin', cache: 'no-store' });
          if (res2.ok) body = await res2.json().catch(() => null);
        }
      } catch (e) {
        console.error('fetch /api/regiones error', e);
        body = null;
      }
    }

    // Normalizar respuesta: puede venir como array o como { regiones: [...] }.
    let regiones = [];
    if (Array.isArray(body)) {
      regiones = body;
    } else if (body && Array.isArray(body.regiones)) {
      regiones = body.regiones;
    } else if (body && Array.isArray(body.data)) {
      regiones = body.data;
    } else if (body && body.ok === true && Array.isArray(body.regiones)) {
      regiones = body.regiones;
    } else if (body && typeof body === 'object') {
      // buscar primer array plausible
      const cand = Object.values(body).find(v => Array.isArray(v) && v.length && (v[0].id || v[0].nombre || v[0].name));
      if (cand) regiones = cand;
    }

    // construir opciones HTML
    const opts = ['<option value="">— Ninguna —</option>']
      .concat((regiones || []).map(r => {
        const id = r.id ?? r.ID ?? r.value ?? '';
        const label = (r.nombre ?? r.name ?? r.title ?? '').toString();
        return `<option value="${id}">${label}</option>`;
      })).join('');

    // poblar selects
    const selNew = document.getElementById('npRegion');
    const selEdit = document.getElementById('epRegion');

    

    if (selNew) selNew.innerHTML = opts;
    if (selEdit) selEdit.innerHTML = opts;

    // cache
    window.STATE = window.STATE || {};
    window.STATE.regiones = regiones || [];

    console.log('loadRegiones: cargadas', window.STATE.regiones.length, 'regiones');
    return window.STATE.regiones;
  } catch (err) {
    console.error('Error en loadRegiones:', err);
    return [];
  }
}

// === Cargar catálogo de sexos y poblar los 4 selects ===
async function loadSexos() {
  try {
    const sexos = await apiGet('/api/catalogo/sexo'); // [{id, nombre}]
    const opts = ['<option value="">—</option>'].concat(
      (sexos || []).map(s => `<option value="${s.id}">${s.nombre}</option>`)
    ).join('');

    ['npSexo','epSexo','naSexo','eaSexo'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) sel.innerHTML = opts;
    });
  } catch (e) {
    console.error('Error cargando sexos:', e);
  }
}




// ===== Formateo fecha/hora (UI) =====
function toInputDate(v) {
  if (!v) return '';
  const s = String(v);
  if (s.includes('T')) return s.split('T')[0];           // ISO full -> fecha
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;           // YYYY-MM-DD
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);    // dd/mm/yy
  if (m) { const yy = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${yy}-${m[2]}-${m[1]}`; }
  return '';
}
function toInputTime(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s.slice(0,5);
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  return '';
}
function getFecha(inv){ return inv.FechaFmt || inv.Fecha || ''; }
function getHora(inv){  return inv.HoraFmt  || inv.Hora  || ''; }
function getUltMod(inv){ return inv.UltimaModFmt || inv["Última Modificación"] || ''; }
function getFechaAsig(inv){ return inv.FechaAsignacionFmt || inv["Fecha Asignación"] || ''; }

// Normaliza el valor de "Convoca Cargo"
function normCargo(v){
  const s = String(v || "").toLowerCase().trim();
  if (!s) return "";
  if (s.includes("diputad")) return "dip";
  if (s.includes("president")) return "pres";
  return "otros";
}

// ===== Render de tarjetas/listas =====
function statusPill(s){
  const map = {Pendiente:"secondary", Confirmado:"success", Sustituido:"warning", Cancelado:"danger"};
  const cls = map[s] || "secondary";
  return `<span class="badge text-bg-${cls}">${s||"—"}</span>`;
}


// ===== Filtros por municipio =====
function normalizeMunicipio(s){
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
function getMuni(inv){
  return String(inv["Municipio/Dependencia"] || "").trim();
}
function populateMunicipios(invs){
  const sel = document.getElementById('fMuni');
  if (!sel) return;
  const map = new Map();
  for (const inv of invs){
    const raw = getMuni(inv);
    if (!raw) continue;
    const key = normalizeMunicipio(raw);
    if (!map.has(key)) map.set(key, raw.trim());
  }
  const uniq = Array.from(map.values()).sort((a,b)=>a.localeCompare(b,'es'));
  const prev = sel.value;
  sel.innerHTML = '<option value="">Todos los municipios</option>' +
                  uniq.map(m => `<option value="${m}">${m}</option>`).join('');
  if (prev && uniq.includes(prev)) sel.value = prev;
}

// ===== Render lista + KPIs =====
// ── Helpers mínimos ─────────────────────────────────────────────
function normCargo(value){
  const c = norm(value || '');
  if (!c) return 'otros';
  if (c.includes('diput'))     return 'dip';
  if (c.includes('president')) return 'pres';
  return 'otros';
}

function getMuni(inv){
  return (inv.Municipio || '').trim();
}

function renderListInto(list, sel){
  const cont = document.querySelector(sel);
  if (!cont) return;
  if (!list.length){
    cont.innerHTML = '<div class="text-muted small">Sin registros</div>';
    return;
  }

  const html = list.map(x => {
    const fecha        = fmtFechaISO(x.Fecha);
    const hora         = safe(x.Hora);
    const actor        = safe(x.ActorNombre) || safe(x.Convoca) || '—';
    const persona      = safe(x.PersonaNombre) || 'Sin asignar';
    const partido      = safe(x.Partido || x.PartidoPolitico || x.Partido_Politico);
    const convocaCargo = safe(x.ConvocaCargo || '');
    const municipio    = safe(x.Municipio || '');
    const lugar        = safe(x.Lugar || '');
    const archivoHTML = x.ArchivoNombre ? `
    <a class="btn btn-sm btn-outline-secondary p-1"
      href="/api/invitation/${encodeURIComponent(x.ID)}/archivo"
      target="_blank" rel="noopener"
      title="Ver archivo adjunto">
      <i class="bi bi-paperclip"></i>
    </a>` : '';

    return `
    <div class="col-12 col-md-6 col-lg-4">
      <div class="card shadow-sm h-100" id="card-${x.ID}">
        <div class="card-header py-2 d-flex justify-content-between align-items-center">
          <span class="small text-muted">${fecha} ${hora ? ('· ' + hora) : ''}</span>
          <span class="badge ${badgeByStatus(x.Estatus)}">${safe(x.Estatus) || 'Pendiente'}</span>
        </div>
        <div class="card-body">
          <div class="fw-semibold mb-1">${safe(x.Evento)}</div>
          <div class="small"><i class="bi bi-megaphone me-1"></i><b>Convoca:</b> ${actor}</div>
          ${convocaCargo ? `<div class="small text-muted">${convocaCargo}</div>` : ''}
          <div class="small"><i class="bi bi-person-check me-1"></i><b>Asignado a:</b> ${persona}</div>
          <div class="small"><i class="bi bi-geo-alt me-1"></i>${municipio} · ${lugar}</div>
          <div class="mt-2">${partido ? partidoPillHtml(partido) : ''}</div>
          ${x.Observaciones ? `<div class="small text-muted mt-2">${safe(x.Observaciones)}</div>` : ''}
        </div>
        <div class="card-footer d-flex gap-2">
          <button class="btn btn-sm btn-primary" data-action="manage" data-id="${x.ID}">
            <i class="bi bi-pencil-square me-1"></i>Designar
          </button>
          <button class="btn btn-sm btn-warning" data-action="edit-inv" data-id="${x.ID}">
            <i class="bi bi-pencil me-1"></i>Editar
          </button>
          <button class="btn btn-sm btn-outline-secondary" data-action="details" data-id="${x.ID}">
            <i class="bi bi-eye me-1"></i>Detalles
          </button>
          <button class="btn btn-sm btn-danger" data-action="delete-inv" data-id="${x.ID}">
            <i class="bi bi-trash3"></i>
          </button>
          <span class="ms-auto">${archivoHTML}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  cont.innerHTML = html;
}

// ===== Carga/recarga UI =====
function toYMD(s) {
  // Acepta 'YYYY-MM-DD', ISO con 'T', o Date
  if (!s) return '';
  if (s instanceof Date) {
    const yy = s.getFullYear();
    const mm = String(s.getMonth()+1).padStart(2,'0');
    const dd = String(s.getDate()).padStart(2,'0');
    return `${yy}-${mm}-${dd}`;
  }
  const str = String(s);
  if (str.includes('T')) return str.slice(0,10);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0,10);
  // dd/mm/yyyy → yyyy-mm-dd (por si viene así)
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return str; // último recurso
}

function normalizeInvitation(row){
  const r = {...row};
  r.Fecha = toYMD(row.Fecha || row.FechaFmt);
  // (opcional) asegúrate de tener ID como string
  r.ID = String(row.ID ?? row.id ?? '');
  return r;
}
let uiToken = 0;

async function reloadUI(){
  const my = ++uiToken;

  // 1) Trae invitaciones (con filtro de estatus si lo usas en servidor)
  const status = document.querySelector('#statusBtns .btn.active')?.dataset.status || "";
  const fetched = await apiGet('/api/invitations' + (status ? `?estatus=${encodeURIComponent(status)}` : ''));
  if (my !== uiToken) return;

  // 2) Normaliza TODO y guárdalo en STATE
  const allNorm = (fetched || []).map(normalizeInvitation);
  STATE.invitaciones = allNorm;              // <-- CLAVE para calendario y "Eventos del día"

  // 3) Index global por ID (del total, no del filtrado)
  invIndex = {};
  for (const r of allNorm) invIndex[r.ID] = r;

  // 4) Aplica filtros de UI (locales) para la vista de tarjetas
  const d1 = (document.getElementById('fDesde')?.value || '').trim(); // YYYY-MM-DD
  const d2 = (document.getElementById('fHasta')?.value || '').trim();

  let invs = allNorm;
  if (d1 || d2){
    invs = invs.filter(inv => {
      const iso = inv.Fecha;
      if (!iso) return false;
      if (d1 && iso < d1) return false;
      if (d2 && iso > d2) return false;
      return true;
    });
  }

  populateMunicipios(invs);
  const muniSel = (document.getElementById('fMuni')?.value || '').trim();
  if (muniSel){
    invs = invs.filter(inv => getMuni(inv) === muniSel);
  }

  // 5) Partición por categoría (según tu lógica)
  const dipList   = invs.filter(inv => normCargo(inv.ConvocaCargo) === 'dip').sort(porFechaHoraAsc);
  const presList  = invs.filter(inv => normCargo(inv.ConvocaCargo) === 'pres').sort(porFechaHoraAsc);
  const otrosList = invs.filter(inv => normCargo(inv.ConvocaCargo) === 'otros').sort(porFechaHoraAsc);

  renderListInto(dipList,   "#groupDip");
  renderListInto(presList,  "#groupPres");
  renderListInto(otrosList, "#groupOtros");

  // 6) KPIs
  const kpi = { Pendiente:0, Confirmado:0, Sustituido:0, Cancelado:0 };
  invs.forEach(i => { const e = i.Estatus || "Pendiente"; if (kpi[e] != null) kpi[e]++; });

  const set = (sel,val)=>{ const el=document.querySelector(sel); if(el) el.textContent=val; };
  set('#kpiPend', kpi.Pendiente);
  set('#kpiConf', kpi.Confirmado);
  set('#kpiSubs', kpi.Sustituido);
  set('#kpiCanc', kpi.Cancelado);

  // Contadores por tab
  const setCnt = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCnt('cntDip',   dipList.length);
  setCnt('cntPres',  presList.length);
  setCnt('cntOtros', otrosList.length);

  if (typeof adjustMainPadding === 'function') adjustMainPadding();

  // ⚠️ IMPORTANTE:
  // No llames renderCalendarModule() aquí.
  // Después de crear/editar/eliminar, tú ya llamas refreshCalendarUI(...) en los handlers.
}

function initPersonaTomSelect(modalEl, inv) {
  try { if (window.personaTS) window.personaTS.destroy(); } catch {}
  window.personaTS = null;

  const sel = document.getElementById('selPersona');
  if (!sel) return;

  // Mete opciones en el <select> base
  const opts = ['<option value="">— Sin asignar —</option>']
    .concat( (STATE.personas || []).map(p =>
      `<option value="${p.ID}">${p.Nombre}${p.Cargo ? ' — ' + p.Cargo : ''}</option>`
    ));
  sel.innerHTML = opts.join('');

  // Inicializa TomSelect
  window.personaTS = new TomSelect('#selPersona', {
    searchField: ['text'],
    dropdownParent: modalEl.querySelector('.modal-content'),
    openOnFocus: false,
    allowEmptyOption: true,
    maxOptions: 1000
  });

  // Preselección si la invitación ya tiene persona
  if (inv?.PersonaID != null) {
    window.personaTS.setValue(String(inv.PersonaID), true);
    const p = catalogIndex[inv.PersonaID];
    const rol = p?.Cargo || '';
    const inpRol = document.getElementById('inpRol');
    if (inpRol) inpRol.value = rol;
  } else {
    window.personaTS.clear(true);
  }

  // Eventos
  window.personaTS.on('change', (val) => {
    const p = catalogIndex[val] || null;
    const inpRol = document.getElementById('inpRol');
    if (inpRol) inpRol.value = p?.Cargo || '';
  });
  window.personaTS.on('type', (str) => { if (str && str.length >= 1) window.personaTS.open(); else window.personaTS.close(); });
  window.personaTS.on('focus', () => window.personaTS.close());
}
// ===== Clicks globales (UN SOLO LISTENER) =====
let _removeFile = false;

document.addEventListener('click', async (e) => {
  
  const btn = e.target.closest('button');
  if (!btn) return;

// ======== GESTIONAR (abrir modal de asignación) ========
if (btn.dataset.action === 'assign' || btn.dataset.action === 'manage') {
  currentId = btn.dataset.id;
  const inv = invIndex[currentId] || {};

  const metaEl = document.getElementById('assignMeta');
  if (metaEl) metaEl.textContent = `${inv.Evento || ''} — ${getFecha(inv)} ${getHora(inv)}`;

  if ($('#inpRol')) $('#inpRol').value = '';
  if ($('#inpComentario')) $('#inpComentario').value = '';

  const modalAssignEl = document.getElementById('modalAssign');
  if (!modalAssignEl) { console.warn('No existe #modalAssign'); return; }

  /** -------------------------------------------------------------
   * LISTENER PRINCIPAL: SHOWN DEL MODAL
   * Se ejecuta SOLO UNA VEZ por sesión.
   * --------------------------------------------------------------*/
  modalAssignEl.addEventListener('shown.bs.modal', async () => {

    /* =========================
       HELPERS / UTILITIES
    ==========================*/
    const normalizeMunicipioKey = s => (String(s || '').trim()
      .replace(/\s+/g,' ')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toLowerCase()
    );

    // renderRegionPersonas fallback (si no tienes una global compatible)
    function renderRegionPersonasLocal(regionId, personsArray) {
      try {
        const sel = document.getElementById('regPersona');
        if (!sel) return;
        sel.innerHTML = ['<option value="">— Seleccione —</option>']
          .concat((personsArray || []).map(p => {
            const id = p.ID ?? p.id ?? '';
            const nombre = (p.Nombre ?? p.nombre ?? '') || '';
            const cargo = (p.Cargo ?? p.cargo) ? ' — ' + (p.Cargo ?? p.cargo) : '';
            const data = encodeURIComponent(JSON.stringify(p || {}));
            return `<option data-meta="${data}" value="${id}">${nombre}${cargo}</option>`;
          }))
          .join('');
      } catch (e) { console.warn('renderRegionPersonasLocal fallo', e); }
    }

    const safeRenderRegionPersonas = (regionId, personsArray) => {
      try {
        if (typeof renderRegionPersonas === 'function') {
          try { renderRegionPersonas(regionId, personsArray); return; } catch(e){ console.warn('renderRegionPersonas custom fallo', e); }
        }
      } catch(e){}
      renderRegionPersonasLocal(regionId, personsArray);
    };

    const localSetRegionAndPersons = (regionIdLocal, personsArray) => {
      if (!window.REGION_MODULE) window.REGION_MODULE = { personasPorRegion: {} };
      window.REGION_MODULE.personasPorRegion[String(regionIdLocal)] = personsArray || [];
      const regSel = document.getElementById('regRegion');
      if (regSel) regSel.value = String(regionIdLocal);
      try { safeRenderRegionPersonas(String(regionIdLocal), personsArray); } catch (e) { console.warn(e); }
      try { new bootstrap.Tab(document.querySelector('#tab-region-tab')).show(); } catch (e) {}
    };

    // Asegura mapa + features + polygonsLayer y opcionalmente pinta una región
    async function ensureMapReadyAndShowRegion(regionIdToShow = null) {
      try {
        const mod = window.MUNICIPIOS_MODULE;
        if (!mod) {
          if (typeof bootstrapMunicipiosAndMap === 'function') {
            try { await bootstrapMunicipiosAndMap(); } catch(e){ console.warn('bootstrapMunicipiosAndMap fallback falló', e); }
          }
        }
        const Mmod = window.MUNICIPIOS_MODULE || mod;
        if (!Mmod) return;

        // cargar features si faltan
        if (!(Mmod.features && Mmod.features.length)) {
          try { await Mmod.loadMunicipiosJson(Mmod.MUNICIPIOS_URL || '/static/municipios.json'); }
          catch(e){ console.warn('ensure: loadMunicipiosJson fallo', e); }
        }

        // init map si hace falta
        if (!Mmod.map) {
          try { Mmod.initMunicipiosMap && Mmod.initMunicipiosMap('regMap'); }
          catch(e){ console.warn('ensure: initMunicipiosMap fallo', e); }
        }

        // crear polygonsLayer si no existe
        if (!Mmod.polygonsLayer && Mmod.map) {
          try {
            Mmod.polygonsLayer = L.geoJSON(null, {
              style: (feature)=>({ color:'#0b5ed7', weight:1, fillOpacity:0.35 }),
              onEachFeature: (f, layer) => {
                const name = (f.properties && f.properties.municipio) ? f.properties.municipio : 'Municipio';
                layer.bindTooltip(name, { sticky:true });
              }
            }).addTo(Mmod.map);
          } catch(e){ console.warn('ensure: crear polygonsLayer fallo', e); }
        }

        // añadir featureCollection en bloque si no hay sublayers
        try {
          let layerCount = 0;
          Mmod.polygonsLayer?.eachLayer(()=> layerCount++);
          if (!layerCount && Mmod.featureCollection) {
            if (typeof Mmod.safeAddGeoJSON === 'function') {
              await Mmod.safeAddGeoJSON(Mmod.polygonsLayer, Mmod.featureCollection);
            } else {
              const tmp = L.geoJSON(Mmod.featureCollection);
              tmp.eachLayer(l => Mmod.polygonsLayer.addLayer(l));
            }
          }
        } catch(e){ console.warn('ensure: añadir featureCollection fallo', e); }

        // mostrar región solicitada
        if (regionIdToShow) {
          try {
            if (typeof Mmod.showMunicipiosForRegion === 'function') {
              Mmod.showMunicipiosForRegion(regionIdToShow);
            } else if (typeof window.showMunicipiosForRegion === 'function') {
              window.showMunicipiosForRegion(regionIdToShow);
            }
          } catch(e){ console.warn('ensure: showMunicipiosForRegion fallo', e); }
        }

        // forzar invalidateSize por si el contenedor estaba oculto
        try { setTimeout(()=> { Mmod.map && Mmod.map.invalidateSize && Mmod.map.invalidateSize(); }, 120); } catch(e){}
      } catch(e) {
        console.warn('ensureMapReadyAndShowRegion error', e);
      }
    }

    /* =====================================================
       1) INICIALIZAR REGIONES + MUNICIPIOS (temprano)
    ======================================================*/
    try {
      try { await bootstrapRegionCache(); } catch(e){ console.warn('bootstrapRegionCache falló:', e); }
      await ensureMapReadyAndShowRegion(null);
    } catch (e) {
      console.warn('Error inicializando módulos región/municipios:', e);
    }

    /* =====================================================
       2) CARGA DE CATÁLOGOS
    ======================================================*/
    try { await Promise.all([ loadPersonas(true), loadActores(true), loadSexos(),loadRegiones() ]); }
    catch(e){ console.warn('Catálogos fallaron parcialmente:', e); }

    /* =====================================================
       3) SELECT PERSONA (TomSelect)
    ======================================================*/
    try {
      let list = window.STATE?.personas?.length ? window.STATE.personas.slice()
            : window.STATE?.catalogPersonas?.length ? window.STATE.catalogPersonas.slice()
            : [];

      if (!list.length) {
        try {
          const cat = await apiGet('/api/catalog');
          list = Array.isArray(cat?.personas) ? cat.personas : (Array.isArray(cat) ? cat : []);
        } catch(e){ /* ignore */ }
      }

      const selPersona = modalAssignEl.querySelector('#selPersona');
      if (selPersona) {
        selPersona.innerHTML = [
          '<option value="">— Sin asignar —</option>',
          ...list.map(p => {
            const id = p.ID ?? p.id ?? '';
            const nombre = (p.Nombre ?? p.nombre ?? '').replace(/</g,'&lt;');
            const cargo = p.Cargo ?? p.cargo ?? '';
            return `<option value="${id}">${nombre}${cargo ? ' — '+cargo : ''}</option>`;
          })
        ].join('');

        if (window.personaTS) try { window.personaTS.destroy(); } catch(e){ console.warn(e); }
        window.personaTS = new TomSelect(selPersona, {
          searchField:['text'],
          dropdownParent:modalAssignEl.querySelector('.modal-content'),
          openOnFocus:true, allowEmptyOption:true, maxOptions:1000
        });

        const personaId = inv.PersonaID ? String(inv.PersonaID) : '';
        if (personaId) try { window.personaTS.setValue(personaId, true); } catch(e){ /* ignore */ }

        setTimeout(()=> {
          const ci = window.personaTS?.control_input;
          if (ci) ci.setAttribute('placeholder','Escribe para buscar representante…');
        },40);
      }
    } catch(e){ console.warn('Error inicializando select persona:', e); }

    /* =====================================================
       4) LIMPIEZAS UI
    ======================================================*/
    if ($('#inpRol')) $('#inpRol').value = '';
    if ($('#inpComentario')) $('#inpComentario').value = '';
    try { updatePersonaInlineButtons(); } catch (e) { console.warn(e); }

    /* =====================================================
       5) INFERIR / OBTENER RÉGION SEGÚN MUNICIPIO y PINTAR
    ======================================================*/
    const muni = (inv.Municipio || inv.municipio || '').trim();
    let regionId = null;

    if (muni) {
      try {
        const spinner = document.getElementById('regLoading');
        if (spinner) spinner.classList.remove('d-none');

        let resp = null;
        try { resp = await apiGet('/api/personas/recomendadas?municipio='+encodeURIComponent(muni)); }
        catch(e){ console.warn('api/personas/recomendadas fallo', e); }

        if (spinner) spinner.classList.add('d-none');

        const personasResp = resp?.personas ?? resp ?? [];
        const regionIds = resp?.region_ids ?? (resp?.region_id ? [resp.region_id] : []);

        if (Array.isArray(personasResp) && personasResp.length) {
          regionId = regionIds.length ? String(regionIds[0]) : null;
          if (regionId) {
            if (typeof setRegionAndPersons === 'function') setRegionAndPersons(regionId, personasResp);
            else localSetRegionAndPersons(regionId, personasResp);
          }
        } else {
          regionId = inferRegionIdByMunicipio(muni)
            || window.REGION_MODULE?.muniToRegion?.[normalizeMunicipioKey(muni)]
            || null;

          if (regionId) {
            const cached = window.REGION_MODULE?.personasPorRegion?.[String(regionId)];
            if (cached?.length) {
              localSetRegionAndPersons(regionId, cached);
            } else {
              try {
                const pr = await apiGet(`/api/regiones/${regionId}/personas`);
                localSetRegionAndPersons(regionId, pr.personas || pr || []);
              } catch(e){ console.warn('fetch personas por region falló', e); }
            }
          }
        }

        // Pintar la región ya (fix principal)
        try { if (regionId) await ensureMapReadyAndShowRegion(regionId); } catch(e){ console.warn('Error pintando región al abrir modal:', e); }
      } catch(e){ console.warn('Error inferencia región por municipio:', e); }
    }

    /* =====================================================
       6) RENDER PERSONA POR REGIÓN -> preview compacto + "Usar en general"
           (preview SOLO en la pestaña región; NO actualizamos #personaInfo en General)
    ======================================================*/
    (function attachRegionPersonaHandlers() {
      const regPersonaSel = document.getElementById('regPersona');
      const regionPersonaInfoEl = document.getElementById('regionPersonaInfo');
      const personaInfoEl = document.getElementById('personaInfo'); // lo dejamos por si necesitas algo, pero no lo actualizamos desde región
      const selPersonaGlobal = document.getElementById('selPersona');
      const inpRolEl = document.getElementById('inpRol');
      const btnEditInline = document.getElementById('btnEditPersonaInline');
      const btnDeleteInline = document.getElementById('btnDeletePersonaInline');

      function renderSmallPreview(pObj, targetEl) {
        if (!targetEl) return;
        if (!pObj) {
          targetEl.innerHTML = '<div class="text-muted small">Selecciona una persona para ver su información.</div>';
          return;
        }
        const nombre = pObj.Nombre ?? pObj.nombre ?? '';
        const cargo = pObj.Cargo ?? pObj.cargo ?? '';
        const telefono = pObj.Telefono ?? pObj.telefono ?? pObj.Tel ?? '';
        const correo = pObj.Email ?? pObj.email ?? pObj.Correo ?? '';
        const foto = pObj.FotoURL ?? pObj.foto ?? pObj.Foto ?? '';

        targetEl.innerHTML = `
          <div class="d-flex align-items-start gap-2">
            ${ foto ? `<img src="${foto}" alt="${nombre}" class="rounded" style="width:56px;height:56px;object-fit:cover">`
                   : `<div class="rounded" style="width:56px;height:56px;background:#e9ecef;width:56px;height:56px"></div>` }
            <div class="flex-fill">
              <div class="fw-semibold small mb-1">${nombre}</div>
              <div class="small text-muted mb-1">${cargo}</div>
              <div class="small text-muted">${ telefono ? `<i class="bi bi-telephone-fill me-1"></i>${telefono}` : '' } ${ correo ? `<i class="bi bi-envelope-fill ms-2 me-1"></i>${correo}` : '' }</div>
            </div>
          </div>
          <div class="mt-2 d-flex gap-2">
            <button id="btnUsePersonaGeneral" class="btn btn-sm btn-primary">Usar en asignación general</button>
          </div>
        `;
      }

      if (regPersonaSel) {
        regPersonaSel.addEventListener('change', (ev) => {
          try {
            const opt = ev.target.selectedOptions && ev.target.selectedOptions[0];
            if (!opt) { renderSmallPreview(null, regionPersonaInfoEl); return; }
            const meta = opt.getAttribute('data-meta');
            let pObj = null;
            if (meta) {
              try { pObj = JSON.parse(decodeURIComponent(meta)); } catch(e){ pObj = null; }
            }
            if (!pObj) {
              const personsCache = window.REGION_MODULE?.personasPorRegion || {};
              const all = Object.values(personsCache).flat();
              pObj = all.find(x => String(x.ID ?? x.id ?? '') === String(opt.value)) || null;
            }
            renderSmallPreview(pObj, regionPersonaInfoEl);

            // attach buttons handlers
            setTimeout(()=> {
              const btnUse = document.getElementById('btnUsePersonaGeneral');
              if (btnUse) {
                btnUse.onclick = () => {
                  try {
                    if (!pObj) return;
                    const personaId = pObj.ID ?? pObj.id ?? '';
                    if (!personaId) return;

                    // 1) setear TomSelect si existe (y triggerear sus listeners)
                    if (window.personaTS && typeof window.personaTS.setValue === 'function') {
                      try { window.personaTS.setValue(String(personaId), true); } catch(e){ console.warn('personaTS.setValue fallo', e); }
                    } else if (selPersonaGlobal) {
                      selPersonaGlobal.value = String(personaId);
                      try { selPersonaGlobal.dispatchEvent(new Event('change')); } catch(e){}
                    }

                    // 2) rellenar cargo (inpRol)
                    try { if (inpRolEl) inpRolEl.value = (pObj.Cargo ?? pObj.cargo ?? ''); } catch(e){}

                    // 3) habilitar botones inline (editar / eliminar) y setear data-persona-id
                    try {
                      if (btnEditInline) {
                        btnEditInline.disabled = false;
                        btnEditInline.dataset.personaId = String(personaId);
                      }
                      if (btnDeleteInline) {
                        btnDeleteInline.disabled = false;
                        btnDeleteInline.dataset.personaId = String(personaId);
                      }
                      // si tienes función que actualiza estados de botones, llamarla
                      try { if (typeof updatePersonaInlineButtons === 'function') updatePersonaInlineButtons(); } catch(e){ console.warn('updatePersonaInlineButtons fallo', e); }
                    } catch(e){ console.warn('Habilitar botones inline fallo', e); }

                    // 4) cambiar a tab general (no modificamos #personaInfo desde región)
                    try { new bootstrap.Tab(document.querySelector('#tab-general-tab')).show(); } catch(e){}

                  } catch(err) { console.warn('btnUsePersonaGeneral click error', err); }
                };
              }

              const btnView = document.getElementById('btnViewPersonaFull');
              if (btnView) {
                btnView.onclick = () => {
                  try {
                    // Mostrar más info podría abrir otro modal; por ahora dejamos el preview limitado a la pestaña región
                    // Si quieres abrir modal detalle aquí, llama tu función correspondiente.
                    // No se copia a pestaña general la ficha automáticamente (solo el ID/cargo/btns).
                  } catch(e){ console.warn('btnViewPersonaFull click error', e); }
                };
              }
            }, 20);

          } catch(e){ console.warn('regPersona change handler fallo', e); }
        });

        // disparar si ya hay seleccionado
        try {
          const cur = regPersonaSel.value;
          if (cur) regPersonaSel.dispatchEvent(new Event('change'));
        } catch(e){}
      } else {
        if (regionPersonaInfoEl) regionPersonaInfoEl.innerHTML = '<div class="text-muted small">Selecciona una persona para ver su información.</div>';
      }
    })();

    /* =====================================================
       7) Asegura pintar región cuando se cambia a pestaña Región
    ======================================================*/
    (function attachTabAndSelectHandlers() {
      const tabBtn = document.querySelector('#tab-region-tab');
      if (tabBtn && !tabBtn._regionInit) {
        tabBtn._regionInit = true;
        tabBtn.addEventListener('shown.bs.tab', async () => {
          try {
            const sel = document.getElementById('regRegion');
            const rid = sel?.value || null;
            await ensureMapReadyAndShowRegion(rid);
          } catch(e){ console.warn('shown.bs.tab handler error', e); }
        });
      }

      const regSel = document.getElementById('regRegion');
      if (regSel && !regSel._changeAttached) {
        regSel._changeAttached = true;
        regSel.addEventListener('change', async (ev) => {
          const newRid = String(ev.target.value || '').trim();
          if (!newRid) return;
          const cached = window.REGION_MODULE?.personasPorRegion?.[newRid];
          if (cached && cached.length) {
            safeRenderRegionPersonas(newRid, cached);
          } else {
            try {
              const pr = await apiGet(`/api/regiones/${encodeURIComponent(newRid)}/personas`);
              const personas = pr?.personas ?? (Array.isArray(pr) ? pr : []);
              safeRenderRegionPersonas(newRid, personas);
              window.REGION_MODULE = window.REGION_MODULE || {};
              window.REGION_MODULE.personasPorRegion = window.REGION_MODULE.personasPorRegion || {};
              window.REGION_MODULE.personasPorRegion[newRid] = personas;
            } catch(e){ console.warn('fetch personas por region fallo', e); }
          }
          await ensureMapReadyAndShowRegion(newRid);
        });
      }
    })();

  }, { once: true });

  /* =====================================================
     MOSTRAR MODAL
  ====================================================== */
  new bootstrap.Modal(modalAssignEl).show();
  return;
}

  // ========== DETALLES (abre modal nuevo) ==========
  if (btn && btn.dataset && btn.dataset.action === 'details') {
    e.preventDefault();
    const id = (btn.dataset.id || '').trim();

    try {
      if (!id) throw new Error('Falta data-id en el botón.');

      // Buscar primero en el índice global
      let inv = (window.invIndex || {})[id];

      // Fallback: busca directo en el array por si no está indexado
      if (!inv) {
        inv = (STATE.invitaciones || []).find(r => {
          const rid = String(r?.ID ?? r?.id ?? r?.Id ?? r?.uuid ?? '').trim();
          return rid === id;
        });
      }

      if (!inv) {
        console.warn('[details] id no encontrado:', id);
        throw new Error('No encontré esa invitación en invIndex.');
      }

      showDetails(inv);
    } catch (err) {
      console.error('[details] Error:', err);
      alert('No se pudo abrir Detalles: ' + (err.message || err));
    }

    return;
  }
// ========== CREAR INVITACIÓN ==========
if (btn.id === 'btnCrear') {
  await withBusy(btn, async () => {
    const fFecha = ($('#cFecha').value || '').trim();
    const fHora  = ($('#cHora').value  || '').trim();
    const evento = ($('#cEvento').value || '').trim();
    const cargo  = ($('#cConvocaCargo').value || '').trim();
    const partido= ($('#cPartido').value || '').trim();
    const muni   = ($('#cMuni').value || '').trim();
    const lugar  = ($('#cLugar').value || '').trim();
    const obs    = ($('#cObs').value || '').trim();
    const subTipo= ($('#cSubTipo').value || '').trim();
    const actorId= ($('#cActor')?.value || '').trim();

    // Validaciones básicas
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fFecha)) { alert('Fecha inválida (usa AAAA-MM-DD)'); return; }
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(fHora)) { alert('Hora inválida (usa HH:MM)'); return; }
    if (!actorId || !/^\d+$/.test(actorId)) { alert('Selecciona un actor válido'); return; }

    const fd = new FormData();
    fd.append('fecha', fFecha);
    fd.append('hora',  fHora);
    fd.append('evento', evento);
    fd.append('convoca_cargo', cargo);
    fd.append('partido_politico', partido);
    fd.append('municipio', muni);
    fd.append('lugar', lugar);
    fd.append('observaciones', obs);

    if (subTipo) fd.set('sub_tipo', subTipo);

    // Grupo
    const chkVinc = document.getElementById('cVincular');
    const inpGrupo = document.getElementById('cGrupoToken');

    if (chkVinc?.checked) {
      let gt = (inpGrupo?.value || '').trim();
      if (!gt) {
        // Genera uno nuevo la primera vez
        gt = 'GRP-' + Math.random().toString(36).slice(2, 10).toUpperCase();
        if (inpGrupo) inpGrupo.value = gt;
      }
      fd.set('grupo_token', gt);
      LAST_GROUP_TOKEN = gt;  // recordamos el último grupo usado
    }

    fd.append('actor_id', actorId);

    const file = $('#cArchivo')?.files?.[0];
    if (file) fd.append('archivo', file);

    // Refuerzo de obligatorios
    const oblig = ['fecha','hora','evento','convoca_cargo','municipio','lugar','actor_id'];
    const faltan = oblig.filter(k => !fd.get(k));
    if (faltan.length) { alert('Faltan: ' + faltan.join(', ')); return; }

    const res = await fetch('/api/invitation/create', {
      method: 'POST',
      credentials: 'same-origin',
      body: fd
    });
    if (!res.ok) {
      let t = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j?.error) t = j.error; } catch {}
      throw new Error(t);
    }

    // Cierra modal
    bootstrap.Modal.getInstance($('#modalCreate'))?.hide();

    // Limpia form
    resetCreateForm?.();

    // datos frescos y repinta calendario en la fecha creada
    await reloadUI();
    refreshCalendarUI({ preserve: true, hintDate: fFecha });
  });
  return;
}




    // ========== EDITAR (ABRIR) ==========
  if (btn.dataset.action === 'edit-inv') {
    const id  = btn.dataset.id;
    const inv = invIndex[id] || {};

    // Campos base
    $('#eId').value     = inv.ID || '';
    $('#eFecha').value  = toInputDate(inv.Fecha || '');
    $('#eHora').value   = toInputTime(inv.Hora  || '');
    $('#eEvento').value = inv.Evento || '';

    const selCC  = $('#eConvocaCargo'); if (selCC)  selCC.value  = inv.ConvocaCargo || '';
    const selPar = $('#ePartido');      if (selPar) selPar.value = inv.Partido || '';

    $('#eMuni').value = inv.Municipio || '';
    $('#eLugar').value = inv.Lugar || '';
    $('#eObs').value = inv.Observaciones || '';

    // ===== Archivo =====
    const link      = $('#eFileLink');
    const btnRemove = $('#eBtnFileRemove');
    const prev      = $('#eFilePreview');
    const inpFile   = $('#eArchivo');

    // Limpia estado previo
    if (inpFile) inpFile.value = '';
    _removeFile = false;
    btnRemove?.classList.add('d-none');
    btnRemove?.removeAttribute('data-remove');   // limpia flag
    link?.classList.add('d-none');
    if (link) { link.href = '#'; link.textContent = 'Ver archivo actual'; }
    prev.textContent = '';

    if (inv.ArchivoURL) {
      // Usa la URL que te da el backend o construye una:
      // const archivoURL = inv.ArchivoURL || `/api/invitation/${encodeURIComponent(inv.ID)}/archivo`;
      const archivoURL = inv.ArchivoURL;

      link.classList.remove('d-none');
      link.href = archivoURL;
      link.textContent = inv.ArchivoNombre || 'Ver archivo actual';

      btnRemove.classList.remove('d-none');
      prev.textContent = inv.ArchivoNombre ? `Actual: ${inv.ArchivoNombre}` : '';
    }

    new bootstrap.Modal(document.getElementById('modalEdit')).show();
    return;
  }

    // ========== EDITAR (QUITAR ARCHIVO) ==========
  if (btn.id === 'eBtnFileRemove') {
    if (!confirm('¿Quitar el archivo actual?')) return;

    _removeFile = true;

    // Oculta botón y link, limpia preview y file input
    $('#eBtnFileRemove')?.classList.add('d-none');
    $('#eBtnFileRemove')?.setAttribute('data-remove','1'); // flag opcional
    $('#eFileLink')?.classList.add('d-none');
    $('#eFileLink')?.setAttribute('href','#');
    $('#eFilePreview').textContent = 'Se quitará el archivo al guardar.';
    const inp = $('#eArchivo'); if (inp) inp.value = '';

    return;
  }

  // ========== EDITAR (GUARDAR) ==========
  if (btn.id === 'btnEditarGuardar') {
    const msg = $('#eMsg');
    msg.classList.add('d-none'); 
    msg.textContent = '';

    // 1) Junta datos del form
    const idInv   = ($('#eId').value || '').trim();
    const fechaIn = ($('#eFecha').value || '').trim();   // YYYY-MM-DD para hintDate
    const horaIn  = ($('#eHora').value  || '').trim();

    const fd = new FormData();
    fd.append('id', idInv);
    fd.append('fecha', fechaIn);
    fd.append('hora',  horaIn);
    fd.append('evento', ($('#eEvento').value || '').trim());
    fd.append('convoca_cargo', ($('#eConvocaCargo').value || '').trim());
    fd.append('partido_politico', ($('#ePartido').value || '').trim());
    fd.append('municipio', ($('#eMuni').value || '').trim());
    fd.append('lugar', ($('#eLugar').value || '').trim());
    fd.append('observaciones', ($('#eObs').value || '').trim());

    const file = $('#eArchivo')?.files?.[0];
    if (file) {
      // Subir archivo nuevo => NO mandar eliminar_archivo
      fd.append('archivo', file);
    } else if (_removeFile) {
      // Quitar archivo actual
      fd.append('eliminar_archivo', 'true');
    }

    // 2) Validación mínima
    const oblig = ['fecha','hora','evento','convoca_cargo','municipio','lugar'];
    for (const k of oblig) {
      if (!String(fd.get(k) || '').trim()) {
        msg.textContent = `Falta ${k}`;
        msg.classList.remove('d-none');
        return;
      }
    }

    // 3) Persistir y refrescar UI
    try {
      const res = await fetch('/api/invitation/update', {
        method: 'POST',
        credentials: 'same-origin',
        body: fd
      });
      if (!res.ok) {
        let t = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); if (j?.error) t = j.error; } catch {}
        throw new Error(t);
      }

      // Cierra modal y limpia flag de eliminación
      bootstrap.Modal.getInstance($('#modalEdit'))?.hide();
      _removeFile = false;

      // 🔄 Repinta todo (listas, KPIs e índice global)
      await reloadUI();

      // 📅 Refresca calendario y "Eventos del día" hacia la fecha editada
      refreshCalendarUI({ preserve: true, hintDate: fechaIn });

      // 🎯 (Opcional) Enfoca la tarjeta en el listado principal

    } catch (e2) {
      msg.textContent = e2.message || 'No se pudo guardar.';
      msg.classList.remove('d-none');
    }
    return;
  }

    // ========== ASIGNAR PERSONA ==========
  if (btn.id === 'btnAsignar') {
    const personaId = ($('#selPersona').value || '').trim();
    const rol = ($('#inpRol').value || '').trim();
    const cmt = ($('#inpComentario').value || '').trim();
    if (!personaId) { alert('Selecciona una persona.'); return; }

    try {
      await apiPost('/api/assign', { id: currentId, persona_id: personaId, rol, comentario: cmt });

      // Actualiza estado de botones inline ANTES de cerrar el modal
      updatePersonaInlineButtons();

      // Cierra y recarga
      bootstrap.Modal.getInstance($('#modalAssign')).hide();
      await reloadUI();
      refreshCalendarUI({ preserve: true, hintDate: fFecha });
    } catch (err) {
      alert('Error en asignación: ' + (err.message || ''));
    }
    return;
  }


  // ========== ASIGNAR ACTOR (si usas este flujo) ==========
  if (btn.id === 'btnAsignarActor') {
    const actorId = ($('#selActor')?.value || '').trim();
    const rol = ($('#inpRol')?.value || '').trim();
    const cmt = ($('#inpComentario')?.value || '').trim();
    if (!actorId) { alert('Selecciona un actor.'); return; }
    try {
      await apiPost('/api/assign', { id: currentId, actor_id: actorId, rol, comentario: cmt });
      bootstrap.Modal.getInstance($('#modalAssign')).hide();
      await reloadUI();
    } catch (err) { alert('Error en asignación por actor: ' + (err.message || '')); }
    return;
  }

  // ========== SUSTITUIR ==========
  if (btn.id === 'btnSustituir') {
    const personaId = ($('#selPersona').value || '').trim();
    const rol       = ($('#inpRol').value || '').trim();
    const cmt       = ($('#inpComentario').value || 'Sustitución por instrucción').trim();
    if (!personaId) { alert('Selecciona la nueva persona.'); return; }
    try {
      await apiPost('/api/assign', { id: currentId, persona_id: personaId, rol, comentario: cmt, force: true });
      bootstrap.Modal.getInstance($('#modalAssign')).hide();
      await reloadUI();
    } catch (err) { alert('Error al sustituir: ' + (err.message || '')); }
    return;
  }

  // ========== CANCELAR ==========
  if (btn.id === 'btnCancelar') {
    const cmt = $('#inpComentario').value || 'Cancelado por indicación';
    const fd = new FormData();
    fd.append('id', currentId);
    fd.append('estatus', 'Cancelado');
    fd.append('observaciones', cmt);
    try {
      await fetch('/api/invitation/update', { method:'POST', body: fd });
      bootstrap.Modal.getInstance($('#modalAssign')).hide();
      await reloadUI();
    } catch (err) { alert('Error al cancelar: ' + (err.message || '')); }
    return;
  }

  // ========== REACTIVAR ==========
  if (btn.id === 'btnReactivar') {
    const cmt = $('#inpComentario').value || 'Reactivado';
    const fd = new FormData();
    fd.append('id', currentId);
    fd.append('estatus', 'Pendiente');
    fd.append('observaciones', cmt);
    try {
      await fetch('/api/invitation/update', { method:'POST', body: fd });
      bootstrap.Modal.getInstance($('#modalAssign')).hide();
      await reloadUI();
    } catch (err) { alert('Error al reactivar: ' + (err.message || '')); }
    return;
  }

  // ========== LIMPIAR ASIGNACIÓN ==========
  if (btn.id === 'btnLimpiar') {
    if (!currentId) { alert('No hay invitación seleccionada.'); return; }
    const ok = confirm('Esto devolverá la invitación a "Pendiente" y limpiará la asignación. ¿Continuar?');
    if (!ok) return;
    const fd = new FormData();
    fd.append('id', currentId);
    fd.append('estatus', 'Pendiente');
    fd.append('persona_id', '');
    fd.append('actor_id', '');
    fd.append('observaciones', 'Limpieza de asignación por corrección');
    try {
      await fetch('/api/invitation/update', { method:'POST', body: fd });
      bootstrap.Modal.getInstance($('#modalAssign')).hide();
      await reloadUI();
    } catch (err) { alert('No se pudo limpiar: ' + (err.message || '')); }
    return;
  }



 // Abrir modal "Nueva persona" (puedes tener un botón que lance esto)
if (btn.id === 'btnOpenNewPersona') {
  // Limpia campos
  $('#npMsg')?.classList.add('d-none');
  $('#npNombre').value = '';
  $('#npCargo').value = '';
  $('#npTelefono').value = '';
  $('#npCorreo').value = '';
  $('#npUnidad').value = '';
  $('#npPartNombre').value = '';
  $('#npPartCargo').value = '';
  $('#npPartTel').value = '';
  // Sexo
  if (typeof loadSexos === 'function') { try { await loadSexos(); } catch {} }
  await loadRegiones(); 
  new bootstrap.Modal(document.getElementById('modalNewPersona')).show();
  return;
}

// Guardar "Nueva persona"
if (btn.id === 'btnGuardarPersona') {
  const msg = document.getElementById('npMsg');
  msg.classList.add('d-none'); msg.textContent = '';

  const nombre = ($('#npNombre').value || '').trim();
  const cargo  = ($('#npCargo').value || '').trim();
  const tel    = ($('#npTelefono').value || '').replace(/\D/g,'');
  const correo = ($('#npCorreo').value || '').trim();
  const unidad = ($('#npUnidad').value || '').trim();
  const sexoId = ($('#npSexo').value || '').trim();
  const regionId = ($('#npRegion').value || '').trim();
  const partNom = ($('#npPartNombre').value || '').trim();
  const partCar = ($('#npPartCargo').value  || '').trim();
  const partTel = ($('#npPartTel').value    || '').replace(/\D/g,'');



  if (!nombre || !cargo) {
    msg.textContent = 'Nombre y Cargo son obligatorios.'; msg.classList.remove('d-none');
    return;
  }
  if (tel && !/^\d{10}$/.test(tel)) {
    msg.textContent = 'El teléfono debe tener 10 dígitos.'; msg.classList.remove('d-none');
    return;
  }
  if (partTel && !/^\d{10}$/.test(partTel)) {
    msg.textContent = 'El teléfono particular debe tener 10 dígitos.'; msg.classList.remove('d-none');
    return;
  }

  const payload = {
    Nombre: nombre,
    Cargo: cargo,
    'Teléfono': tel,
    Correo: correo,
    'Unidad/Región': unidad,
    SexoID: sexoId ? Number(sexoId) : null,
    ParticularNombre: partNom,
    ParticularCargo:  partCar,
    ParticularTel:    partTel,
    RegionID: regionId ? Number(regionId) : null
  };

  // UX: spinner en el botón
  const prevHTML = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Guardando…`;

  try {
    const res = await apiPost('/api/person/create', payload); // ← usa tu helper
    // Actualiza catálogos y deja seleccionada la nueva persona en el modal "Gestionar"
    await loadPersonas(true); // refresca STATE.personas + catalogIndex

    const nuevoId = res?.id ? String(res.id) : '';
    const sel = document.getElementById('selPersona');
    if (sel && nuevoId) {
      sel.value = nuevoId;
      sel.dispatchEvent(new Event('change')); // para autollenar Rol
    }
    // Si usas TomSelect:
    if (window.personaTS && nuevoId) {
      try { personaTS.addOption({ value: nuevoId, text: payload.Nombre }); personaTS.setValue(nuevoId, true); } catch {}
    }

    // Cierra modal y limpia mensaje
    bootstrap.Modal.getInstance(document.getElementById('modalNewPersona'))?.hide();
  } catch (e) {
    msg.textContent = e.message || 'No se pudo crear la persona.'; msg.classList.remove('d-none');
  } finally {
    btn.disabled = false; btn.innerHTML = prevHTML;
  }

  return;
}
// === Abrir modal "Editar persona" (versión actualizada para manejar región) ===
  if (btn.id === 'btnEditPersonaInline' || btn.dataset.action === 'edit-persona') {
    const pid = document.getElementById('selPersona')?.value || btn.dataset.id || '';
    if (!pid) { alert('Selecciona una persona primero'); return; }
    const p = catalogIndex?.[pid];
    if (!p) { alert('Persona no encontrada'); return; }

    // Cargar catálogo de regiones si no está cargado (no bloqueante si falla)
    try { if (typeof loadRegiones === 'function') await loadRegiones(); } catch (e) { console.warn('loadRegiones falló:', e); }

    // Rellenar campos existentes
    $('#epID').value         = p.ID;
    $('#epNombre').value     = p.Nombre || '';
    $('#epCargo').value      = p.Cargo  || '';
    $('#epTelefono').value   = (p['Teléfono'] || p.Telefono || '').replace(/\D/g,'');
    $('#epCorreo').value     = p.Correo || '';
    $('#epUnidad').value     = p['Unidad/Región'] || p.Unidad || p.unidad_region || '';
    $('#epSexo').value       = p.SexoID ?? '';
    $('#epActivo').checked   = (p.Activo === true || p.activo === true);
    $('#epPartNombre').value = p.ParticularNombre || '';
    $('#epPartCargo').value  = p.ParticularCargo  || '';
    $('#epPartTel').value    = (p.ParticularTel || '').replace(/\D/g,'');

    // Región: soporta varias propiedades que puedan venir en catalogIndex
    const regionVal = (p.RegionID ?? p.region_id ?? p.region ?? p.regiones_id ?? '');
    // asigna al select (si existe)
    const epRegionEl = document.getElementById('epRegion');
    if (epRegionEl) {
      epRegionEl.value = regionVal !== null && regionVal !== undefined ? String(regionVal) : '';
      // Si usas TomSelect en el select de edición, actualiza su valor también
      try {
        await loadPersonas(true); // refresca STATE.personas + catalogIndex
        if (window.regionTS_edit && typeof window.regionTS_edit.setValue === 'function') {
          // tomselect espera valor como string/number según config
          window.regionTS_edit.setValue(regionVal ? String(regionVal) : '');
        }
      } catch (e) { console.warn('No se pudo setear regionTS_edit:', e); }
    }

    $('#epMsg').classList.add('d-none');
    new bootstrap.Modal($('#modalEditPersona')).show();
    return;
  }

  // === Guardar cambios persona
  if (btn.id === 'btnGuardarEditPersona') {
    const msg = $('#epMsg');
    msg.classList.add('d-none'); msg.textContent = '';

    const payload = {
      ID:               $('#epID').value,
      Nombre:           $('#epNombre').value.trim(),
      Cargo:            $('#epCargo').value.trim(),
      'Teléfono':       $('#epTelefono').value.trim(),
      Correo:           $('#epCorreo').value.trim(),
      'Unidad/Región':  $('#epUnidad').value.trim(),
      SexoID:           $('#epSexo')?.value || null,
      ParticularNombre: $('#epPartNombre').value.trim(),
      ParticularCargo:  $('#epPartCargo').value.trim(),
      ParticularTel:    $('#epPartTel').value.trim(),
      RegionID:         $('#epRegion')?.value || null,
      Activo:           $('#epActivo')?.checked ?? true
    };

    if (!payload.Nombre || !payload.Cargo) {
      msg.textContent = 'Nombre y Cargo son obligatorios.';
      msg.classList.remove('d-none');
      return;
    }

    try {
      const res = await fetch('/api/person/update', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || res.statusText);

      bootstrap.Modal.getInstance($('#modalEditPersona'))?.hide();
      await loadPersonas(true); // refresca STATE.personas + catalogIndex
      await loadCatalog();
      await reloadUI();
    } catch (e) {
      msg.textContent = e.message || 'No se pudo guardar.';
      msg.classList.remove('d-none');
    }
    return;
  }

// === Abrir modal "Eliminar persona"
  if (btn.id === 'btnDeletePersonaInline' || btn.dataset.action === 'delete-persona') {
    const pid = document.getElementById('selPersona')?.value || btn.dataset.id || '';
    if (!pid) { alert('Selecciona una persona primero'); return; }

    const p = catalogIndex?.[pid];
    if (!p) { alert('Persona no encontrada'); return; }

    $('#delPersonaId').value = p.ID;
    $('#delPersonaName').textContent = p.Nombre || 'esta persona';
    $('#delPersonaMsg').classList.add('d-none');

    new bootstrap.Modal($('#modalDeletePersona')).show();
    // ❌ NO LLAMES reloadUI AQUÍ
    return;
  }

  // === Confirmar eliminación de persona
  if (btn.id === 'btnEliminarPersonaConfirm') {
    const msgEl = $('#delPersonaMsg');
    msgEl.classList.add('d-none');
    msgEl.textContent = '';

    const pid = ($('#delPersonaId').value || '').trim();
    if (!pid) {
      msgEl.textContent = 'Falta ID.';
      msgEl.classList.remove('d-none');
      return;
    }

    try {
      const res = await fetch('/api/person/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify({ ID: pid })
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || res.statusText);

      // Cierra modal
      bootstrap.Modal.getInstance($('#modalDeletePersona'))?.hide();

      // 🔄 Recarga catálogo FORZANDO desde backend
      await loadCatalog(true);
      await loadPersonas(true); // refresca STATE.personas + catalogIndex
      // Limpia select principal
      const sel = document.getElementById('selPersona');
      if (sel) {
        sel.value = '';
        sel.dispatchEvent(new Event('change')); // para que se limpie inpRol con tu lógica existente
      }

      if (document.getElementById('inpRol')) {
        document.getElementById('inpRol').value = '';
      }

      // Si usas TomSelect para personas
      if (window.personaTS) {
        try {
          window.personaTS.clear(true);          // limpia valor
          window.personaTS.refreshOptions(false); // refresca opciones
        } catch (e) {
          console.warn('Error refrescando TomSelect:', e);
        }
      }

      alert('Persona eliminada.');
    } catch (e) {
      console.error(e);
      msgEl.textContent = e.message || 'No se pudo eliminar.';
      msgEl.classList.remove('d-none');
    }
    return;
  }


  // Filtros fechas
  if (btn.id === 'btnFiltrarFechas') {
    currentRange.from = (document.getElementById('fDesde').value || '').trim();
    currentRange.to   = (document.getElementById('fHasta').value || '').trim();
    await reloadUI();
    return;
  }
  if (btn.id === 'btnLimpiarFechas') {
    currentRange.from = "";
    currentRange.to   = "";
    document.getElementById('fDesde').value = "";
    document.getElementById('fHasta').value = "";
    const muniSel = document.getElementById('fMuni');
    if (muniSel) muniSel.value = "";
    await reloadUI();
    return;
  }

 // === Exportar Excel de invitaciones ===
  // === Exportar a Excel (invitaciones confirmadas) ===
  if (btn.id === 'btnExportXlsx') {
    try {
      // Construir parámetros de exportación según filtros activos
      const params = new URLSearchParams();

      // Rango de fechas (si existen inputs)
      const desde = (document.getElementById('fDesde')?.value || '').trim();
      const hasta = (document.getElementById('fHasta')?.value || '').trim();
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);

      // Estatus activo (si usas botones de filtro)
      const estatus = document.querySelector('#statusBtns .btn.active')?.dataset.status || '';
      if (estatus) params.set('estatus', estatus);

      // Construir URL final (usa tu endpoint real)
      const qs = params.toString();
      const url = '/api/report/confirmados.xlsx' + (qs ? ('?' + qs) : '');

      // Estado visual mientras genera el archivo
      btn.disabled = true;
      const prevHTML = btn.innerHTML;
      btn.innerHTML = '<i class="fa fa-spinner fa-spin me-1"></i> Generando...';

      // Realizar la descarga con fetch (mantiene autenticación)
      fetch(url, { credentials: 'same-origin' })
        .then(res => {
          if (!res.ok) throw new Error(`Error ${res.status} al exportar`);
          return res.blob();
        })
        .then(blob => {
          const href = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const hoy = new Date().toISOString().slice(0, 10);
          a.href = href;
          a.download = `invitaciones_${hoy}.xlsx`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(href);
        })
        .catch(err => {
          console.error('❌ Error exportando:', err);
          alert('No se pudo generar el archivo.\n' + (err.message || err));
        })
        .finally(() => {
          btn.disabled = false;
          btn.innerHTML = prevHTML;
        });
    } catch (err) {
      console.error('Error inesperado en exportación:', err);
      alert('❌ Error inesperado al exportar.');
    }
    return;
  }

  // Guardar actor nuevo
if (btn.id === 'btnGuardarActor') {
  const nombre = ($('#naNombre').value || '').trim();
  const cargo  = ($('#naCargo').value || '').trim();
  const tel    = ($('#naTelefono').value || '').trim();
  const sexoId = ($('#naSexo').value || '').trim(); // numérico o vacío

  const partNombre = ($('#naPartNombre').value || '').trim();
  const partCargo  = ($('#naPartCargo').value  || '').trim();
  const partTel    = ($('#naPartTel').value   || '').trim();

  if (!nombre) { alert('El Nombre es obligatorio.'); return; }
  // Tel opcional pero, si viene, valida 10 dígitos
  if (tel && !/^\d{10}$/.test(tel)) { alert('El teléfono debe tener 10 dígitos.'); return; }

  // payload al backend (usamos mismas claves que Personas: con y sin acentos)
  const payload = {
    Nombre: nombre,
    Cargo:  cargo,
    'Teléfono': tel,
    Telefono:   tel,
    SexoID: sexoId ? Number(sexoId) : null,
    ParticularNombre: partNombre,
    ParticularCargo:  partCargo,
    ParticularTel:    partTel,
  };

  try {
    // crea en backend
    const res = await apiPost('/api/actor/create', payload);

    // refresca catálogo de actores
    await loadActores();
    resetNewActorForm();
    // si está abierto el select de creación de invitación, preselecciona el nuevo
    const nuevoId = res?.id ? String(res.id) : '';
    const selCrear = $('#cActor');
    if (selCrear && nuevoId) {
      selCrear.value = nuevoId;
    }

    // ... después de crear en backend:
    await refreshActorSelects({ focusId: nuevoId });  // repuebla y preselecciona al nuevo
    // cierra modal
    bootstrap.Modal.getInstance($('#modalNewActor'))?.hide();

    // actualiza UI (tarjetas/listas) por si se muestran actores en algún lugar
    await reloadUI();
  } catch (err) {
    alert('Error guardando actor: ' + (err.message || ''));
  }
  return;
}
// Abrir modal EDITAR actor
if (btn && btn.id === 'btnOpenEditActor') {
  if (!STATE.actores?.length) await loadActores();
  await loadSexos();          // ← importante: carga opciones de #eaSexo
  buildActorIndex();

  populateActorSelect('#eaActorSel'); // solo actores

  // limpia form
  fillEditActorForm(null);
  document.getElementById('eaActorSel').value = '';

  // change seguro
  const sel = document.getElementById('eaActorSel');
  sel._boundChange && sel.removeEventListener('change', sel._boundChange);
  sel._boundChange = (ev) => {
    const a = actorIndex[String(ev.target.value)];
    fillEditActorForm(a);
    const msg = document.getElementById('eaMsg');
    msg.classList.add('d-none'); msg.textContent = '';
  };
  sel.addEventListener('change', sel._boundChange);

  new bootstrap.Modal(document.getElementById('modalEditActor')).show();
  return;
}

if (btn && btn.id === 'btnActorUpdate') {
  const msg = document.getElementById('eaMsg');
  msg.classList.add('d-none'); msg.textContent = '';

  const id = document.getElementById('eaActorSel').value || '';
  if (!id) { msg.textContent = 'Selecciona un actor.'; msg.classList.remove('d-none'); return; }

  const payload = {
    id: Number(id), // backend espera int
    Nombre: (document.getElementById('eaNombre').value || '').trim(),
    Cargo: (document.getElementById('eaCargo').value || '').trim(),
    "Teléfono": (document.getElementById('eaTelefono').value || '').replace(/\D/g, ''),
    SexoID: (() => {
      const v = document.getElementById('eaSexo').value || '';
      return v ? Number(v) : null;
    })(),
    ParticularNombre: (document.getElementById('eaPartNombre').value || '').trim(),
    ParticularCargo: (document.getElementById('eaPartCargo').value || '').trim(),
    ParticularTel: (document.getElementById('eaPartTel').value || '').replace(/\D/g, '')
  };

  if (!payload.Nombre) { msg.textContent = 'El nombre es obligatorio.'; msg.classList.remove('d-none'); return; }

  try {
    const res = await fetch('/api/actor/update', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || 'No se pudo guardar');
    await refreshActorSelects();
    bootstrap.Modal.getInstance(document.getElementById('modalEditActor'))?.hide();
    await loadActores(); 
    buildActorIndex();
    await reloadUI?.();
  } catch (err) {
    msg.textContent = err.message || 'No se pudo guardar.'; msg.classList.remove('d-none');
  }
  return;
}

// Abrir modal ELIMINAR actor (ya lo tienes similar)
if (btn && btn.id === 'btnOpenDeleteActor') {
  if (!STATE.actores?.length) await loadActores();
  buildActorIndex();
  populateActorSelect('#daActorSel');

  document.getElementById('daActorSel').value = '';
  const m = document.getElementById('daMsg');
  m.classList.add('d-none'); m.textContent = '';

  new bootstrap.Modal(document.getElementById('modalDeleteActor')).show();
  return;
}

// Confirmar eliminación con manejo de 409
if (btn && btn.id === 'btnActorDeleteConfirm') {
  const msg = document.getElementById('daMsg');
  msg.classList.add('d-none'); msg.textContent = '';

  const id = document.getElementById('daActorSel').value || '';
  if (!id) { msg.textContent = 'Selecciona un actor.'; msg.classList.remove('d-none'); return; }

  if (!confirm('¿Eliminar actor de forma definitiva?')) return;

  try {
    const res = await fetch(`/api/actor/delete/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin'
    });

    if (res.status === 409) {
      const j = await res.json().catch(() => ({}));
      // Muestra warning con conteo y, si quieres, ejemplos
      const ejemplos = (j.sample || []).map(s => `• ${s.fecha} — ${s.evento} (ID: ${s.id})`).join('\n');
      msg.innerHTML = `
        <div><b>No se puede eliminar.</b> El actor está asignado a <b>${j.count || '?'}</b> invitacion(es).
        <br>Elimina o reasigna esas invitaciones primero.</div>
        ${ejemplos ? `<pre class="small mt-2 mb-0">${ejemplos}</pre>` : ''}
      `;
      msg.classList.remove('d-none');
      return;
    }

    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.error || 'No se pudo eliminar');
    bootstrap.Modal.getInstance(document.getElementById('modalDeleteActor'))?.hide();
    
    buildActorIndex();
    await reloadUI?.();
    alert('Actor eliminado.');
    await loadActores(); 
    await refreshActorSelects();  // repuebla; si el eliminado estaba seleccionado lo limpia
  } catch (err) {
    msg.textContent = err.message || 'No se pudo eliminar.'; msg.classList.remove('d-none');
  }
  return;
}
// ===== dentro de tu document.addEventListener('click', async (e) => { ... }) =====

if (btn.id === 'btnAsignarGuardar') {
  const modalEl = document.getElementById('modalAssign');
  const msgEl   = document.getElementById('assignMsg'); // alerta en el modal (si la tienes)
  const personaId  = window.personaTS?.getValue() || '';
  const rol        = (document.getElementById('inpRol')?.value || '').trim();
  const comentario = (document.getElementById('inpComentario')?.value || '').trim();
  const actorSel   = (document.getElementById('selActor')?.value || '').trim();

  if (!currentId) { 
    alert('No hay invitación seleccionada.'); 
    return; 
  }

  await withBusy(btn, async () => {
    try {
      // arma payload: prioridad a persona; si no hay, intenta actor
      let payload = null;
      if (personaId) {
        payload = { id: currentId, persona_id: Number(personaId), rol, comentario };
      } else if (actorSel) {
        payload = { id: currentId, actor_id: Number(actorSel), rol, comentario };
      } else {
        throw new Error('Selecciona una persona (o un actor).');
      }

      await apiPost('/api/assign', payload);

      // 1) Recargar datos frescos
      await reloadUI();

      // 2) Calcular fecha de esa invitación recargada para que el calendario
      //    se quede en el día correcto
      const inv = (STATE.invitaciones || []).find(x => x.ID === currentId);
      const fechaHint = inv?.Fecha || null;

      // 3) Refrescar calendario (manteniendo filtros y, si se puede, la fecha)
      refreshCalendarUI({ preserve: true, hintDate: fechaHint });

      // 4) Si tienes algo tipo "mostrar tarjeta actual" la puedes llamar aquí
      if (typeof showInvitationCard === 'function') {
        showInvitationCard(currentId);
      }

      // 5) Cerrar modal al final
      bootstrap.Modal.getInstance(modalEl)?.hide();

      // 6) Ocultar mensaje de error si había
      if (msgEl) {
        msgEl.textContent = '';
        msgEl.classList.add('d-none');
      }

    } catch (err) {
      console.error(err);
      if (msgEl) {
        msgEl.textContent = `Error: ${err.message || 'No se pudo guardar'}`;
        msgEl.classList.remove('d-none');
      } else {
        alert(err.message || 'No se pudo guardar');
      }
    }
  });

  return;
}


// ========== ELIMINAR INVITACIÓN ==========
if (btn.dataset.action === 'delete-inv') {
  const id = btn.dataset.id;
  if (!id) return;

  const conf = confirm('¿Deseas eliminar esta invitación? Esta acción no se puede deshacer.');
  if (!conf) return;

  try {
    await fetch(`/api/invitation/delete/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    await reloadUI();
    refreshCalendarUI({ preserve: true }); // mantiene el día seleccionado
  } catch (err) {
    alert('Error al eliminar invitación: ' + (err.message || ''));
  }
  return;
}


  // ——— Ir a la tarjeta desde el calendario/lista lateral ———
  if (btn.dataset.action === 'goto-inv' || btn.dataset.action === 'goto-card') {
    const id = btn.dataset.id;
    e.preventDefault();
    if (id) goToCard(id);     // <— aquí el cambio clave
    return;
  }

  // Buscar en catálogo
  if (btn.id === 'ppRecargarPersonas') {
    const q = (document.getElementById('ppBuscarNombre')?.value || '').trim();
    btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
    try {
      const personas = await loadPersonasForPanel(q);
      renderPersonaOptions(document.getElementById('ppPersona'), personas);
    } catch (e) {
      console.error(e);
      alert('No se pudo cargar el catálogo.');
    } finally {
      btn.disabled = false; btn.innerHTML = 'Buscar';
    }
    return;
  }

  // Ver eventos por persona
  if (btn.id === 'ppVerEventos') {
    const personaId = (document.getElementById('ppPersona')?.value || '').trim();
    if (!personaId) { alert('Selecciona una persona.'); return; }

    const desde = fmtFechaISO(document.getElementById('ppDesde')?.value || '');
    const hasta = fmtFechaISO(document.getElementById('ppHasta')?.value || '');
    const estatus = (document.getElementById('ppEstatus')?.value || '').trim();

    const params = new URLSearchParams({ persona_id: personaId });
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    if (estatus) params.set('estatus', estatus);

    btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin me-1"></i> Cargando…';
    try {
      const res = await fetch('/api/invitaciones/by_persona?' + params.toString(), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Error al consultar invitaciones');
      const data = await res.json(); // [{...}]
      renderPersonaEventos(data);
    } catch (e) {
      console.error(e);
      alert('No se pudo obtener los eventos de la persona.');
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fa fa-eye me-1"></i> Ver';
    }
    return;
  }
  // Botón "Ver grupo" en la lista del día
  if (btn.classList.contains('btn-ver-grupo')) {
    const token = btn.dataset.grupo || '';
    if (!token) return;

    // 1) Resalta en la lista del día (solo las tarjetas visibles hoy)
    const items = document.querySelectorAll('#calDayList .day-item');
    items.forEach(el => {
      const g = el.dataset.grupo || '';
      if (g === token) el.classList.add('group-focus');
      else el.classList.remove('group-focus');
    });

    // 2) Abre el modal con todas las invitaciones del grupo (cualquier fecha)
    renderGroupModal(token);
    return;
  }
});

async function withBusy(btn, fn) {
  if (!btn || btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  try { await fn(); }
  finally {
    btn.disabled = false;
    btn.dataset.busy = '0';
  }
}

// Cambios en el select de persona (delegado, 1 sola vez)
document.getElementById('selPersona')?.addEventListener('change', (e) => {
  const pid  = e.target.value;
  const info = catalogIndex?.[pid];
  if (document.getElementById('inpRol')) {
    document.getElementById('inpRol').value = info?.Cargo || '';
  }
  updatePersonaInlineButtons();
});

function updatePersonaInlineButtons() {
  const sel    = document.getElementById('selPersona');
  const hasVal = !!(sel && sel.value);
  const btnE   = document.getElementById('btnEditPersonaInline');
  const btnD   = document.getElementById('btnDeletePersonaInline');
  if (btnE) btnE.disabled = !hasVal;
  if (btnD) btnD.disabled = !hasVal;
}
// ===== Helpers UI =====
function resetCreateForm() {
  const ids = ['cFecha','cHora','cEvento','cConvoca','cPartido','cMuni','cLugar','cObs','cConvocaCargo'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  $$('#modalCreate .is-invalid').forEach(e => e.classList.remove('is-invalid'));
}
async function withBusy(btn, fn){
  btn.disabled = true; btn.classList.add('disabled');
  try { await fn(); } finally { btn.disabled = false; btn.classList.remove('disabled'); }
}
function adjustMainPadding() {
  const footer = document.getElementById('footerBar');
  const main = document.querySelector('main');
  if (!footer || !main) return;
  main.style.paddingBottom = (footer.offsetHeight + 24) + 'px';
}
window.addEventListener('load', adjustMainPadding);
window.addEventListener('resize', adjustMainPadding);

// ===== DOM Ready =====
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await Promise.all([ loadCatalog(), loadActores(), loadSexos(), loadPartidos(),loadRegiones() ]);
    await reloadUI();
    refreshCalendarUI({ preserve: true });
    renderCalendarModule();
  } catch (err) {
    console.error(err);
    alert('No se pudo cargar la app: ' + err.message);
  }

  const modalCreate = $('#modalCreate');
  if (modalCreate) {
    modalCreate.addEventListener('show.bs.modal', () => {
      resetCreateForm();
      const f = $('#cFecha');
      if (f) f.valueAsDate = new Date();
    });
    modalCreate.addEventListener('hidden.bs.modal', resetCreateForm);
  }

  // ==== Vincular / Grupo ====
  const chkVinc = document.getElementById('cVincular');
  const rowGrupo = document.getElementById('cGrupoRow');
  const inpGrupo = document.getElementById('cGrupoToken');

  if (chkVinc && rowGrupo && inpGrupo) {
    chkVinc.addEventListener('change', e => {
      if (e.target.checked) {
        rowGrupo.style.display = '';
        // Si hay último grupo usado y el campo está vacío, lo proponemos
        if (LAST_GROUP_TOKEN && !inpGrupo.value.trim()) {
          inpGrupo.value = LAST_GROUP_TOKEN;
        }
      } else {
        rowGrupo.style.display = 'none';
        inpGrupo.value = '';
      }
    });
  }

  // ==== Auto sub-tipo según texto de evento ====
  const selEvento = document.getElementById('cEvento');
  const selSub = document.getElementById('cSubTipo');
  if (selEvento && selSub) {
    selEvento.addEventListener('change', e => {
      const val = (e.target.value || '').toLowerCase();
      if (val.includes('en cabildo y al público'))      selSub.value = 'mixto';
      else if (val.includes('en cabildo'))              selSub.value = 'pre';
      else if (val.includes('al público'))              selSub.value = 'publico';
      else selSub.value = '';
    });
  }
  // ===== Logout (usa endpoint nuevo) =====
  const btnLogout = document.getElementById("btnLogout");
  if (!btnLogout) return;
  btnLogout.addEventListener("click", async () => {
    if (!confirm("¿Deseas cerrar sesión?")) return;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    } catch (err) {
      alert("Error al cerrar sesión: " + (err.message || ""));
    }
  });

});

// ===== Preview archivo crear =====
document.getElementById('cArchivo')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) { document.getElementById('filePreview').textContent = `Seleccionado: ${file.name}`; }
  else { document.getElementById('filePreview').textContent = ''; }
});

// ===== Estado (si no lo tienes ya)
window.STATE = window.STATE || {};
STATE.actores = STATE.actores || [];

// ===== Cargar actores y renderizar combos
async function loadActores(force = false) {
  try {
    if (!force && Array.isArray(STATE.actores) && STATE.actores.length) return STATE.actores;

    const rows = await apiGet('/api/actores'); // espera [{ID, Nombre, Cargo}, ...]
    STATE.actores = Array.isArray(rows) ? rows : [];
    renderActoresCombos();
    return STATE.actores;
  } catch (e) {
    console.error('Error al cargar actores:', e);
    STATE.actores = [];
    renderActoresCombos();
    return [];
  }
}

function renderActoresCombos() {
  const toOpt = (a) => {
    const id  = (a.ID ?? a.id ?? '').toString();
    const nom = (a.Nombre ?? a.nombre ?? 'Sin nombre');
    const car = (a.Cargo ?? a.cargo ?? '');
    return `<option value="${id}">${nom}${car ? ' — ' + car : ''}</option>`;
  };

  const html = ['<option value="">—</option>']
    .concat((STATE.actores || []).map(toOpt))
    .join('');

  const cActor = document.getElementById('cActor');   // modal "Nueva invitación"
  if (cActor) cActor.innerHTML = html;

  const selActor = document.getElementById('selActor'); // si tienes otro combo de actores
  if (selActor) selActor.innerHTML = html;
}


// Si abres con un botón:
document.getElementById('btnAddInvitacion')?.addEventListener('click', async () => {
  await fillPartidos?.();     // si usas esta función para partidos
  await loadActores(true);    // refresca actores
  new bootstrap.Modal(document.getElementById('modalCreate')).show();
});


// (Opcional) Forzar recarga de Actores al abrir el modal de invitación
document.getElementById('modalCreate')?.addEventListener('show.bs.modal', async () => {
  if (typeof loadActores === 'function') await loadActores(true);
  if (typeof fillPartidos === 'function') await fillPartidos();
});


// ===== Utilidades
function fmtFechaISO(iso) {
  if (!iso) return '';
  // YYYY-MM-DD -> DD/MM/YYYY
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function safe(s){ return s ?? ''; }

// ===== Cargar invitaciones con filtros del toolbar
async function loadInvitaciones(params = {}) {
  const u = new URL('/api/invitations', window.location.origin);
  Object.entries(params).forEach(([k,v]) => {
    if (v != null && String(v).trim() !== '') u.searchParams.set(k, v);
  });
  const res = await fetch(u, { credentials:'same-origin' });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const rows = await res.json();
  STATE.invitaciones = Array.isArray(rows) ? rows : [];
  rebuildInvIndex();
  await reloadUI();
  refreshCalendarUI({ preserve: true }); // respeta la fecha seleccionada
}

// ===== KPIs por estatus
function renderKPIs() {
  const arr = STATE.invitaciones || [];
  const count = (st) => arr.filter(x => (x.Estatus || '') === st).length;
  const pend = count('Pendiente');
  const conf = count('Confirmado');
  const subs = count('Sustituido');
  const canc = count('Cancelado');

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('kpiPend', pend);
  set('kpiConf', conf);
  set('kpiSubs', subs);
  set('kpiCanc', canc);
}
// Normaliza texto (sin tildes)
const norm = s => (s||'').toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu,'').trim();

// Clasifica por el texto que guardas en inv.convoca_cargo -> "ConvocaCargo" en el JSON
function categoriaConvocante(x){
  const c = norm(x.ConvocaCargo || '');
  if (!c) return 'otros';
  if (c.includes('diput'))     return 'dip';   // "Diputadas y Diputados"
  if (c.includes('president')) return 'pres';  // "Presidentas y Presidentes Municipales"
  return 'otros';
}

// Ordena por Fecha y luego Hora (vacíos al final)
function porFechaHoraAsc(a, b) {
  const fa = a.Fecha || '';
  const fb = b.Fecha || '';
  if (fa && fb && fa !== fb) return fa < fb ? -1 : 1;
  if (!fa && fb) return 1;
  if (fa && !fb) return -1;

  const ha = (a.Hora || '24:00');
  const hb = (b.Hora || '24:00');
  if (ha === hb) return 0;
  return ha < hb ? -1 : 1;
}

function badgeByStatus(st) {
  st = (st || '').toLowerCase();
  if (st.includes('pend')) return 'text-bg-warning';
  if (st.includes('confirm')) return 'text-bg-success';
  if (st.includes('sustit')) return 'text-bg-info';
  if (st.includes('cancel')) return 'text-bg-danger';
  return 'text-bg-secondary';
}

document.addEventListener('DOMContentLoaded', async () => {
  // lee filtros iniciales si tienes inputs:
  const params = {};
  const d = document.getElementById('fDesde')?.value;
  const h = document.getElementById('fHasta')?.value;
  const m = document.getElementById('fMuni')?.value;
  if (d) params.desde = d;
  if (h) params.hasta = h;
  if (m) params.municipio = m;

  await loadInvitaciones(params);
});

// filtros por estatus (botonera)
document.getElementById('statusBtns')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  [...e.currentTarget.querySelectorAll('button')].forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const est = btn.getAttribute('data-status') || '';
  const params = { estatus: est };
  // conserva fechas si están puestas
  const d = document.getElementById('fDesde')?.value;
  const h = document.getElementById('fHasta')?.value;
  const m = document.getElementById('fMuni')?.value;
  if (d) params.desde = d;
  if (h) params.hasta = h;
  if (m) params.municipio = m;

  await loadInvitaciones(params);
});

// aplicar/limpiar fechas
document.getElementById('btnFiltrarFechas')?.addEventListener('click', async () => {
  const params = {};
  const d = document.getElementById('fDesde')?.value;
  const h = document.getElementById('fHasta')?.value;
  const m = document.getElementById('fMuni')?.value;
  const est = document.querySelector('#statusBtns .active')?.getAttribute('data-status') || '';
  if (d) params.desde = d;
  if (h) params.hasta = h;
  if (m) params.municipio = m;
  if (est) params.estatus = est;
  await loadInvitaciones(params);
});
document.getElementById('btnLimpiarFechas')?.addEventListener('click', async () => {
  document.getElementById('fDesde').value = '';
  document.getElementById('fHasta').value = '';
  document.getElementById('fMuni').value = '';
  const est = document.querySelector('#statusBtns .active')?.getAttribute('data-status') || '';
  await loadInvitaciones(est ? {estatus: est} : {});
});

// Limpia el modal "Nueva persona" cada vez que se abre
const modalNewPersonaEl = document.getElementById('modalNewPersona');
if (modalNewPersonaEl) {
  modalNewPersonaEl.addEventListener('show.bs.modal', () => {
    const ids = [
      'npNombre','npCargo','npTelefono','npCorreo','npUnidad',
      'npPartNombre','npPartCargo','npPartTel'
    ];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // Sexo (opcional)
    const selSexo = document.getElementById('npSexo');
    if (selSexo) selSexo.value = '';

    const selRegion = document.getElementById('npRegion');
    if (selRegion) selRegion.value = '';

    // Limpia mensaje
    const msg = document.getElementById('npMsg');
    if (msg) msg.classList.add('d-none');
  });
}

// ===== Estado calendario =====
let CAL = {
  y: new Date().getFullYear(),
  m: new Date().getMonth(),     // 0-11
  selected: null                 // 'YYYY-MM-DD'
};

// ===== Util: contar eventos por día (puedes filtrar cancelados aquí) =====
function countsByDate(invs){
  const map = new Map();
  for (const x of invs || []){
    if (!x.Fecha) continue;
    // Ejemplo de filtro: si NO quieres contar cancelados, descomenta:
    // if ((x.Estatus || '').toLowerCase().includes('cancel')) continue;

    const d = x.Fecha; // YYYY-MM-DD
    map.set(d, (map.get(d) || 0) + 1);
  }
  return map;
}

// ===== Util fechas =====
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio',
                   'Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function pad(n){ return n < 10 ? '0'+n : ''+n; }
function ymd(y,m,d){ return `${y}-${pad(m+1)}-${pad(d)}`; }

/* ===== Helpers de conteo por estatus ===== */
function countsByDateStatus(invs){
  // Map('YYYY-MM-DD' -> { pend: n, conf: n, canc: n, otros: n, total: n })
  const map = new Map();
  for (const x of invs || []){
    if (!x.Fecha) continue;
    const d = x.Fecha;
    const st = (x.Estatus || '').toLowerCase();
    const obj = map.get(d) || { pend:0, conf:0, canc:0, otros:0, total:0 };
    if      (st.includes('pend')) obj.pend++;
    else if (st.includes('confirm')) obj.conf++;
    else if (st.includes('cancel'))  obj.canc++;
    else obj.otros++;
    obj.total++;
    map.set(d, obj);
  }
  return map;
}
function dotGroupByStatus(obj){
  if (!obj || !obj.total) return '';
  const parts = [];
  if (obj.pend)  parts.push('<span class="cal-dot pend" title="Pendiente"></span>');
  if (obj.conf)  parts.push('<span class="cal-dot conf" title="Confirmado"></span>');
  if (obj.canc)  parts.push('<span class="cal-dot canc" title="Cancelado"></span>');
  if (obj.otros) parts.push('<span class="cal-dot otros" title="Otros"></span>');
  return `<span class="cal-dots">${parts.join('')}</span>`;
}
function isTodayYMD(y,m,d){
  const t = new Date();
  return (t.getFullYear() === y && t.getMonth() === m && t.getDate() === d);
}

/* ===== Render calendario estilizado ===== */
function renderCalendar(){
  const cont = document.getElementById('calTable');
  const title = document.getElementById('calTitle');
  if (!cont || !title) return;

  const y = CAL.y, m = CAL.m;
  title.textContent = `${MONTHS_ES[m]} ${y}`;

  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // 0=Lun
  const daysInMonth = new Date(y, m+1, 0).getDate();

  const daysPrev = startDow;
  const totalCells = daysPrev + daysInMonth;
  const rows = Math.ceil(totalCells / 7);

  const counts = countsByDateStatus(STATE.invitaciones || []);

  const head = `
    <thead>
      <tr class="text-center text-muted">
        <th class="fw-normal">Lun</th><th class="fw-normal">Mar</th><th class="fw-normal">Mié</th>
        <th class="fw-normal">Jue</th><th class="fw-normal">Vie</th><th class="fw-normal">Sáb</th><th class="fw-normal">Dom</th>
      </tr>
    </thead>
  `;

  let htmlRows = '<tbody>';
  let day = 1;
  for (let r=0; r<rows; r++){
    htmlRows += '<tr>';
    for (let c=0; c<7; c++){
      const cellIndex = r*7 + c;
      if (cellIndex < daysPrev || day > daysInMonth){
        htmlRows += `<td class="cal-day disabled"></td>`;
      } else {
        const dstr = ymd(y, m, day);
        const obj  = counts.get(dstr);
        const isSel = (CAL.selected === dstr);
        const clsSel = isSel ? ' selected' : '';
        const clsToday = isTodayYMD(y,m,day) ? ' today' : '';

        htmlRows += `
          <td class="cal-day${clsSel}${clsToday}" data-date="${dstr}">
            <div class="d-flex justify-content-between align-items-start">
              <div class="cal-day-number">${day}</div>
              <div>${dotGroupByStatus(obj)}</div>
            </div>
            ${obj?.total ? `<div class="cal-mini">${obj.total} ev</div>` : `<div class="cal-mini">&nbsp;</div>`}
          </td>
        `;
        day++;
      }
    }
    htmlRows += '</tr>';
  }
  htmlRows += '</tbody>';

  cont.innerHTML = head + htmlRows;

  // Click en días
  cont.querySelectorAll('.cal-day[data-date]').forEach(td => {
    if (td.classList.contains('disabled')) return;
    td.addEventListener('click', () => {
      const d = td.getAttribute('data-date');
      CAL.selected = d;
      renderDayList(d);
      renderCalendar();
      highlightCalendarDay(d);   // ← agrega esta línea
    });
  });
}

/* ===== Lista de eventos del día (cards compactas) ===== */
/* ===== Lista de eventos del día (cards compactas) ===== */
function renderDayList(dateYMD){
  const box = document.getElementById('calDayList');
  const lab = document.getElementById('calSelected');
  if (!box || !lab) return;

  lab.textContent = dateYMD ? dateYMD.split('-').reverse().join('/') : '—';

  const items = (STATE.invitaciones || []).filter(x => x.Fecha === dateYMD);
  if (!items.length){
    box.innerHTML = '<div class="text-muted small px-3 py-2">Sin eventos para este día.</div>';
    return;
  }

  // Orden por hora
  items.sort((a,b) => (a.Hora||'') < (b.Hora||'') ? -1 : 1);

  // Mapa grupo_token → clase de color
  const groupClassCache = {};

  const badgeEstatus = (st) => {
    st = (st||'').toLowerCase();
    if (st.includes('confirm')) return '<span class="badge text-bg-success">Confirmado</span>';
    if (st.includes('cancel'))  return '<span class="badge text-bg-danger">Cancelado</span>';
    if (st.includes('sustit'))  return '<span class="badge text-bg-info">Sustituido</span>';
    return '<span class="badge text-bg-warning text-dark">Pendiente</span>';
  };

  const badgeSubTipo = (sub) => {
    sub = (sub||'').toLowerCase();
    if (sub === 'pre')     return '<span class="badge rounded-pill bg-primary-subtle text-primary-emphasis ms-1">Pre</span>';
    if (sub === 'publico') return '<span class="badge rounded-pill bg-warning-subtle text-warning-emphasis ms-1">Público</span>';
    if (sub === 'mixto')   return '<span class="badge rounded-pill bg-success-subtle text-success-emphasis ms-1">Mixto</span>';
    return '';
  };

  box.innerHTML = items.map(x => {
    const hora      = x.Hora ? ` · ${x.Hora}` : '';
    const asignado  = x.PersonaNombre ? 
      ` — <span class="text-muted">${x.PersonaNombre}${x.Rol? ' ('+x.Rol+')':''}</span>` : '';
    const partidoRaw = (x.Partido || x.PartidoPolitico || x.Partido_Politico);
    const partido   = partidoRaw ? partidoRaw : '';
    const subTipo   = x.SubTipo || x.sub_tipo || '';
    const grupoTok  = x.GrupoToken || x.grupo_token || '';
    const grpClass  = getGroupClass(grupoTok, groupClassCache);

    // Si tiene grupo → badge + botón
    const grupoBadge = grupoTok
      ? `<span class="badge bg-dark-subtle text-dark-emphasis me-1">Grupo</span>`
      : '';

    const btnGrupo = grupoTok
      ? `<button class="btn btn-sm btn-outline-secondary ms-1 btn-ver-grupo" data-grupo="${grupoTok}">
           Ver grupo
         </button>`
      : '';

    return `
      <div class="day-item d-flex align-items-start justify-content-between ${grpClass}" 
           data-id="${x.ID}" 
           data-grupo="${grupoTok}">
        <div class="me-2">
          <div class="title">
            ${(x.Evento || 'Sin título')} 
            ${partido ? partidoPillHtml(partido) : ''}
            ${badgeSubTipo(subTipo)}
          </div>
          <div class="meta">
            <i class="bi bi-geo-alt me-1"></i>${x.Municipio || ''} · ${x.Lugar || ''}${hora}
          </div>
          <div class="meta">
            <i class="bi bi-megaphone me-1"></i><b>Convoca:</b> ${x.ActorNombre || x.Convoca || '—'}
          </div>
          <div class="meta">
            <i class="bi bi-person-check me-1"></i><b>Asignado:</b> ${asignado || ' — '}
          </div>
          <div class="tags mt-1">
            ${badgeEstatus(x.Estatus || '')}
            ${grupoBadge}
            ${btnGrupo}
          </div>
        </div>
        <div class="ms-2">
          <button class="btn btn-outline-primary btn-goto" data-action="goto-inv" data-id="${x.ID}">
            Ver tarjeta
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  // asegura que tenga scroll
  box.classList.add('day-list');

  // cada vez que se renderiza, vuelve al inicio
  box.scrollTop = 0;
}


// Colores por grupo
const GROUP_CLASSES = ['grp-a', 'grp-b', 'grp-c', 'grp-d', 'grp-e', 'grp-f'];

function getGroupClass(token, cache) {
  if (!token) return '';
  cache = cache || {};
  if (cache[token]) return cache[token];

  const used = Object.keys(cache).length;
  const idx = used % GROUP_CLASSES.length;

  const cls = GROUP_CLASSES[idx];
  cache[token] = cls;
  return cls;
}


// ===== Navegación de mes =====
document.getElementById('calPrev')?.addEventListener('click', () => {
  if (--CAL.m < 0){ CAL.m = 11; CAL.y--; }
  CAL.selected = null;
  renderCalendar(); renderDayList(null);
});
document.getElementById('calNext')?.addEventListener('click', () => {
  if (++CAL.m > 11){ CAL.m = 0; CAL.y++; }
  CAL.selected = null;
  renderCalendar(); renderDayList(null);
});


// ===== Hook: actualiza calendario al recargar invitaciones =====
// Llama esto al final de tu reloadUI()
function renderCalendarModule(){
  // Selecciona por defecto el día de hoy si hay eventos; si no, sin selección
  const today = new Date();
  const tstr = ymd(today.getFullYear(), today.getMonth(), today.getDate());
  CAL.selected = null;

  renderCalendar();
  // si hoy tiene eventos, mostrar lista de hoy
  const hasToday = (STATE.invitaciones || []).some(x => x.Fecha === tstr);
  renderDayList(hasToday ? tstr : null);
  if (hasToday) highlightCalendarDay(tstr); // ← marca visualmente hoy
}


// --- Helpers de categoría (ajusta si usas otra lógica) ---
function normalize(str){
  return String(str||'').toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'').trim();
}

function getCategoryForInv(inv){
  const c = normalize(inv.ConvocaCargo || inv.Convoca || inv.ActorNombre || '');
  if (!c) return 'otros';
  if (c.includes('diput'))     return 'dip';
  if (c.includes('president')) return 'pres';
  return 'otros';
}

// Mapa de pestañas (usa tus IDs reales de botones-tab)
const TAB_BTN_BY_CAT = {
  dip:   '#tab-dip-tab',
  pres:  '#tab-pres-tab',
  otros: '#tab-otros-tab'
};

// Activa la pestaña con Bootstrap
function activateTabByCategory(cat){
  const sel = TAB_BTN_BY_CAT[cat] || TAB_BTN_BY_CAT.otros;
  const btn = document.querySelector(sel);
  if (!btn) return;
  // Preferible usar la API de Tab
  if (window.bootstrap?.Tab) {
    const tab = bootstrap.Tab.getOrCreateInstance(btn);
    tab.show();
  } else {
    // fallback: click
    btn.click();
  }
}

// Ya tienes este; solo confirmo que apunta a id="card-<ID>"
function scrollToCard(invId) {
  const el = document.getElementById(`card-${invId}`);
  if (!el) {
    console.warn('No se encontró la tarjeta', invId);
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('card-glow');
  setTimeout(() => el.classList.remove('card-glow'), 1500);
}

// Busca la invitación por ID (usa tu invIndex si ya lo tienes)
function findInvitationById(id){
  // Si ya mantienes invIndex: return invIndex[id];
  return (STATE.invitaciones || []).find(x => String(x.ID) === String(id));
}

// Orquestador: activa tab correcta y luego hace scroll
function goToCard(invId){
  const inv = findInvitationById(invId);
  if (!inv) { console.warn('Invitación no encontrada', invId); return; }

  const cat = getCategoryForInv(inv);
  activateTabByCategory(cat);
  
  // esperar a que el tab pinte sus tarjetas
  requestAnimationFrame(() => {
    setTimeout(() => scrollToCard(invId), 60);
    outlineCard(invId); // <- contorno nuevo
  });
}

// Resalta (con contorno) una celda de calendario por fecha 'YYYY-MM-DD'
function highlightCalendarDay(dateYMD){
  // Quita marcados anteriores
  document.querySelectorAll('#calTable td.cal-day.selected')
    .forEach(td => td.classList.remove('selected'));
  // Marca el nuevo si existe
  const td = document.querySelector(`#calTable td.cal-day[data-date="${dateYMD}"]`);
  if (td) td.classList.add('selected');
}

// Aplica contorno animado a la card inv-<ID>
function outlineCard(invId){
  const el = document.getElementById(`inv-${invId}`) || document.getElementById(`card-${invId}`);
  if (!el) return;
  el.classList.add('card-outline');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // quitar la clase después del efecto
  setTimeout(() => el.classList.remove('card-outline'), 1600);
}


// Cuando el usuario selecciona un NUEVO archivo en el modal Editar
document.getElementById('eArchivo')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  const prev = document.getElementById('eFilePreview');
  const link = document.getElementById('eFileLink');
  const btnR = document.getElementById('eBtnFileRemove');

  if (file) {
    // Nuevo archivo reemplaza al actual: ocultamos link y quitar
    if (prev) prev.textContent = `Nuevo archivo: ${file.name} (${Math.round(file.size/1024)} KB)`;
    link?.classList.add('d-none');
    btnR?.classList.add('d-none');
    // cancelar cualquier eliminación previa
    window._removeFile = false;
    btnR?.removeAttribute('data-remove');
  } else {
    // Sin archivo nuevo, no tocar (el estado actual lo decide "Abrir" o "Quitar")
    // Si quieres, puedes limpiar:
    // prev.textContent = '';
  }
});

document.getElementById('modalEdit')?.addEventListener('hidden.bs.modal', () => {
  _removeFile = false;
  const inp = document.getElementById('eArchivo');
  if (inp) inp.value = '';
  const prev = document.getElementById('eFilePreview');
  if (prev) prev.textContent = '';
  document.getElementById('eFileLink')?.classList.add('d-none');
  document.getElementById('eBtnFileRemove')?.classList.add('d-none');
});

function showDetails(inv){
  // Crea modal si no existe
  let modalEl = document.getElementById('modalDetails');
  if (!modalEl) {
    const tpl = document.createElement('div');
    tpl.innerHTML = `
    <div class="modal fade" id="modalDetails" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content shadow-lg border-0 rounded-3">
          <div class="modal-header bg-primary text-white">
            <h5 class="modal-title fw-semibold">Detalles de la invitación</h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body bg-light">
            <div id="detailsBody"></div>
          </div>
          <div class="modal-footer border-0 bg-light">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button>
          </div>
        </div>
      </div>
    </div>`;
    document.body.appendChild(tpl.firstElementChild);
    modalEl = document.getElementById('modalDetails');
  }

  // Utils
  const safe = (v) => v ?? '';
  const fmtFecha = (iso) => iso ? iso.split('-').reverse().join('/') : '';
  const getFecha = (x) => x.Fecha || '';
  const getHora  = (x) => x.Hora || '';
  const badgeByStatus = (st) => {
    st = (st||'').toLowerCase();
    if (st.includes('pend')) return 'text-bg-warning';
    if (st.includes('confirm')) return 'text-bg-success';
    if (st.includes('sustit')) return 'text-bg-info';
    if (st.includes('cancel')) return 'text-bg-danger';
    return 'text-bg-secondary';
  };

  // ===== Archivo: SIEMPRE usa tu endpoint por ID (sirve local o redirige) =====
  // Mostramos bloque si hay metadata (nombre/url guardados)
  const hasFile  = !!(inv.ArchivoNombre || inv.ArchivoURL);
  const fileUrl  = `/api/invitation/${encodeURIComponent(inv.ID)}/archivo`;
  const fileName = inv.ArchivoNombre || 'Archivo adjunto';
  const mime     = (inv.ArchivoMime || '').toLowerCase();
  const ext      = (inv.ArchivoNombre || '').split('.').pop().toLowerCase();

  const isPDF   = mime === 'application/pdf' || ext === 'pdf';
  const isImage = mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp'].includes(ext);

  const fileBlock = hasFile ? `
    <div class="card border-0 shadow-sm mt-3">
      <div class="card-body">
        <h6 class="fw-semibold"><i class="bi bi-paperclip me-1"></i>Archivo adjunto</h6>
        <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
          <div><a href="${fileUrl}" target="_blank" rel="noopener">${safe(fileName)}</a></div>
          <a class="btn btn-sm btn-outline-secondary" href="${fileUrl}" target="_blank" rel="noopener" title="Abrir archivo">
            <i class="bi bi-box-arrow-up-right"></i> Abrir
          </a>
        </div>
        ${isImage ? `
          <div class="mt-3">
            <img src="${fileUrl}" alt="${safe(fileName)}" class="img-fluid rounded border">
          </div>` : ''
        }
        ${isPDF ? `
          <div class="mt-3">
            <embed src="${fileUrl}" type="application/pdf" width="100%" height="420px" class="rounded border"/>
          </div>` : ''
        }
      </div>
    </div>` : '';

  // ===== Cuerpo del modal =====
  const html = `
  <div class="card border-0 shadow-sm mb-3">
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h5 class="mb-0 fw-semibold">${safe(inv.Evento)}</h5>
        <span class="badge ${badgeByStatus(inv.Estatus)}">${safe(inv.Estatus) || 'Pendiente'}</span>
      </div>
      <div class="text-muted mb-2">
        <i class="bi bi-calendar3"></i> ${fmtFecha(getFecha(inv))} ${getHora(inv) ? '· '+getHora(inv) : ''}
      </div>
      <div><b>Convoca:</b> ${safe(inv.Convoca || inv.ActorNombre) || '—'}</div>
      <div><b>Cargo:</b> ${safe(inv.ConvocaCargo) || '—'}</div>
      <div><b>Partido Político:</b> ${safe(inv.Partido || inv.PartidoPolitico) || '—'}</div>
      <div><b>Municipio:</b> ${safe(inv.Municipio) || '—'}</div>
      <div><b>Lugar:</b> ${safe(inv.Lugar) || '—'}</div>
      <div><b>Asignado a:</b> ${safe(inv.PersonaNombre) || 'Sin asignar'}${inv.Rol ? ` (${inv.Rol})` : ''}</div>
      ${inv.Observaciones ? `<div class="mt-2"><b>Observaciones:</b> ${safe(inv.Observaciones)}</div>` : ''}
    </div>
  </div>

  ${fileBlock}

  <div class="mt-3 small text-muted">
    ${inv["Fecha Asignación"] ? `<div><b>Fecha de Asignación:</b> ${inv["Fecha Asignación"]}</div>` : ''}
    ${inv["Última Modificación"] ? `<div><b>Última Modificación:</b> ${inv["Última Modificación"]}</div>` : ''}
    ${inv["Modificado Por"] ? `<div><b>Modificado Por:</b> ${inv["Modificado Por"]}</div>` : ''}
  </div>`;

  modalEl.querySelector('#detailsBody').innerHTML = html;
  new bootstrap.Modal(modalEl).show();
}



function rebuildInvIndex() {
  window.invIndex = {};
  for (const r of (STATE.invitaciones || [])) {
    const rid = String(r?.ID ?? r?.id ?? r?.Id ?? r?.IdInvitacion ?? r?.uuid ?? r?.Uuid ?? '').trim();
    if (rid) invIndex[rid] = r;
  }
}
// === util: llevar el calendario a una fecha dada (YYYY-MM-DD) ===
function setCalToDate(ymdStr){
  if (!ymdStr) return;
  const [Y,M,D] = ymdStr.split('-').map(Number);
  CAL.y = Y;
  CAL.m = M - 1;   // 0-11
  CAL.selected = ymdStr;
}

// === util: refrescar calendario y lista del día ===
function refreshCalendarUI({ preserve = true, hintDate = null } = {}) {
  if (hintDate) setCalToDate(hintDate);
  else if (!preserve) CAL.selected = null;

  renderCalendar();
  renderDayList(CAL.selected || null);
}

function populateActorSelect(selectEl) {
  if (!selectEl) return;
  const sel = (typeof selectEl === 'string') ? document.querySelector(selectEl) : selectEl;
  if (!sel) return;
  const opts = ['<option value="">—</option>'].concat(
    (STATE.actores || []).map(a => `<option value="${a.ID}">${a.Nombre}${a.Cargo ? ' — '+a.Cargo : ''}</option>`)
  );
  sel.innerHTML = opts.join('');
}

function populateSexoSelect(selectEl) {
  // Asumiendo que ya cargas STATE.sexos con loadSexos()
  const sel = (typeof selectEl === 'string') ? document.querySelector(selectEl) : selectEl;
  if (!sel) return;
  const opts = ['<option value="">—</option>'].concat(
    (STATE.sexos || []).map(s => `<option value="${s.ID}">${s.Nombre}</option>`)
  );
  sel.innerHTML = opts.join('');
}

function cleanDigits(s){ return (s || '').replace(/\D/g, ''); }

function buildActorIndex() {
  window.actorIndex = {};
  (STATE.actores || []).forEach(a => {
    actorIndex[String(a.ID)] = a;  // clave string
  });
}
function fillEditActorForm(a) {
  const byId = id => document.getElementById(id);

  byId('eaNombre').value      = a?.Nombre || '';
  byId('eaCargo').value       = a?.Cargo || '';
  byId('eaTelefono').value    = (a?.['Teléfono'] || a?.Telefono || '').replace(/\D/g, '');
  byId('eaPartNombre').value  = a?.ParticularNombre || '';
  byId('eaPartCargo').value   = a?.ParticularCargo || '';
  byId('eaPartTel').value     = (a?.ParticularTel || '').replace(/\D/g, '');

  const sexoSel = byId('eaSexo');
  if (sexoSel) {
    const val = (a?.SexoID === 0 || a?.SexoID) ? String(a.SexoID) : '';
    sexoSel.value = val;
    // Si no existe esa opción (p.ej. catálogo cambió), deja vacío
    if (!Array.from(sexoSel.options).some(o => o.value === val)) {
      sexoSel.value = '';
    }
  }
}

// ===== Utils para selects =====
function _getVal(sel) { return sel ? String(sel.value || '') : ''; }
function _setValIfExists(sel, val) {
  if (!sel) return;
  if (val && Array.from(sel.options).some(o => String(o.value) === String(val))) {
    sel.value = String(val);
  } else {
    sel.value = ''; // si ya no existe (p.ej. se eliminó), lo limpia
  }
}

function populateActorSelectGeneric(sel, actores) {
  if (!sel) return;
  const html = ['<option value="">—</option>'].concat(
    (actores || []).map(a =>
      `<option value="${a.ID}">${a.Nombre}${a.Cargo ? ' — ' + a.Cargo : ''}</option>`
    )
  ).join('');
  sel.innerHTML = html;
}

// ===== Refrescar todos los selects que muestran actores =====
// opts: { keep: {cActor, eaActorSel, daActorSel}, focusId }
async function refreshActorSelects(opts = {}) {
  // 1) Guardar selección actual (si existen los selects)
  const cActorSel  = document.getElementById('cActor');       // crear invitación
  const eaActorSel = document.getElementById('eaActorSel');   // editar actor
  const daActorSel = document.getElementById('daActorSel');   // eliminar actor

  const prev = {
    cActor:   _getVal(cActorSel),
    eaActor:  _getVal(eaActorSel),
    daActor:  _getVal(daActorSel),
  };

  // 2) Recargar catálogo desde backend y reconstruir índice
  await loadActores();   // -> actualiza STATE.actores y actorIndex
  buildActorIndex();

  // 3) Repoblar selects
  populateActorSelectGeneric(cActorSel,  STATE.actores);
  populateActorSelectGeneric(eaActorSel, STATE.actores);
  populateActorSelectGeneric(daActorSel, STATE.actores);

  // 4) Restaurar selección:
  // - Si viene opts.focusId, ese manda (útil al CREAR para preseleccionar el nuevo)
  // - Si no, intenta conservar lo que estaba seleccionado (prev.*)
  const focusId = opts.focusId ? String(opts.focusId) : null;

  if (focusId) {
    _setValIfExists(cActorSel,  focusId);
    _setValIfExists(eaActorSel, focusId);
    _setValIfExists(daActorSel, focusId);
  } else {
    _setValIfExists(cActorSel,  prev.cActor);
    _setValIfExists(eaActorSel, prev.eaActor);
    _setValIfExists(daActorSel, prev.daActor);
  }

  // (Opcional) Si el modal de EDITAR está abierto y cambió el actor seleccionado,
  // vuelve a rellenar el formulario:
  const currentEditId = _getVal(eaActorSel);
  if (currentEditId) {
    const a = actorIndex[currentEditId];
    if (typeof fillEditActorForm === 'function') fillEditActorForm(a);
  }
}

function buildExportURL() {
  const params = new URLSearchParams();

  // Si tienes datepickers:
  const d1 = (document.getElementById('fDesde')?.value || '').trim();
  const d2 = (document.getElementById('fHasta')?.value || '').trim();
  if (d1) params.set('desde', d1);
  if (d2) params.set('hasta', d2);

  // Si usas botones de estatus activos:
  const estatus = document.querySelector('#statusBtns .btn.active')?.dataset.status || '';
  if (estatus) params.set('estatus', estatus);

  const qs = params.toString();
  return '/api/export/invitaciones.xlsx' + (qs ? ('?' + qs) : '');
}

// Descarga con fetch para respetar sesión (cookies) y asignar nombre de archivo
async function exportInvitaciones() {
  const url = buildExportURL();
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const txt = await res.text().catch(()=>'');
      throw new Error(`Error exportando (${res.status}): ${txt || res.statusText}`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    const href = URL.createObjectURL(blob);
    a.href = href;
    const today = new Date().toISOString().slice(0,10);
    a.download = `invitaciones_${today}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  } catch (err) {
    alert('No se pudo exportar: ' + (err.message || err));
  }
}
function resetNewActorForm() {
  // Si tus inputs están dentro de un <form id="formNewActor">, esto basta:
  const form = document.getElementById('formNewActor');
  if (form) form.reset();

  // Por si no usas <form> o quieres asegurarlo campo por campo:
  const ids = [
    'naNombre', 'naCargo', 'naTelefono', 'naSexo',
    'naPartNombre', 'naPartCargo', 'naPartTel'
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Si usas algún aviso en el modal:
  const msg = document.getElementById('naMsg');
  if (msg) { msg.classList.add('d-none'); msg.textContent = ''; }
}
const MUNICIPIOS = 
[
        "Acambay de Ruíz Castañeda", "Acolman", "Aculco", "Almoloya de Alquisiras",
        "Almoloya de Juárez", "Almoloya del Río", "Amanalco", "Amatepec",
        "Amecameca", "Apaxco", "Atenco", "Atizapán", "Atizapán de Zaragoza",
        "Atlacomulco", "Atlautla", "Axapusco", "Ayapango", "Calimaya",
        "Capulhuac", "Coacalco de Berriozábal", "Coatepec Harinas", "Cocotitlán",
        "Coyotepec", "Cuautitlán", "Chalco", "Chapa de Mota", "Chapultepec",
        "Chiautla", "Chicoloapan", "Chiconcuac", "Chimalhuacán", "Cuautitlán Izcalli", "Donato Guerra",
        "Ecatepec de Morelos", "Ecatzingo", "Huehuetoca", "Hueypoxtla", "Huixquilucan",
        "Isidro Fabela", "Ixtapaluca", "Ixtapan de la Sal", "Ixtapan del Oro",
        "Ixtlahuaca", "Xalatlaco", "Jaltenco", "Jilotepec", "Jilotzingo", "Jiquipilco",
        "Jocotitlán", "Joquicingo", "Juchitepec", "Lerma", "Luvianos", "Malinalco", "Melchor Ocampo",
        "Metepec", "Mexicaltzingo", "Morelos", "Naucalpan de Juárez", "Nezahualcóyotl",
        "Nextlalpan", "Nicolás Romero", "Nopaltepec", "Ocoyoacac", "Ocuilan",
        "El Oro", "Otumba", "Otzoloapan", "Otzolotepec", "Ozumba", "Papalotla",
        "La Paz", "Polotitlán", "Rayón", "San Antonio la Isla", "San José del Rincón", "San Felipe del Progreso",
        "San Martín de las Pirámides", "San Mateo Atenco", "San Simón de Guerrero",
        "Santo Tomás", "Soyaniquilpan de Juárez", "Sultepec", "Tecámac", "Tejupilco",
        "Temamatla", "Temascalapa", "Temascalcingo", "Temascaltepec", "Temoaya",
        "Tenancingo", "Tenango del Aire", "Tenango del Valle", "Teoloyucan", "Teotihuacán",
        "Tepetlaoxtoc", "Tepetlixpa", "Tepotzotlán", "Tequixquiac", "Texcaltitlán",
        "Texcalyacac", "Texcoco", "Tezoyuca", "Tianguistenco", "Timilpan", "Tonanitla", "Tlalmanalco",
        "Tlalnepantla de Baz", "Tlatlaya", "Toluca", "Tonatico", "Tultepec", "Tultitlán",
        "Valle de Bravo", "Valle de Chalco Solidaridad", "Villa de Allende", "Villa del Carbón", "Villa Guerrero",
        "Villa Victoria", "Xonacatlán", "Zacazonapan", "Zacualpan", "Zinacantepec",
        "Zumpahuacán", "Zumpango"
];

      // Poblado automático
      const selMuni = document.getElementById('cMuni');
      MUNICIPIOS.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        selMuni.appendChild(opt);
      });
      const selMunii = document.getElementById('eMuni');
      MUNICIPIOS.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        selMunii.appendChild(opt);
      });

// Helpers: cargar catálogo para el selector
async function loadPersonasForPanel(q = '') {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', '300');     // ajusta si quieres
  params.set('activos', 'true');  // si manejas "activo" en personas

  const res = await fetch('/api/catalog?' + params.toString(), { credentials: 'same-origin' });
  if (!res.ok) throw new Error('No se pudo cargar personas');
  return res.json(); // [{ID, Nombre, Cargo, Teléfono, Correo, Unidad/Región, ...}]
}

function renderPersonaOptions(selectEl, personas) {
  selectEl.innerHTML = `<option value="">— Selecciona representante de GEM —</option>`;
  for (const p of personas) {
    const u = p['Unidad/Región'] ? ` — ${p['Unidad/Región']}` : '';
    const c = p['Cargo'] ? ` (${p['Cargo']})` : '';
    const label = `${p['Nombre']}${c}${u}`;
    const opt = document.createElement('option');
    opt.value = String(p['ID']);
    opt.textContent = label;
    selectEl.appendChild(opt);
  }
}

function fmtFechaISO(d) {
  if (!d) return '';
  const dd = new Date(d);
  if (isNaN(dd)) return '';
  return dd.toISOString().slice(0,10);
}

function fmtHoraStr(h) {
  return (h || '').slice(0,5);
}

function renderPersonaEventos(rows) {
  const tbody = document.getElementById('ppTablaBody');
  const badge = document.getElementById('ppCount');
  tbody.innerHTML = '';
  badge.textContent = rows.length;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-muted">Sin datos…</td></tr>`;
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.Fecha || ''}</td>
      <td>${fmtHoraStr(r.Hora)}</td>
      <td>${r.Evento || ''}</td>
      <td>${r.Municipio || ''}</td>
      <td>${r.Lugar || ''}</td>
      <td>${r.Convoca || ''}</td>
      <td>${r.ConvocaCargo || ''}</td>
      <td><span class="badge text-bg-${r.Estatus === 'Confirmado' ? 'success' : (r.Estatus === 'Sustituido' ? 'secondary' : (r.Estatus === 'Cancelado' ? 'danger' : 'warning'))}">${r.Estatus}</span></td>
    `;
    tbody.appendChild(tr);
  }
}

// Carga inicial del selector (opcional)
(async () => {
  try {
    const personas = await loadPersonasForPanel('');
    renderPersonaOptions(document.getElementById('ppPersona'), personas);
  } catch (e) {
    console.error(e);
  }
})();

async function pollInvitaciones() {
  try {
    const qs = lastSeenISO ? `?since=${encodeURIComponent(lastSeenISO)}` : '';
    const res = await fetch(`/api/invitaciones/updates${qs}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Respuesta inválida');

    // Si hay items, actualiza UI incrementalmente (merge)
    if (Array.isArray(data.items) && data.items.length) {
      // TODO: aquí llama a tu función que actualiza la tabla/tarjetas:
      // e.g. mergeStateInvitaciones(data.items); renderTablaInvitaciones();
      await window.refreshInvitacionesIncremental?.(data.items);
    }

    // encadena reloj del servidor para evitar desfaces
    if (data.now) lastSeenISO = data.now;
  } catch (err) {
    console.warn('Polling invitaciones falló:', err);
  }
}

// Inicia: primera corrida “full” (sin since)
pollInvitaciones();
setInterval(pollInvitaciones, 15000); // cada 15s (ajusta si quieres)

function renderGroupModal(grupoToken) {
  const modalEl = document.getElementById('modalGrupo');
  const body    = document.getElementById('grupoBody');
  const title   = document.getElementById('grupoTitle');
  if (!modalEl || !body || !title) return;

  const all = Array.isArray(STATE.invitaciones) ? STATE.invitaciones : [];

  // Filtra TODAS las invitaciones de ese grupo (sin importar la fecha)
  const list = all.filter(x => {
    const tok = (x.GrupoToken || x.grupo_token || '').trim();
    return tok && tok === grupoToken;
  });

  if (!list.length) {
    title.textContent = 'Eventos vinculados';
    body.innerHTML = '<div class="text-muted small">No se encontraron eventos para este grupo.</div>';
  } else {
    // Ordena por fecha + hora
    list.sort((a, b) => {
      const fa = (a.Fecha || '');
      const fb = (b.Fecha || '');
      if (fa < fb) return -1;
      if (fa > fb) return  1;
      const ha = (a.Hora || '');
      const hb = (b.Hora || '');
      return ha.localeCompare(hb);
    });

    title.textContent = `Eventos vinculados (${list.length})`;

    const html = list.map(x => {
      const fechaTxt = (x.Fecha || '').split('-').reverse().join('/') || '—';
      const horaTxt  = x.Hora || '—';
      const muni     = x.Municipio || '';
      const lugar    = x.Lugar || '';
      const evento   = x.Evento || 'Sin título';
      const estatus  = x.Estatus || '';
      const actor    = x.ActorNombre || x.Convoca || '—';
      const persona  = x.PersonaNombre || '—';
      const rol      = x.Rol || '';

      const subTipo  = (x.SubTipo || x.sub_tipo || '').toLowerCase();
      let badgeTipo = '';
      if (subTipo === 'pre')      badgeTipo = '<span class="badge bg-primary-subtle text-primary-emphasis ms-1">Pre</span>';
      else if (subTipo === 'publico') badgeTipo = '<span class="badge bg-warning-subtle text-warning-emphasis ms-1">Público</span>';
      else if (subTipo === 'mixto')   badgeTipo = '<span class="badge bg-success-subtle text-success-emphasis ms-1">Mixto</span>';

      const est = estatus.toLowerCase();
      let badgeEst = '<span class="badge text-bg-warning text-dark">Pendiente</span>';
      if (est.includes('confirm')) badgeEst = '<span class="badge text-bg-success">Confirmado</span>';
      else if (est.includes('cancel'))  badgeEst = '<span class="badge text-bg-danger">Cancelado</span>';
      else if (est.includes('sustit'))  badgeEst = '<span class="badge text-bg-info">Sustituido</span>';

      return `
        <div class="border rounded p-2 mb-2">
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <div class="fw-semibold">${evento} ${badgeTipo}</div>
              <div class="text-muted small">
                <i class="bi bi-calendar-event me-1"></i>${fechaTxt} · ${horaTxt}
              </div>
              <div class="text-muted small">
                <i class="bi bi-geo-alt me-1"></i>${muni} · ${lugar}
              </div>
              <div class="text-muted small">
                <i class="bi bi-megaphone me-1"></i><b>Convoca:</b> ${actor}
              </div>
              <div class="text-muted small">
                <i class="bi bi-person-check me-1"></i><b>Asignado:</b> ${persona}${rol ? ' ('+rol+')' : ''}
              </div>
              <div class="mt-1">${badgeEst}</div>
            </div>
            <div class="ms-2">
              <button class="btn btn-sm btn-outline-primary btn-goto" 
                      data-action="goto-inv" 
                      data-id="${x.ID}">
                Ver tarjeta
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    body.innerHTML = html;
  }

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

/* =========================
   Asignación por Región — Helpers y handler global
   Pegar en main.js (después de las funciones existentes)
   ========================= */
// ====== Module: Assign by Region ======
// Requiere Leaflet incluido en tu base.html, por ejemplo:
// <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
// <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>




// Renderiza lista de personas en la derecha (llama cuando tengas personas)
function renderRegionPersonas(region_id, personas) {
  const sel = document.getElementById('regPersona');
  if (!sel) return;
  sel.innerHTML = ['<option value="">— Seleccione —</option>']
    .concat((personas || []).map(p => {
      return `<option value="${p.ID}">${escapeHtml(p.Nombre)}${p.Cargo ? ' — ' + escapeHtml(p.Cargo) : ''}</option>`;
    })).join('');

  // muestra info resumen de la región
  const reg = (window.REGION_MODULE.regiones || []).find(r => String(r.id) === String(region_id));
  const infoEl = document.getElementById('regRegionInfo');
  if (infoEl) {
    infoEl.textContent = reg ? `Región: ${reg.nombre}` : '';
  }

  // limpia ficha persona
  showRegionPersonaInfo(null);
}

// Muestra ficha detallada de persona en #regionPersonaInfo
function showRegionPersonaInfo(p) {
  const el = document.getElementById('regionPersonaInfo');
  if (!el) return;
  if (!p) {
    el.innerHTML = `<div class="text-muted small">Selecciona una persona para ver su región, municipios y datos de contacto.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="fw-semibold">${escapeHtml(p.Nombre)}</div>
    <div class="small text-muted">${escapeHtml(p.Cargo || '-')}</div>
    <div class="mt-2 small"><b>Teléfono:</b> ${escapeHtml(p.Telefono || p['Teléfono'] || '-')}</div>
    <div class="small"><b>Correo:</b> ${escapeHtml(p.Correo || '-')}</div>
    <div class="small"><b>Unidad / Región:</b> ${escapeHtml(p['Unidad/Region'] || p['Unidad/Región'] || '-')}</div>
    <div class="mt-2">
      <button id="btnUsarPersonaRegion" class="btn btn-sm btn-success w-100">Usar esta persona en la designación</button>
    </div>
  `;

  // enlaza el botón para copiar a la pestaña general
  const btn = document.getElementById('btnUsarPersonaRegion');
  if (btn) {
    btn.onclick = () => {
      // copia al select #selPersona (y TomSelect si existe)
      try {
        const sel = document.getElementById('selPersona');
        if (sel) sel.value = String(p.ID);
        if (window.personaTS) {
          try { window.personaTS.setValue(String(p.ID), true); } catch {}
        }
        // rellena rol
        const inpRol = document.getElementById('inpRol');
        if (inpRol) inpRol.value = p.Cargo || '';
        // cambia a pestaña general
        try { new bootstrap.Tab(document.querySelector('#tab-general-tab')).show(); } catch(e){ }
      } catch (e) { console.warn('Error usando persona region:', e); }
    };
  }
}

// muestra / limpia info de region (simple)
function renderRegionInfo(regionObj, personas) {
  const info = document.getElementById('regRegionInfo');
  if (!info) return;
  if (!regionObj) {
    info.textContent = 'Selecciona una región para ver sus municipios.';
  } else {
    info.textContent = `${regionObj.nombre} — ${ (personas || []).length } representantes.`;
  }
}

// util escape
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// -----------------------------
// initAssignRegionModule (mejorada, idempotente)
// -----------------------------
async function initAssignRegionModule() {
  // init structure
  window.REGION_MODULE = window.REGION_MODULE || {
    regiones: [],
    region_municipios: [],
    personasPorRegion: {},
    muniToRegion: {},
    inited: false,
    listenersInited: false,
    _bootstrapped: false
  };

  // si ya inited, retorna inmediatamente
  if (window.REGION_MODULE.inited) return window.REGION_MODULE;

  // 0) asegúrate de poblar cache global de regiones/municipios
  await bootstrapRegionCache(); // idempotente, rellena REGION_MODULE.regiones, region_municipios, muniToRegion
  await bootstrapMunicipiosAndMap();

  // 1) si aún no tenemos regiones en la estructura, toma de bootstrap cache
  if (!Array.isArray(window.REGION_MODULE.regiones) || !window.REGION_MODULE.regiones.length) {
    // si bootstrap puso regiones, úsalas
    if (Array.isArray(window.REGION_MODULE.regiones) && window.REGION_MODULE.regiones.length) {
      // ok
    } else {
      // intenta solicitar /api/regiones como fallback
      try {
        const regs = await apiGet('/api/regiones');
        window.REGION_MODULE.regiones = Array.isArray(regs) ? regs : [];
      } catch (e) {
        console.warn('initAssignRegionModule: no se pudieron cargar /api/regiones', e);
        window.REGION_MODULE.regiones = window.REGION_MODULE.regiones || [];
      }
    }
  }

  // 2) Rellena <select id="regRegion"> si existe
  const sel = document.getElementById('regRegion');
  if (sel) {
    sel.innerHTML = ['<option value="">— Seleccione región —</option>']
      .concat((window.REGION_MODULE.regiones || []).map(r => `<option value="${escapeHtml(String(r.id))}">${escapeHtml(r.nombre)}</option>`))
      .join('');
  }

  // 3) Asegura que muniToRegion esté poblado (bootstrapRegionCache debería hacerlo)
  if (!window.REGION_MODULE.muniToRegion || Object.keys(window.REGION_MODULE.muniToRegion).length === 0) {
    // Si region_municipios ya existe, constrúyelo localmente
    if (Array.isArray(window.REGION_MODULE.region_municipios) && window.REGION_MODULE.region_municipios.length) {
      const map = {};
      window.REGION_MODULE.region_municipios.forEach(rm => {
        const k = normalizeMunicipioKey(rm.municipio || '');
        if (k) map[k] = String(rm.region_id);
      });
      window.REGION_MODULE.muniToRegion = map;
    } else {
      // intenta obtener todo en un solo endpoint (si lo creaste)
      try {
        const all = await apiGet('/api/region_municipios_all');
        if (all && all.muni_to_region) {
          window.REGION_MODULE.muniToRegion = all.muni_to_region;
          // normaliza keys por si acaso
          const normalized = {};
          Object.keys(window.REGION_MODULE.muniToRegion).forEach(k => {
            normalized[normalizeMunicipioKey(k)] = String(window.REGION_MODULE.muniToRegion[k]);
          });
          window.REGION_MODULE.muniToRegion = normalized;
        }
      } catch (e) {
        // no crítico
        console.warn('initAssignRegionModule: no pudo poblar muniToRegion desde /api/region_municipios_all', e);
      }
    }
  }

  // 4) Listeners (solo una vez)
  if (!window.REGION_MODULE.listenersInited) {
    // al cambiar región -> solicitar personas por region (cache)
    const selRegion = document.getElementById('regRegion');
    if (selRegion) {
      selRegion.addEventListener('change', async (ev) => {
        const rid = String(ev.target.value || '');
        if (!rid) {
          renderRegionPersonas(null, []);
          return;
        }
        // cache
        if (window.REGION_MODULE.personasPorRegion && window.REGION_MODULE.personasPorRegion[rid]) {
          renderRegionPersonas(rid, window.REGION_MODULE.personasPorRegion[rid]);
          return;
        }
        // fetch
        try {
          const rresp = await apiGet(`/api/regiones/${encodeURIComponent(rid)}/personas`);
          const personas = (rresp && Array.isArray(rresp.personas)) ? rresp.personas : (Array.isArray(rresp) ? rresp : []);
          window.REGION_MODULE.personasPorRegion = window.REGION_MODULE.personasPorRegion || {};
          window.REGION_MODULE.personasPorRegion[rid] = personas;
          renderRegionPersonas(rid, personas);
        } catch (err) {
          console.warn('Error al cargar personas por región:', err);
          renderRegionPersonas(rid, []);
        }
      });
    }

    // al cambiar regPersona -> mostrar ficha
    const selPersona = document.getElementById('regPersona');
    if (selPersona) {
      selPersona.addEventListener('change', (ev) => {
        const pid = String(ev.target.value || '');
        if (!pid) { showRegionPersonaInfo(null); return; }

        // busca en cache
        let found = null;
        for (const k of Object.keys(window.REGION_MODULE.personasPorRegion || {})) {
          const arr = window.REGION_MODULE.personasPorRegion[k] || [];
          const p = arr.find(x => String(x.ID) === pid || String(x.id) === pid);
          if (p) { found = p; break; }
        }
        // fallback: catalogIndex
        if (!found && window.catalogIndex && window.catalogIndex[pid]) found = window.catalogIndex[pid];
        showRegionPersonaInfo(found);
      });
    }

    window.REGION_MODULE.listenersInited = true;
  }

  window.REGION_MODULE.inited = true;
  return window.REGION_MODULE;
}


// ------------------ Helpers región / municipios (cliente) ------------------

/**
 * Normaliza un string similar al backend:
 * - extra spaces collapsed
 * - lowercase (casefold)
 * - optionally remove diacritics (normalize NFD + remove)
 */
function normalizeMunicipioKey(s) {
  if (!s) return '';
  // collapse whitespace, trim
  let t = String(s).trim().replace(/\s+/g, ' ');
  // remove diacritics
  try {
    t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {}
  return t.toLowerCase();
}


/**
 * bootstrapRegionCache()
 * - idempotente
 * - carga /api/region_municipios_all y rellena window.REGION_MODULE caches:
 *    - REGION_MODULE.regiones
 *    - REGION_MODULE.region_municipios (array)
 *    - REGION_MODULE.muniToRegion (map: normalized_muni -> region_id)
 */
async function bootstrapRegionCache() {
  window.REGION_MODULE = window.REGION_MODULE || { inited:false, regiones:[], region_municipios:[], muniToRegion:{} , _bootstrapped:false };
  if (window.REGION_MODULE._bootstrapped) return window.REGION_MODULE;

  try {
    const resp = await apiGet('/api/region_municipios_all');
    if (resp && resp.ok) {
      window.REGION_MODULE.regiones = Array.isArray(resp.regiones) ? resp.regiones : [];
      window.REGION_MODULE.region_municipios = Array.isArray(resp.region_municipios) ? resp.region_municipios : [];

      // build muni->region mapping normalized (use normalizeMunicipioKey)
      const map = {};
      // If backend gave a map:
      if (resp.muni_to_region && typeof resp.muni_to_region === 'object') {
        for (const k of Object.keys(resp.muni_to_region)) {
          const norm = normalizeMunicipioKey(k);
          if (norm) map[norm] = String(resp.muni_to_region[k]);
        }
      }
      // Also ensure we include explicit rows list if present
      if (Array.isArray(window.REGION_MODULE.region_municipios) && window.REGION_MODULE.region_municipios.length) {
        for (const rm of window.REGION_MODULE.region_municipios) {
          const k = normalizeMunicipioKey(rm.municipio || '');
          if (k) map[k] = String(rm.region_id);
        }
      }

      window.REGION_MODULE.muniToRegion = map;
      window.REGION_MODULE._bootstrapped = true;
      return window.REGION_MODULE;
    } else {
      console.warn('bootstrapRegionCache: respuesta inválida', resp);
      return window.REGION_MODULE;
    }
  } catch (e) {
    console.warn('bootstrapRegionCache fallo:', e);
    return window.REGION_MODULE;
  }
}


/**
 * inferRegionIdByMunicipio(muniName)
 * - devuelve region_id (number or string) o null
 */
function inferRegionIdByMunicipio(muniName) {
  if (!muniName) return null;
  const k = normalizeMunicipioKey(muniName);
  const map = (window.REGION_MODULE && window.REGION_MODULE.muniToRegion) || {};
  return map[k] != null ? String(map[k]) : null;
}

/**
 * setRegionAndPersons(regionId, personsArray)
 * - Pone el select #regRegion = regionId (string), rellena regPersona con personsArray (si viene)
 * - Guarda en cache personasPorRegion para evitar refetch
 * - No hace dispatch change (evita re-fetch doble). Si quieres dispatch, modifícalo.
 */
function setRegionAndPersons(regionId, personsArray) {
  if (!regionId) return;
  window.REGION_MODULE = window.REGION_MODULE || { personasPorRegion: {} };

  // 1) Asegura que regRegion tenga la opción (si no existe, la añade)
  const regSel = document.getElementById('regRegion');
  if (regSel) {
    const strRid = String(regionId);
    let optExists = false;
    for (let i=0;i<regSel.options.length;i++){
      if (String(regSel.options[i].value) === strRid) { optExists = true; break; }
    }
    if (!optExists) {
      // intenta encontrar nombre en la cache de regiones
      const reg = (window.REGION_MODULE.regiones || []).find(r => String(r.id) === strRid);
      const label = reg ? reg.nombre : `Región ${strRid}`;
      const newOpt = document.createElement('option');
      newOpt.value = strRid;
      newOpt.textContent = label;
      // append but keep alphabetical? simple append is fine.
      regSel.appendChild(newOpt);
    }
    // ahora sí setea el value
    try { regSel.value = strRid; } catch(e) { regSel.value = strRid; }
  }

  // 2) cache y render personas
  window.REGION_MODULE.personasPorRegion = window.REGION_MODULE.personasPorRegion || {};
  if (Array.isArray(personsArray) && personsArray.length) {
    window.REGION_MODULE.personasPorRegion[String(regionId)] = personsArray;
    renderRegionPersonas(String(regionId), personsArray);
  } else {
    const cached = window.REGION_MODULE.personasPorRegion && window.REGION_MODULE.personasPorRegion[String(regionId)];
    if (cached) {
      renderRegionPersonas(String(regionId), cached);
    } else {
      // desencadena listener de cambio para que haga fetch (si lo prefieres)
      if (regSel) regSel.dispatchEvent(new Event('change'));
    }
  }
}

// -----------------------------
// MUNICIPIOS_MODULE (módulo completo, parcheado con colores por región)
// -----------------------------
window.MUNICIPIOS_MODULE = window.MUNICIPIOS_MODULE || (function(){
  const M = {
    inited: false,
    features: [],        // GeoJSON features
    muniGeoMap: {},      // normalized_muni -> [feature, ...]
    map: null,
    polygonsLayer: null,
    MUNICIPIOS_URL: '/static/municipios.json',
    featureCollection: null,
    muniToRegion: {},    // filled by loadRegionColorsAndMap
    regionColorMap: {},  // filled by loadRegionColorsAndMap
    regionList: []
  };

  // ---------- Helpers ----------
  function normalizeKey(s){
    if(!s) return '';
    try {
      return String(s).trim().replace(/\s+/g,' ')
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    } catch(e) {
      return String(s).trim().replace(/\s+/g,' ').toLowerCase();
    }
  }

  function isFiniteNumber(x){ return typeof x === 'number' && isFinite(x); }
  function toNumLoose(v){
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'string') v = v.replace(/,/g, '.').trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  // ------------- Sanitizador + safe add -------------
  function sanitizeCoordsArray(arr){
    if (!Array.isArray(arr)) return null;
    // base: coordinate pair
    if (arr.length >= 2 && typeof arr[0] !== 'object') {
      const lon = toNumLoose(arr[0]);
      const lat = toNumLoose(arr[1]);
      if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) return null;
      const rest = arr.slice(2).map(toNumLoose).filter(Number.isFinite);
      return [lon, lat, ...rest];
    }
    // nested
    const out = [];
    for (const el of arr){
      const s = sanitizeCoordsArray(el);
      if (s !== null) out.push(s);
    }
    return out.length ? out : null;
  }

  function sanitizeGeometry(geom){
    if (!geom || !geom.type) return null;
    const type = geom.type;
    try {
      if (type === 'Point') {
        const c = sanitizeCoordsArray(geom.coordinates);
        if (!c) return null;
        return { type: 'Point', coordinates: c };
      }
      if (type === 'LineString' || type === 'MultiPoint') {
        const c = sanitizeCoordsArray(geom.coordinates);
        if (!c) return null;
        return { type, coordinates: c };
      }
      if (type === 'Polygon' || type === 'MultiLineString') {
        const c = sanitizeCoordsArray(geom.coordinates);
        if (!c) return null;
        return { type, coordinates: c };
      }
      if (type === 'MultiPolygon') {
        const c = sanitizeCoordsArray(geom.coordinates);
        if (!c) return null;
        return { type: 'MultiPolygon', coordinates: c };
      }
      if (type === 'GeometryCollection') {
        const geoms = [];
        for (const g of (geom.geometries || [])) {
          const sg = sanitizeGeometry(g);
          if (sg) geoms.push(sg);
        }
        return geoms.length ? { type: 'GeometryCollection', geometries: geoms } : null;
      }
    } catch (e) {
      console.warn('sanitizeGeometry error', e);
      return null;
    }
    return null;
  }

  async function safeAddGeoJSON(layer, geojson){
    if (!layer || !geojson) return;
    try {
      const toAdd = (geojson.type === 'Feature') ? { type: 'FeatureCollection', features: [geojson] } : geojson;
      layer.addData(toAdd);
      console.debug('safeAddGeoJSON: addData OK (direct)', (geojson.properties && geojson.properties.municipio) || null);
      return;
    } catch (err) {
      console.warn('safeAddGeoJSON: addData directo falló, intentando fallback.', err, geojson && geojson.properties && geojson.properties.municipio);
      let clean = null;
      try { clean = sanitizeGeoJSON(geojson); } catch(e){ clean = null; }
      if (clean) {
        try { layer.addData(clean); console.debug('safeAddGeoJSON: addData OK (sanitizado)'); return; }
        catch(e2){ console.error('safeAddGeoJSON: addData con GeoJSON sanitizado falló', e2); }
      }
      try {
        const tmpObj = (geojson.type === 'Feature') ? { type:'FeatureCollection', features:[geojson] } : geojson;
        const tmp = L.geoJSON(tmpObj);
        let count = 0;
        tmp.eachLayer(l => {
          try { layer.addLayer(l); count++; }
          catch(e){ console.warn('safeAddGeoJSON: no pudo añadir sublayer', e); }
        });
        if (count) { console.debug('safeAddGeoJSON: fallback ok, capas transferidas:', count); return; }
        console.error('safeAddGeoJSON: tmp creó 0 capas para', geojson && geojson.properties && geojson.properties.municipio);
      } catch(e3){
        console.error('safeAddGeoJSON: fallback final falló', e3, geojson && geojson.properties && geojson.properties.municipio);
      }
      console.error('safeAddGeoJSON: no se pudo agregar GeoJSON al layer. GeoJSON original:', geojson);
    }
  }

  function sanitizeGeoJSON(obj){
    if (!obj) return null;
    if (obj.type === 'FeatureCollection') {
      const feats = [];
      for (const f of (obj.features || [])) {
        const sf = sanitizeFeature(f);
        if (sf) feats.push(sf);
        else {
          console.warn('GeoJSON: feature omitida por coordenadas inválidas', f && f.properties ? f.properties : f);
        }
      }
      return { type: 'FeatureCollection', features: feats };
    }
    if (obj.type === 'Feature') return sanitizeFeature(obj) ? obj : null;
    const sgeom = sanitizeGeometry(obj);
    if (sgeom) return { type: 'Feature', properties: {}, geometry: sgeom };
    return null;
  }

  function sanitizeFeature(feature){
    if (!feature || feature.type !== 'Feature') return null;
    const sgeom = sanitizeGeometry(feature.geometry);
    if (!sgeom) return null;
    return { type: 'Feature', properties: feature.properties || {}, geometry: sgeom };
  }

  // ------------- Parser WKT robusto -------------
  function parseWKTToGeoJSONFeature(wkt, props = {}) {
    if (!wkt || typeof wkt !== 'string') return null;
    let s = String(wkt).trim();

    // eliminar SRID=xxxx;
    s = s.replace(/^\s*SRID=\d+;/i, '').trim();
    // limpiar caracteres raros (control, non-ascii)
    s = s.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();

    if (!s) return null;
    // manejar EMPTY
    if (/EMPTY$/i.test(s)) return null;

    // quitar tokens Z/M después del tipo (ej: POLYGON Z ( ... ) )
    s = s.replace(/(POLYGON|MULTIPOLYGON)\s+[ZM]\s*\(/i, (m, p1) => p1 + '(');

    // detectar tipo
    const isMulti = /^MULTIPOLYGON/i.test(s);
    const isPoly = /^POLYGON/i.test(s);
    if (!isPoly && !isMulti) return null;

    // extraer contenido entre primer '(' y último ')'
    const firstParen = s.indexOf('(');
    const lastParen  = s.lastIndexOf(')');
    if (firstParen < 0 || lastParen <= firstParen) return null;
    let inner = s.slice(firstParen, lastParen + 1).trim();

    function parseRingsFromParenString(str) {
      const rings = [];
      let cur = '';
      let depth = 0;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '(') {
          depth++;
          if (depth >= 2) cur += ch;
          continue;
        }
        if (ch === ')') {
          if (depth >= 2) cur += ch;
          depth--;
          if (depth === 1) {
            const ringText = cur.trim();
            if (ringText) {
              const pts = ringText.split(/\s*,\s*/).map(pt => {
                const parts = pt.trim().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
                const nums = parts.map(p => Number(String(p).replace(/,/g, '.')));
                if (nums.length < 2 || Number.isNaN(nums[0]) || Number.isNaN(nums[1])) return null;
                return [nums[0], nums[1]];
              }).filter(Boolean);
              if (pts.length) rings.push(pts);
            }
            cur = '';
          }
          continue;
        }
        if (depth >= 2) cur += ch;
      }
      return rings;
    }

    function extractPolygonsFromMulti(innerStr) {
      const polygons = [];
      let cur = '';
      let depth = 0;
      for (let i = 0; i < innerStr.length; i++) {
        const ch = innerStr[i];
        if (ch === '(') {
          depth++;
          if (depth >= 2) cur += ch;
          continue;
        }
        if (ch === ')') {
          if (depth >= 2) cur += ch;
          depth--;
          if (depth === 0) {
            const piece = cur.trim();
            if (piece) {
              polygons.push('(' + piece.replace(/^\(+|\)+$/g,'') + ')');
            }
            cur = '';
          }
          continue;
        }
        if (depth >= 1) cur += ch;
      }
      return polygons;
    }

    try {
      if (isMulti) {
        const polyBlocks = extractPolygonsFromMulti(inner);
        const multiCoords = [];
        for (const block of polyBlocks) {
          const rings = parseRingsFromParenString(block);
          if (!rings || !rings.length) continue;
          multiCoords.push(rings);
        }
        if (!multiCoords.length) return null;
        return { type: 'Feature', properties: props || {}, geometry: { type: 'MultiPolygon', coordinates: multiCoords } };
      } else {
        const rings = parseRingsFromParenString(inner);
        if (!rings || !rings.length) return null;
        return { type: 'Feature', properties: props || {}, geometry: { type: 'Polygon', coordinates: rings } };
      }
    } catch (e) {
      console.warn('parseWKTToGeoJSONFeature error', e);
      return null;
    }
  }

  // ------------- WKT helpers: detect swap -------------
  function maybeSwapIfLatLonSample(sample){
    if (!Array.isArray(sample) || sample.length < 2) return false;
    const a = toNumLoose(sample[0]), b = toNumLoose(sample[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (Math.abs(a) <= 90 && Math.abs(b) > 90) return true;
    return false;
  }
  function swapCoordsRec(coords){
    if (!Array.isArray(coords)) return coords;
    if (coords.length && typeof coords[0] !== 'object') {
      return [coords[1], coords[0], ...(coords.slice(2) || [])];
    }
    return coords.map(swapCoordsRec);
  }
  function deepRepairCoords(coords){
    if (!Array.isArray(coords)) return null;
    if (coords.length && typeof coords[0] !== 'object') {
      const a = toNumLoose(coords[0]), b = toNumLoose(coords[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const rest = coords.slice(2).map(v=> toNumLoose(v)).filter(Number.isFinite);
      return [a,b,...rest];
    }
    const out = [];
    for (const sub of coords){
      const r = deepRepairCoords(sub);
      if (!r) return null;
      out.push(r);
    }
    return out.length ? out : null;
  }

  // ----------------------------------------------------
  // Region colors / mapping: carga endpoint region_municipios_all
  // ----------------------------------------------------
  async function loadRegionColorsAndMap() {
    try {
      const res = await fetch('/api/region_municipios_all', { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch region_municipios_all ' + res.status);
      const j = await res.json();

      M.regionList = Array.isArray(j.regiones) ? j.regiones : (j.regiones || []);
      M.muniToRegion = j.muni_to_region && typeof j.muni_to_region === 'object' ? j.muni_to_region : {};
      if (!M.muniToRegion || Object.keys(M.muniToRegion).length === 0) {
        M.muniToRegion = {};
        for (const rm of (j.region_municipios || [])) {
          const key = normalizeKey(rm.municipio || '');
          if (key) M.muniToRegion[key] = rm.region_id;
        }
      }

      M.regionColorMap = {};
      for (const r of (M.regionList || [])) {
        if (r && r.id != null) M.regionColorMap[String(r.id)] = (r.color || '').trim() || null;
      }

      console.log('[MUNICIPIOS_MODULE] loadRegionColorsAndMap OK; regiones:', (M.regionList||[]).length);
      return { muniToRegion: M.muniToRegion, regionColorMap: M.regionColorMap };
    } catch (e) {
      console.warn('[MUNICIPIOS_MODULE] loadRegionColorsAndMap error', e);
      M.muniToRegion = M.muniToRegion || {};
      M.regionColorMap = M.regionColorMap || {};
      return null;
    }
  }

  // style helper uses M.muniToRegion & M.regionColorMap
  function styleForFeature(feature, opts = {}) {
    const defaultColor = '#0b5ed7';
    try {
      const muni = normalizeKey((feature && feature.properties && feature.properties.municipio) || '');
      const rid = (M.muniToRegion && M.muniToRegion[muni] != null) ? String(M.muniToRegion[muni]) : null;
      const baseColor = (rid && M.regionColorMap && M.regionColorMap[rid]) ? M.regionColorMap[rid] : defaultColor;

      if (opts.highlightRegionId && String(opts.highlightRegionId) === String(rid)) {
        return { color: baseColor, weight: 2.5, opacity: 0.95, fillOpacity: 0.6 };
      }
      return { color: baseColor, weight: 1, opacity: 0.9, fillOpacity: 0.35 };
    } catch (e) {
      return { color: defaultColor, weight: 1, fillOpacity: 0.35 };
    }
  }

  function refreshPolygonsStyle(highlightRegionId = null) {
    if (!M.polygonsLayer) return;
    M.polygonsLayer.eachLayer(layer => {
      try {
        const f = layer.feature;
        if (!f) return;
        const st = styleForFeature(f, { highlightRegionId });
        if (typeof layer.setStyle === 'function') layer.setStyle(st);
      } catch (e) {
        console.warn('refreshPolygonsStyle error', e);
      }
    });
  }

  // expose safeAddGeoJSON for external use
  M.safeAddGeoJSON = safeAddGeoJSON;

  // (re)exponer aliases globales seguros
  (function exposeAliasesSafely(){
    const names = [
      'bootstrapMunicipiosAndMap',
      'loadMunicipiosJson',
      'initMunicipiosMap',
      'showMunicipiosForRegion',
      'showMunicipiosByNames',
      'safeAddGeoJSON',
      'loadRegionColorsAndMap',
      'refreshPolygonsStyle',
      'styleForFeature',
      'ensureMapReadyAndShowRegion'
    ];

    names.forEach(name => {
      if (typeof window[name] === 'function') return;
      window[name] = function(...args){
        try {
          const fn = M && M[name];
          if (typeof fn === 'function') {
            return fn.apply(M, args);
          } else {
            console.warn(`Alias ${name} invocado pero M.${name} aún no está disponible.`);
            return Promise.reject(new Error(`M.${name} no disponible aún`));
          }
        } catch (e) {
          console.error(`Error delegando ${name} -> M.${name}`, e);
          return Promise.reject(e);
        }
      };
    });
  })();

  // ------------- Cargar municipios (WKT o geometry) -------------
  async function loadMunicipiosJson(url){
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error('fetch error ' + res.status);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('El JSON no es un array de municipios');

      const feats = [];
      const map = {};
      const failed = [];

      for (const item of arr){
        const muniName = item.municipio || item.Municipio || item.nombre || item.MUN || '';
        const props = { municipio: muniName, cve_entidad: item.cve_entidad, cve_municipio: item.cve_municipio };
        let feature = null;

        if (item.geometry && typeof item.geometry === 'object' && item.geometry.type && item.geometry.coordinates) {
          feature = { type: 'Feature', properties: props, geometry: JSON.parse(JSON.stringify(item.geometry)) };
        } else {
          const rawPol = item.poligono ?? item.POLIGONO ?? item.wkt ?? item.WKT ?? null;

          if (rawPol && typeof rawPol === 'object' && rawPol.type && rawPol.coordinates) {
            feature = { type: 'Feature', properties: props, geometry: JSON.parse(JSON.stringify(rawPol)) };
          } else {
            let wkt = rawPol != null ? String(rawPol).trim() : '';
            if (/^\s*SRID=/i.test(wkt)) {
              wkt = wkt.replace(/^\s*SRID=\d+;/i, '').trim();
            }
            if (!feature && wkt && (wkt[0] === '{' || wkt[0] === '[')) {
              try {
                const maybe = JSON.parse(wkt);
                if (maybe && maybe.type && maybe.coordinates) {
                  feature = { type: 'Feature', properties: props, geometry: maybe };
                }
              } catch(e){}
            }

            if (!feature && wkt && typeof wellknown === 'function') {
              try {
                const geom = wellknown(wkt);
                if (geom && geom.type && geom.coordinates) feature = { type:'Feature', properties:props, geometry:geom };
              } catch(e){}
            }

            if (!feature && wkt) {
              try {
                feature = parseWKTToGeoJSONFeature(wkt, props);
              } catch(e){
                console.warn('parseWKTToGeoJSONFeature lanzó error', e, muniName);
                feature = null;
              }
            }
          }
        }

        if (!feature) {
          console.warn('loadMunicipiosJson: feature no construida para', muniName, {
            poligono_raw: item.poligono ?? item.POLIGONO ?? item.wkt ?? item.WKT ?? null,
            geometry_raw: item.geometry ?? null
          });
          failed.push({ municipio: muniName, raw: item.poligono ?? item.POLIGONO ?? item.wkt ?? item.WKT ?? item.geometry ?? null });
          continue;
        }

        let sample = null;
        try {
          if (feature.geometry.type === 'Polygon') sample = feature.geometry.coordinates[0] && feature.geometry.coordinates[0][0];
          else if (feature.geometry.type === 'MultiPolygon') sample = feature.geometry.coordinates[0] && feature.geometry.coordinates[0][0] && feature.geometry.coordinates[0][0][0];
        } catch(e){ sample = null; }

        if (maybeSwapIfLatLonSample(sample)) {
          feature.geometry.coordinates = swapCoordsRec(feature.geometry.coordinates);
          console.warn('loadMunicipiosJson: swap aplicado (lat/lon -> lon/lat) para', muniName);
        }
        const repaired = deepRepairCoords(feature.geometry.coordinates);
        if (!repaired) {
          feature.geometry.coordinates = swapCoordsRec(feature.geometry.coordinates);
          const repaired2 = deepRepairCoords(feature.geometry.coordinates);
          if (!repaired2) {
            console.warn('loadMunicipiosJson: no se pudo reparar coordenadas para', muniName);
            failed.push({ municipio: muniName, reason: 'coords_repair_failed' });
            continue;
          }
          feature.geometry.coordinates = repaired2;
        } else {
          feature.geometry.coordinates = repaired;
        }

        feats.push(feature);
        const key = normalizeKey(muniName || '');
        map[key] = map[key] || [];
        map[key].push(feature);
      } // end loop

      M.features = feats;
      M.muniGeoMap = map;
      M.featureCollection = { type: 'FeatureCollection', features: feats };

      console.log('[MUNICIPIOS_MODULE] loaded + repaired features:', feats.length, 'keys:', Object.keys(map).length);
      if (failed.length) {
        console.warn('[MUNICIPIOS_MODULE] registros fallidos (primeros 20):', failed.slice(0,20));
      }
      return M;
    } catch (e) {
      console.warn('[MUNICIPIOS_MODULE] loadMunicipiosJson error:', e);
      throw e;
    }
  }

  // ------------- Map init -------------
  function initMunicipiosMap(containerId = 'regMap'){
    try {
      if (M.map) {
        try { M.map.invalidateSize(); } catch(e){}
        return M;
      }
      const container = document.getElementById(containerId);
      if (!container) { console.warn('initMunicipiosMap: container no encontrado', containerId); return M; }

      // asegúrate CSS: #regMap{height:...}
      M.map = L.map(containerId, { preferCanvas: true }).setView([19.3, -99.6], 9);
      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        {
          attribution: '&copy; OpenStreetMap &copy; CARTO',
          subdomains: 'abcd',
          maxZoom: 19
        }
      ).addTo(M.map);

      // crea polygonsLayer con style dinámico
      M.polygonsLayer = L.geoJSON(null, {
        style: (feature)=> styleForFeature(feature, {}),
        onEachFeature: (f, layer) => {
          const name = (f.properties && f.properties.municipio) ? f.properties.municipio : 'Municipio';
          layer.bindTooltip(name, {sticky:true});
          // interacciones básicas
          layer.on({
            mouseover: (e) => {
              try { e.target.setStyle({ weight: 2.2 }); } catch(e){}
            },
            mouseout: (e) => {
              try { if (M.polygonsLayer.resetStyle) M.polygonsLayer.resetStyle(e.target); } catch(e){}
            },
            click: (e) => {
              try {
                if (layer.getPopup && !layer.getPopup()) {
                  layer.bindPopup(`<strong>${name}</strong>`);
                }
                if (layer.openPopup) layer.openPopup();
                if (layer.getBounds && M.map) M.map.fitBounds(layer.getBounds(), { padding:[20,20] });
              } catch(e){}
            }
          });
        }
      }).addTo(M.map);

      console.log('[MUNICIPIOS_MODULE] mapa inicializado:', containerId);
      M.inited = true;
      return M;
    } catch (e) {
      console.warn('initMunicipiosMap error', e);
      return M;
    }
  }

  // ------------- Mostrar por nombres -------------
  async function showMunicipiosByNames(names = [], clearPrev = true){
    if (!Array.isArray(names) || !names.length) { console.warn('showMunicipiosByNames: sin nombres'); return; }
    if (!M.map) initMunicipiosMap();
    if (!M.polygonsLayer) M.polygonsLayer = L.geoJSON(null).addTo(M.map);
    if (clearPrev) M.polygonsLayer.clearLayers();

    const keys = Object.keys(M.muniGeoMap || {});
    const norm = normalizeKey;
    const added = [];
    const missing = [];

    for (const nm of names){
      const orig = nm;
      const k = norm(nm || '');
      if (!k) { missing.push({orig, reason:'empty'}); continue; }

      let feats = M.muniGeoMap[k];
      if (!feats) {
        const keyFound = keys.find(x => x === k || x.startsWith(k) || k.startsWith(x) || x.indexOf(k) !== -1 || k.indexOf(x) !== -1);
        if (keyFound) feats = M.muniGeoMap[keyFound];
      }
      if (!feats) {
        const cand = keys.find(x => {
          const a = x.split(' ').filter(Boolean);
          const b = k.split(' ').filter(Boolean);
          const inter = a.filter(v => b.includes(v));
          return inter.length >= Math.min(1, Math.floor(Math.min(a.length,b.length)/2));
        });
        if (cand) feats = M.muniGeoMap[cand];
      }
      if (!feats) { missing.push({orig, key:k}); continue; }

      for (const f of feats){
        try {
          await safeAddGeoJSON(M.polygonsLayer, f);
          added.push(k);
        } catch(e){
          console.warn('Feature inválida o no añadida para', orig, e);
        }
      }
    }

    try {
      const layerBounds = M.polygonsLayer.getBounds();
      if (layerBounds && layerBounds.isValid && layerBounds.isValid()) {
        M.map.fitBounds(layerBounds.pad(0.1));
      } else {
        console.warn('showMunicipiosByNames: no hay bounds válidos tras añadir features');
      }
    } catch (e) { console.warn('showMunicipiosByNames fitBounds error', e); }

    // reaplicar estilos (por si se añadieron con color por default)
    try { refreshPolygonsStyle(); } catch(e){}

    console.log('[MUNICIPIOS_MODULE] showMunicipiosByNames added:', added.length, 'missing:', missing.length);
    if (missing.length) console.table(missing.slice(0,50));
  }

  // ------------- Por región -------------
  function showMunicipiosForRegion(regionId){
    if (!regionId) { console.warn('showMunicipiosForRegion: regionId vacía'); return; }
    const rm = (window.REGION_MODULE && Array.isArray(window.REGION_MODULE.region_municipios)) ? window.REGION_MODULE.region_municipios : null;
    if (!rm) { console.warn('showMunicipiosForRegion: no hay region_municipios en window.REGION_MODULE'); return; }
    const list = rm.filter(r => String(r.region_id) === String(regionId)).map(x => x.municipio || x.Municipio || x.nombre);
    if (!list.length) { console.warn('showMunicipiosForRegion: región sin municipios', regionId); return; }
    showMunicipiosByNames(list, true);
    try { refreshPolygonsStyle(regionId); } catch(e){ console.warn('refreshPolygonsStyle en showMunicipiosForRegion falló', e); }
  }

  // ------------- Bootstrap -------------
  async function bootstrapMunicipiosAndMap(){
    if (!M.features || !M.features.length) {
      try { await loadMunicipiosJson(M.MUNICIPIOS_URL); } catch(e){ console.warn('bootstrapMunicipiosAndMap: error al cargar JSON:', e); }
    }

    // load region colors early
    try { await loadRegionColorsAndMap(); } catch(e){ console.warn('bootstrapMunicipiosAndMap: loadRegionColorsAndMap fallo', e); }

    const c = document.getElementById('regMap');
    const visible = c && c.offsetParent !== null;
    if (visible) {
      initMunicipiosMap('regMap');
      if (M.features && M.features.length && M.polygonsLayer) {
        M.polygonsLayer.clearLayers();
        let addedCount = 0;
        for (const f of M.features) {
          try { await safeAddGeoJSON(M.polygonsLayer, f); addedCount++; }
          catch (e) { console.warn('feature omitida al agregar:', e, f && f.properties && f.properties.municipio); }
        }
        console.log('[MUNICIPIOS_MODULE] features añadidas al layer:', addedCount);
        try {
          // reaplicar estilos en bloque
          refreshPolygonsStyle();
        } catch(e){ console.warn('refreshPolygonsStyle fallo en bootstrap', e); }

        try {
          const b = M.polygonsLayer.getBounds();
          if (b && b.isValid && b.isValid()) M.map.fitBounds(b.pad(0.08));
        } catch(e){ console.warn('fitBounds fallo', e); }
      }
      try { M.map.invalidateSize(); } catch(e){}
    } else {
      console.log('[MUNICIPIOS_MODULE] contenedor #regMap no visible, parseado OK pero mapa no inicializado');
    }
    M.inited = true;
    return M;
  }

  // ------------- Ensure helper (público) -------------
  async function ensureMapReadyAndShowRegion(regionIdToShow = null) {
    try {
      if (!(M.features && M.features.length)) {
        try { await loadMunicipiosJson(M.MUNICIPIOS_URL); } catch(e){ console.warn('ensure: loadMunicipiosJson fallo', e); }
      }
      try { await loadRegionColorsAndMap(); } catch(e){ /* ignore */ }

      if (!M.map) {
        try { initMunicipiosMap('regMap'); } catch(e){ console.warn('ensure: initMunicipiosMap fallo', e); }
      }

      if (!M.polygonsLayer && M.map) {
        try {
          M.polygonsLayer = L.geoJSON(null, {
            style: (feature)=> styleForFeature(feature, {}),
            onEachFeature: (f, layer) => {
              const name = (f.properties && f.properties.municipio) ? f.properties.municipio : 'Municipio';
              layer.bindTooltip(name, { sticky:true });
            }
          }).addTo(M.map);
        } catch(e){ console.warn('ensure: crear polygonsLayer fallo', e); }
      }

      try {
        let layerCount = 0;
        M.polygonsLayer?.eachLayer(()=> layerCount++);
        if (!layerCount && M.featureCollection) {
          if (typeof M.safeAddGeoJSON === 'function') {
            await M.safeAddGeoJSON(M.polygonsLayer, M.featureCollection);
          } else {
            const tmp = L.geoJSON(M.featureCollection);
            tmp.eachLayer(l => M.polygonsLayer.addLayer(l));
          }
          refreshPolygonsStyle();
        }
      } catch(e){ console.warn('ensure: añadir featureCollection fallo', e); }

      if (regionIdToShow) {
        try { showMunicipiosForRegion(regionIdToShow); }
        catch(e){ console.warn('ensure: showMunicipiosForRegion fallo', e); }
      }

      try { setTimeout(()=> { M.map && M.map.invalidateSize && M.map.invalidateSize(); }, 120); } catch(e){}
    } catch(e) {
      console.warn('ensureMapReadyAndShowRegion error', e);
    }
  }

  // expose
  M.normalizeKey = normalizeKey;
  M.parseWKTToGeoJSONFeature = parseWKTToGeoJSONFeature;
  M.loadMunicipiosJson = loadMunicipiosJson;
  M.initMunicipiosMap = initMunicipiosMap;
  M.showMunicipiosByNames = showMunicipiosByNames;
  M.showMunicipiosForRegion = showMunicipiosForRegion;
  M.bootstrapMunicipiosAndMap = bootstrapMunicipiosAndMap;
  M.loadRegionColorsAndMap = loadRegionColorsAndMap;
  M.styleForFeature = styleForFeature;
  M.refreshPolygonsStyle = refreshPolygonsStyle;
  M.ensureMapReadyAndShowRegion = ensureMapReadyAndShowRegion;

  return M;
})();







