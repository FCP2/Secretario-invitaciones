# =============================================================================
# app.py — Flask + JWT (cookie HttpOnly) + Jinja templates + API Invitaciones
# =============================================================================
import os
import re
import uuid
import mimetypes
from datetime import datetime, date, time as dtime, timedelta
from typing import Optional, Callable
from functools import wraps
# ↑ al inicio de app.py (zona imports), agrega:
from sqlalchemy.exc import OperationalError, ProgrammingError, IntegrityError
from flask import (
    Flask, request, jsonify, send_file, render_template, redirect, url_for, make_response, g
)
from flask_cors import CORS

# JWT
import jwt

# Password hashing
from passlib.hash import bcrypt

# DB models (tu db.py con el esquema nuevo)
from db import (
    engine, SessionLocal,
    Sexo, Partido, Usuario,
    Actor, Persona, Invitacion, Notificacion, Region, RegionMunicipio
)
from uuid import uuid4
from sqlalchemy.orm import joinedload
from sqlalchemy import or_
from pathlib import Path
from werkzeug.utils import secure_filename
from flask import send_from_directory, abort, redirect
from io import BytesIO
import pandas as pd
from flask import send_file
from datetime import timedelta, datetime as _dt  # asegúrate de tener esto importado

# =============================================================================
# Config App + Templates
# =============================================================================
APP_SECRET = os.getenv("APP_SECRET", "dev-secret-change-me")
TOKEN_TTL_HOURS = int(os.getenv("TOKEN_TTL_HOURS", "12"))
COOKIE_NAME = os.getenv("COOKIE_NAME", "session_token")
COOKIE_SECURE = bool(int(os.getenv("COOKIE_SECURE", "0")))  # 0 dev, 1 prod

app = Flask(
    __name__,
    static_url_path="/static",
    static_folder="static",
    template_folder="templates"  # <- plural, relativo
)
CORS(app, supports_credentials=True)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB

# =============================================================================
# Helpers: JWT & Auth
# =============================================================================
def make_token(payload: dict, ttl_hours: int = TOKEN_TTL_HOURS) -> str:
    exp = datetime.utcnow() + timedelta(hours=ttl_hours)
    data = {**payload, "exp": exp}
    return jwt.encode(data, APP_SECRET, algorithm="HS256")

def verify_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, APP_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None

def get_user_from_token() -> Optional[Usuario]:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    data = verify_token(token)
    if not data:
        return None
    uid = data.get("uid")
    if not uid:
        return None
    db = SessionLocal()
    try:
        u = db.get(Usuario, int(uid))
        if u and u.activo:
            return u
        return None
    finally:
        db.close()

# Helper pequeño: convierte input roles a set o None
def _normalize_roles(roles):
    if roles is None:
        return None
    if isinstance(roles, (list, tuple, set)):
        return set(map(str, roles))
    # si se pasa string: "admin,editor"
    if isinstance(roles, str):
        return set([r.strip() for r in roles.split(',') if r.strip()])
    return None

def auth_required(roles=None):
    """
    Decorador que puede usarse sin argumentos:
      @auth_required
    o con roles:
      @auth_required(['admin','editor'])
    o con string:
      @auth_required('admin,editor')

    Si el usuario no está autenticado -> 401 JSON.
    Si no tiene rol permitido -> 403 JSON.
    Adjunta el usuario en g.current_user (y también g.user por compatibilidad).
    """
    allowed = _normalize_roles(roles)

    # Si se usó como @auth_required sin paréntesis, `roles` será la función.
    if callable(roles):
        # roles no fue pasado, roles==function, devolvemos wrapper directo
        fn = roles
        allowed = None
        @wraps(fn)
        def wrapper_no_roles(*args, **kwargs):
            u = get_user_from_token()
            if not u:
                return jsonify({"ok": False, "error": "No autorizado"}), 401
            g.current_user = u
            g.user = u  # compatibilidad con código antiguo
            return fn(*args, **kwargs)
        return wrapper_no_roles

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            u = get_user_from_token()
            if not u:
                return jsonify({"ok": False, "auth": False, "error": "No autorizado"}), 401
            # attach user
            g.current_user = u
            g.user = u

            # role check
            if allowed:
                try:
                    user_role = (u.rol or u.role or '').strip()
                except Exception:
                    user_role = ''
                if user_role not in allowed:
                    return jsonify({"ok": False, "error": "Prohibido - rol de solo vista"}), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator

MUNICIPIOS_EDOMEX = [
    # 👇 pega aquí los 125 nombres oficiales exactamente como los muestras al usuario
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
    # ... (resto de municipios) ...
]
VALID_MUNICIPIOS_LOWER = {m.casefold(): m for m in MUNICIPIOS_EDOMEX}
# ===== Perillas de tiempo (ajústalas a tu operación) =====
DEFAULT_DURATION_MIN = 120   # duración lógica de cada evento (si no tienes hora_fin)
BUFFER_MIN           = 20    # colchón antes/después (traslados)
MIN_GAP_MIN          = 45    # separación mínima entre eventos (aunque no se traslapen)

def _as_dt(fecha, hora):
    if not fecha or not hora:
        return None
    return _dt.combine(fecha, hora)

def _rango(inv):
    """
    Construye (inicio, fin) usando fecha + hora + DEFAULT_DURATION_MIN.
    Si en el futuro agregas hora_fin, cámbialo aquí.
    """
    ini = _as_dt(inv.fecha, inv.hora)
    if not ini:
        return (None, None)
    fin = ini + timedelta(minutes=DEFAULT_DURATION_MIN)
    return (ini, fin)

def _traslapan_con_gap(a_ini, a_fin, b_ini, b_fin,
                       buffer_min=BUFFER_MIN, min_gap_min=MIN_GAP_MIN):
    """
    Regresa True si A y B chocan por:
      1) traslape considerando un buffer alrededor de ambos rangos, o
      2) aun sin traslape, la separación entre fin(A) e inicio(B) es < MIN_GAP_MIN.
    """
    if not a_ini or not a_fin or not b_ini or not b_fin:
        # Si faltan datos de tiempo, mejor bloquear (o retorna False si prefieres permitir)
        return True

    buf  = timedelta(minutes=buffer_min)
    gap  = timedelta(minutes=min_gap_min)

    # Expandimos por buffer
    a_ini_b, a_fin_b = a_ini - buf, a_fin + buf
    b_ini_b, b_fin_b = b_ini - buf, b_fin + buf

    # Caso 1: traslape con buffer
    traslape = not (a_fin_b <= b_ini_b or b_fin_b <= a_ini_b)
    if traslape:
        return True

    # Caso 2: exigir separación mínima real
    # Distancia de fin(A)->ini(B) y fin(B)->ini(A); tomamos la menor
    sep1 = (b_ini - a_fin) if b_ini >= a_fin else timedelta(days=999)
    sep2 = (a_ini - b_fin) if a_ini >= b_fin else timedelta(days=999)
    min_sep = sep1 if sep1 < sep2 else sep2

    return min_sep < gap
# =============================================================================
# Parseo/formatos
# =============================================================================
def parse_date_iso(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except Exception:
        return None

def parse_date_ddmmyyyy(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    m = re.match(r"^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s*$", s)
    if not m:
        return None
    d, mth, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000 if y < 70 else 1900
    try:
        return date(y, mth, d)
    except ValueError:
        return None

def parse_date_flexible(s: Optional[str]) -> Optional[date]:
    return parse_date_iso(s) or parse_date_ddmmyyyy(s)

def parse_time_flexible(v: Optional[str]) -> Optional[dtime]:
    if not v:
        return None
    v = v.strip().lower().replace(".", ":")
    m = re.match(r"^\s*(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)\s*$", v)
    if m:
        hh = int(m.group(1)); mm = int(m.group(2) or 0); ss = int(m.group(3) or 0)
        ampm = m.group(4)
        if hh == 12: hh = 0
        if ampm == "pm": hh += 12
        try: return dtime(hh, mm, ss)
        except ValueError: return None
    parts = v.split(":")
    try:
        if len(parts) == 2:
            return dtime(int(parts[0]), int(parts[1]))
        if len(parts) >= 3:
            return dtime(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None
    return None

def fmt_date(d: Optional[date]) -> str:
    return d.strftime("%d/%m/%y") if d else ""

def fmt_time(t: Optional[dtime]) -> str:
    return t.strftime("%H:%M") if t else ""

def fmt_dt(dtobj: Optional[datetime]) -> str:
    return dtobj.strftime("%d/%m/%y %H:%M") if dtobj else ""
#====================================ARCHIVOS=================================
# Raíz del proyecto
BASE_DIR = Path(__file__).resolve().parent

# En local: ./uploads ; en Render: /var/data/uploads (disco persistente)
UPLOAD_ROOT = Path(os.environ.get("UPLOAD_ROOT", BASE_DIR / "uploads")).resolve()
UPLOAD_INV_PATH = (UPLOAD_ROOT / "invitaciones")
UPLOAD_INV_PATH.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTS = {
    "pdf", "jpg", "jpeg", "png", "gif", "txt",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx"
}

app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB

def _allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTS

def save_invitation_file(file_storage, inv_id: str):
    """
    Guarda el archivo en: UPLOAD_ROOT/invitaciones/<inv_id>/<secure_filename>
    Devuelve metadatos y la ruta relativa (para guardar en archivo_url).
    """
    if not file_storage or not getattr(file_storage, "filename", ""):
        return None
    if not _allowed_file(file_storage.filename):
        raise ValueError("Extensión no permitida")

    fname = secure_filename(file_storage.filename)
    target_dir = UPLOAD_INV_PATH / inv_id
    target_dir.mkdir(parents=True, exist_ok=True)

    target_path = target_dir / fname
    file_storage.save(target_path)

    relpath = target_path.relative_to(UPLOAD_ROOT).as_posix()  # p.ej. "invitaciones/<id>/archivo.pdf"
    return {
        "nombre": file_storage.filename,
        "mime": file_storage.mimetype,
        "tamano": target_path.stat().st_size,
        "relpath": relpath,
    }
def _is_http_url(s: str) -> bool:
    """
    Devuelve True si la cadena comienza con http:// o https://
    """
    s = (s or "").strip().lower()
    return s.startswith("http://") or s.startswith("https://")


def delete_file_if_local(url_or_path: str):
    """
    Elimina un archivo físico si la URL/ruta apunta a tu carpeta local de uploads.
    Evita borrar rutas externas (http/https) o vacías.
    """
    if not url_or_path or _is_http_url(url_or_path):
        return

    # Normaliza y busca la ruta física dentro de tu carpeta de uploads
    full_path = os.path.join(os.getcwd(), url_or_path.strip("/"))
    if os.path.exists(full_path):
        try:
            os.remove(full_path)
            print(f"🗑️ Archivo eliminado: {full_path}")
        except Exception as e:
            print(f"⚠️ No se pudo eliminar el archivo {full_path}: {e}")
            
@app.route("/api/files/<path:filename>")
def serve_uploaded_file(filename):
    from flask import send_from_directory, abort
    try:
        return send_from_directory(UPLOAD_FOLDER, filename, as_attachment=False)
    except FileNotFoundError:
        abort(404)
# =============================================================================
# Bitácora / utilidades dominio
# =============================================================================
def add_notif(db, inv: Invitacion, campo: str, old_val: str, new_val: str, comentario: str = ""):
    n = Notificacion(
        invitacion_id=str(inv.id),
        evento=inv.evento or "",
        convoca=inv.convoca or "",
        estatus=inv.estatus or "",
        asignado_a_nombre=inv.asignado_a or "",
        rol=inv.rol or "",
        campo=campo or "",
        valor_anterior=old_val or "",
        valor_nuevo=new_val or "",
        comentario=comentario or "",

        fecha=inv.fecha,
        hora=inv.hora,
        municipio=inv.municipio or "",
        lugar=inv.lugar or "",
        convoca_cargo=inv.convoca_cargo or "",

        actor_nombre=(inv.actor.nombre if inv.actor else None),
        actor_cargo=(inv.actor.cargo if inv.actor else None),
        actor_tel=(inv.actor.telefono if inv.actor else None),
        actor_sexo=(inv.actor.sexo.nombre if (inv.actor and inv.actor.sexo) else None),
        actor_particular_nombre=(inv.actor.particular_nombre if inv.actor else None),
        actor_particular_cargo=(inv.actor.particular_cargo if inv.actor else None),
        actor_particular_tel=(inv.actor.particular_tel if inv.actor else None),

        persona_tel=(inv.persona.telefono if inv.persona else None),
        persona_sexo=(inv.persona.sexo.nombre if (inv.persona and inv.persona.sexo) else None),
        persona_particular_nombre=(inv.persona.particular_nombre if inv.persona else None),
        persona_particular_cargo=(inv.persona.particular_cargo if inv.persona else None),
        persona_particular_tel=(inv.persona.particular_tel if inv.persona else None),

        enviado=False,
        enviado_ts=None,
    )
    db.add(n)

def validar_partido(db, partido_nombre: str) -> str:
    if not partido_nombre:
        return ""
    p = (db.query(Partido)
            .filter(Partido.nombre == partido_nombre, Partido.activo == True)
            .first())
    if not p:
        raise ValueError("Partido no válido")
    return p.nombre

def inv_to_dict(inv: Invitacion) -> dict:
    dias = (inv.fecha - date.today()).days if inv.fecha else None
    asignado_nombre = (
        (inv.persona.nombre if inv.persona else None) or
        (inv.actor.nombre if inv.actor else None) or
        (inv.asignado_a or "")
    )
    return {
        "ID": inv.id,
        "PersonaID": inv.persona_id,
        "ActorID": inv.actor_id,

        "Evento": inv.evento or "",
        "Convoca Cargo": inv.convoca_cargo or "",
        "Convoca": inv.convoca or "",
        "Partido Político": inv.partido_politico or "",
        "Fecha": inv.fecha.isoformat() if inv.fecha else None,
        "Hora": inv.hora.strftime("%H:%M") if inv.hora else None,
        "FechaISO": inv.fecha.isoformat() if inv.fecha else None,
        "HoraISO": inv.hora.strftime("%H:%M") if inv.hora else None,
        "FechaFmt": fmt_date(inv.fecha),
        "HoraFmt": fmt_time(inv.hora),

        "Municipio/Dependencia": inv.municipio or "",
        "Lugar": inv.lugar or "",
        "Estatus": inv.estatus or "Pendiente",
        "Asignado A": asignado_nombre,
        "PersonaNombre": (inv.persona.nombre if inv.persona else None),
        "ActorNombre": (inv.actor.nombre if inv.actor else None),

        "Observaciones": inv.observaciones or "",
        "Fecha Asignación": fmt_dt(inv.fecha_asignacion),
        "Última Modificación": fmt_dt(inv.ultima_modificacion),
        "Modificado Por": inv.modificado_por or "",

        "ArchivoURL": inv.archivo_url or "",
        "ArchivoNombre": inv.archivo_nombre or "",
        "ArchivoMime": inv.archivo_mime or "",
        "ArchivoTamano": inv.archivo_tamano or 0,
        "ArchivoTS": fmt_dt(inv.archivo_ts),

        "DiasParaEvento": dias,
    }

# =============================================================================
# Rutas de páginas (Jinja)
# =============================================================================
@app.get("/")
def home():
    u = get_user_from_token()
    if not u:
        return redirect(url_for("login_page"))
    return render_template("index.html")

@app.get("/login")
def login_page():
    u = get_user_from_token()
    if u:
        return redirect(url_for("home"))
    return render_template("login.html")

# =============================================================================
# AUTH (token en cookie HttpOnly)
# =============================================================================
@app.post("/api/auth/login")
def api_login():
    data = request.get_json() or {}
    user = (data.get("usuario") or "").strip()
    pwd  = (data.get("password") or "").strip()
    if not user or not pwd:
        return jsonify({"ok": False, "error": "Falta usuario o contraseña"}), 400

    db = SessionLocal()
    try:
        u = (db.query(Usuario)
                .filter(Usuario.usuario == user, Usuario.activo == True)
                .first())
        if not u or not bcrypt.verify(pwd, u.pwd_hash):
            return jsonify({"ok": False, "error": "Credenciales inválidas"}), 401

        token = make_token({"uid": u.id, "usr": u.usuario, "rol": u.rol})
        resp = make_response(jsonify({"ok": True, "usuario": u.usuario, "rol": u.rol}))
        resp.set_cookie(
            COOKIE_NAME, token,
            max_age=TOKEN_TTL_HOURS*3600,
            httponly=True,
            samesite="Lax",
            secure=COOKIE_SECURE,
            path="/"
        )
        return resp
    finally:
        db.close()

@app.post("/api/auth/logout")
def api_logout():
    resp = make_response(jsonify({"ok": True}))
    resp.set_cookie(COOKIE_NAME, "", expires=0, path="/")
    return resp

@app.get("/api/auth/me")
def api_me():
    u = get_user_from_token()
    if not u:
        return jsonify({"ok": False, "auth": False}), 200
    return jsonify({"ok": True, "auth": True, "id": u.id, "usuario": u.usuario, "rol": u.rol})

# =============================================================================
# Catálogos
# =============================================================================
@app.get("/api/partidos")
@auth_required(['admin'])
def api_partidos():
    db = SessionLocal()
    try:
        q = db.query(Partido)
        # En tu modelo Partido no existe 'activo' → no filtramos por ello
        rows = q.order_by(Partido.nombre.asc()).all()
        return jsonify([{"nombre": (r.nombre or "")} for r in rows])
    finally:
        db.close()

@app.get("/api/catalogo/sexo")
@auth_required(['admin'])
def api_catalogo_sexo():
    db = SessionLocal()
    try:
        rows = db.query(Sexo).order_by(Sexo.nombre.asc()).all()
        return jsonify([{"id": s.id, "nombre": s.nombre} for s in rows])
    finally:
        db.close()

# =============================================================================
# Personas
# =============================================================================
@app.get("/api/invitaciones/by_persona")
@auth_required(['admin','viewer'])
def api_invitaciones_by_persona():
    """
    Parámetros (query):
      - persona_id (obligatorio)
      - desde (YYYY-MM-DD) opcional
      - hasta (YYYY-MM-DD) opcional
      - estatus (opcional; p.ej. Confirmado, Sustituido, Pendiente, Cancelado)
    Respuesta: lista de dicts con columnas para la tabla del panel.
    """
    from datetime import datetime as dt, date as ddate

    def _parse_date(s):
        s = (s or "").strip()
        if not s:
            return None
        return dt.strptime(s, "%Y-%m-%d").date()

    persona_id = (request.args.get("persona_id") or "").strip()
    if not persona_id.isdigit():
        return jsonify({"ok": False, "error": "persona_id inválido"}), 400

    desde = _parse_date(request.args.get("desde"))
    hasta = _parse_date(request.args.get("hasta"))
    estatus = (request.args.get("estatus") or "").strip()

    db = SessionLocal()
    try:
        q = db.query(Invitacion).filter(Invitacion.persona_id == int(persona_id))

        if desde:
            q = q.filter(Invitacion.fecha >= desde)
        if hasta:
            q = q.filter(Invitacion.fecha <= hasta)
        if estatus:
            q = q.filter(Invitacion.estatus == estatus)

        rows = q.order_by(Invitacion.fecha.asc(), Invitacion.hora.asc(), Invitacion.id.asc()).all()

        out = []
        for inv in rows:
            # Formatos amigables
            fecha_txt = inv.fecha.strftime("%Y-%m-%d") if inv.fecha else ""
            fecha_tabla = inv.fecha.strftime("%d/%m/%y") if inv.fecha else ""
            hora_txt = inv.hora.strftime("%H:%M") if inv.hora else ""

            out.append({
                "ID": inv.id,
                "FechaISO": fecha_txt,
                "Fecha": fecha_tabla,
                "Hora": hora_txt,
                "Evento": inv.evento or "",
                "Municipio": inv.municipio or "",
                "Lugar": inv.lugar or "",
                "Convoca": inv.convoca or "",
                "ConvocaCargo": inv.convoca_cargo or "",
                "Rol": inv.rol or "",
                "Estatus": inv.estatus or "",
                "Partido": inv.partido_politico or "",
            })
        return jsonify(out)
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()
        
@app.get("/api/catalog")
@auth_required(['admin','viewer'])
def api_catalog():
    qtxt = (request.args.get("q") or "").strip().lower()
    db = SessionLocal()
    try:
        try:
            q = db.query(Persona)
            # Si tu modelo tiene 'activo', filtra; si no, no pasa nada
            try:
                _ = Persona.activo
                q = q.filter(Persona.activo == True)
            except Exception:
                pass

            try:
                q = q.order_by(Persona.nombre.asc())
            except Exception:
                pass

            personas = q.all()
        except (OperationalError, ProgrammingError) as e:
            # Tabla 'personas' no existe o aún no migraste → lista vacía
            db.rollback()
            personas = []

        out = []
        for p in personas:
            # Lee atributos de forma segura
            nombre = getattr(p, "nombre", "") or ""
            cargo  = getattr(p, "cargo", "") or ""
            tel    = getattr(p, "telefono", "") or ""
            correo = getattr(p, "correo", "") or ""
            unidad = getattr(p, "unidad_region", "") or ""

            if qtxt:
                blob = f"{nombre} {cargo} {tel} {correo} {unidad}".lower()
                if qtxt not in blob:
                    continue

            out.append({
                "ID": getattr(p, "id", None),
                "Nombre": nombre,
                "Cargo": cargo,
                "Teléfono": tel,
                "Correo": correo,
                "Unidad/Región": unidad,
                "SexoID": getattr(p, "sexo_id", None),
                "ParticularNombre": getattr(p, "particular_nombre", None),
                "ParticularCargo": getattr(p, "particular_cargo", None),
                "ParticularTel": getattr(p, "particular_tel", None),
            })
        return jsonify(out)
    finally:
        db.close()

@app.get("/api/personas")
@auth_required(['admin','viewer'])   # cambia a ['admin'] si quieres permitir solo admin
def api_personas():
    db = SessionLocal()
    try:
        # Intentamos usar joinedload si la relación Persona.region está definida en tu modelo
        try:
            rows = db.query(Persona).options(joinedload(Persona.region)).order_by(Persona.nombre.asc()).all()
        except Exception:
            # Si no existe la relación, fallback a consulta sin joinedload
            rows = db.query(Persona).order_by(Persona.nombre.asc()).all()

        out = []
        for p in rows:
            # obtener region_id directo
            region_id = getattr(p, 'region_id', None)

            # intentar obtener nombre de region desde relación si existe
            region_nombre = None
            try:
                if getattr(p, 'region', None):
                    region_nombre = getattr(p.region, 'nombre', None)
            except Exception:
                region_nombre = None

            out.append({
                "ID": p.id,
                "Nombre": p.nombre or "",
                "Cargo": p.cargo or "",
                "Teléfono": p.telefono or "",
                "Correo": p.correo or "",
                "Unidad/Región": p.unidad_region or "",
                "SexoID": p.sexo_id,
                "ParticularNombre": p.particular_nombre or "",
                "ParticularCargo":  p.particular_cargo  or "",
                "ParticularTel":    p.particular_tel    or "",
                "Activo": bool(p.activo),
                # campos nuevos para frontend
                "RegionID": region_id,
                "RegionNombre": region_nombre
            })
        return jsonify(out)
    finally:
        db.close()

@app.post("/api/person/create")
@auth_required(['admin'])
def api_person_create():
    data = request.get_json() or {}

    nombre = (data.get("Nombre") or "").strip()
    cargo  = (data.get("Cargo") or "").strip()
    if not nombre or not cargo:
        return jsonify({"ok": False, "error": "Nombre y Cargo son obligatorios"}), 400

    # Sanea teléfonos (solo dígitos)
    def _digits(s):
        return "".join(ch for ch in (s or "") if ch.isdigit())

    telefono     = _digits(data.get("Teléfono") or data.get("Telefono"))
    particular_t = _digits(data.get("ParticularTel"))
    
    # Región (opcional)
    region_raw = data.get("RegionID")
    region_id = int(region_raw) if str(region_raw).isdigit() else None

    db = SessionLocal()
    try:
        p = Persona(
            nombre=nombre,
            cargo=cargo,
            telefono=telefono,
            correo=(data.get("Correo") or "").strip(),
            unidad_region=(data.get("Unidad/Región") or "").strip(),
            sexo_id=data.get("SexoID"),
            particular_nombre=(data.get("ParticularNombre") or "").strip(),
            particular_cargo=(data.get("ParticularCargo") or "").strip(),
            particular_tel=particular_t,
            region_id=region_id,  # ← NUEVO
            activo=True
        )
        db.add(p)
        db.commit()
        return jsonify({"ok": True, "id": p.id})
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()

@app.post("/api/person/update")
@auth_required(['admin'])
def api_person_update():
    import re
    data = request.get_json() or {}
    pid = data.get("ID")
    if not pid:
        return jsonify({"ok": False, "error": "Falta ID"}), 400

    def digits(s: str) -> str:
        return re.sub(r"\D+", "", s or "")

    db = SessionLocal()
    try:
        p = db.get(Persona, int(pid))
        if not p:
            return jsonify({"ok": False, "error": "Persona no encontrada"}), 404

        # Campos básicos
        nombre = (data.get("Nombre") or "").strip()
        cargo  = (data.get("Cargo")  or "").strip()
        if not nombre or not cargo:
            return jsonify({"ok": False, "error": "Nombre y Cargo son obligatorios"}), 400
        p.nombre = nombre
        p.cargo  = cargo

        # Opcionales
        p.telefono       = digits(data.get("Teléfono") or data.get("Telefono"))
        p.correo         = (data.get("Correo") or "").strip()
        p.unidad_region  = (data.get("Unidad/Región") or data.get("Unidad") or "").strip()

        sexo_val = data.get("SexoID")
        p.sexo_id = int(sexo_val) if str(sexo_val).strip().isdigit() else None

        p.particular_nombre = (data.get("ParticularNombre") or "").strip()
        p.particular_cargo  = (data.get("ParticularCargo")  or "").strip()
        p.particular_tel    = digits(data.get("ParticularTel") or "")
        
        # Región opcional
        reg_raw = data.get("RegionID")
        p.region_id = int(reg_raw) if str(reg_raw).isdigit() else None

        # Activo (checkbox)
        if "Activo" in data:
            p.activo = bool(data.get("Activo"))

        db.commit()
        return jsonify({"ok": True, "id": p.id})
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()

@app.post("/api/person/delete")
@auth_required(['admin'])
def api_person_delete():
    data = request.get_json() or {}
    pid  = data.get("ID") or data.get("id")
    if not pid:
        return jsonify({"ok": False, "error": "Falta ID"}), 400

    db = SessionLocal()
    try:
        p = db.get(Persona, int(pid))
        if not p:
            return jsonify({"ok": False, "error": "Persona no encontrada"}), 404

        # 1) Poner en 'Pendiente' todas las invitaciones donde estaba asignada la persona
        from datetime import datetime
        invs = db.query(Invitacion).filter(Invitacion.persona_id == p.id).all()
        for inv in invs:
            # Guarda valores anteriores (para notificaciones / auditoría, si ya usas add_notif)
            prev_asignado = inv.asignado_a or ""
            prev_rol      = inv.rol or ""
            prev_status   = inv.estatus or ""

            inv.persona_id = None
            inv.asignado_a = None
            inv.rol        = None
            inv.estatus    = "Pendiente"
            inv.fecha_asignacion = None
            inv.ultima_modificacion = datetime.utcnow()
            inv.modificado_por = getattr(getattr(g, "user", None), "usuario", "atiapp")

            # Opcional: registra cambios si ya usas add_notif
            try:
                add_notif(db, inv, "Asignado A", prev_asignado, "")
                add_notif(db, inv, "Rol", prev_rol, "")
                if prev_status != "Pendiente":
                    add_notif(db, inv, "Estatus", prev_status, "Pendiente")
            except Exception:
                pass

        # 2) Borrar o desactivar la persona
        # 2a) Borrado duro:
        db.delete(p)
        # 2b) (alternativa recomendada) "Soft delete":
        # p.activo = False
        # db.add(p)

        db.commit()
        return jsonify({"ok": True, "invitaciones_actualizadas": len(invs)})
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()
        
# Lista de regiones (para poblar #regRegion)
@app.get("/api/regiones")
@auth_required(['admin','viewer'])
def api_regiones_list():
    db = SessionLocal()
    try:
        rows = db.query(Region).order_by(Region.nombre.asc()).all()
        out = [{"id": r.id, "nombre": r.nombre, "slug": r.slug, "color": r.color} for r in rows]
        return jsonify(out)
    finally:
        db.close()

# Personas por region_id
@app.get("/api/regiones/<int:region_id>/personas")
@auth_required(['admin','viewer'])
def api_regiones_personas(region_id):
    db = SessionLocal()
    try:
        q = db.query(Persona).filter(Persona.region_id == region_id)
        try:
            _ = Persona.activo
            q = q.filter(Persona.activo == True)
        except Exception:
            pass
        personas = q.order_by(Persona.nombre.asc()).all()
        out = []
        for p in personas:
            out.append({
                "ID": p.id,
                "Nombre": p.nombre or "",
                "Cargo": p.cargo or "",
                "Telefono": p.telefono or "",
                "Correo": p.correo or "",
                "Unidad/Region": p.unidad_region or "",
                "RegionID": p.region_id,
                "ParticularNombre": p.particular_nombre or "",
                "ParticularCargo": p.particular_cargo or "",
                "ParticularTel": p.particular_tel or "",
            })
        return jsonify({"ok": True, "region_id": region_id, "personas": out})
    finally:
        db.close()



# ---- Region: todos los municipios (cache cliente) ----
@app.get("/api/region_municipios_all")
@auth_required(['admin','viewer'])
def api_region_municipios_all():
    db = SessionLocal()
    try:
        # devuelve regiones y la tabla region_municipios
        regs = db.query(Region).order_by(Region.id.asc()).all()  # ajustar modelo: Regione/Region/Regiones
        # use the real model name, e.g. Regiones or Region
        regiones_out = [{"id": r.id, "nombre": r.nombre, "slug": getattr(r, "slug", None), "color": getattr(r, "color", None)} for r in regs]

        rms = db.query(RegionMunicipio).order_by(RegionMunicipio.region_id.asc(), RegionMunicipio.municipio.asc()).all()
        rm_out = [{"id": r.id, "region_id": r.region_id, "municipio": r.municipio} for r in rms]

        # build mapping municipio_normalizado -> region_id (cliente-friendly)
        muni_map = {}
        for r in rm_out:
            key = " ".join(str(r["municipio"]).split()).casefold()
            muni_map[key] = r["region_id"]

        return jsonify({"ok": True, "regiones": regiones_out, "region_municipios": rm_out, "muni_to_region": muni_map})
    finally:
        db.close()
        
def _normalize_muni_key(s: str) -> str:
    """Normalize: strip, collapse spaces, remove diacritics, casefold."""
    if not s:
        return ""
    t = " ".join(str(s).split())        # collapse whitespace
    try:
        t = unicodedata.normalize("NFD", t)
        t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
    except Exception:
        pass
    return t.casefold()

@app.get("/api/personas/recomendadas")
@auth_required(['admin','viewer'])
def api_personas_recomendadas():
    """
    GET /api/personas/recomendadas?municipio=Aculco

    Respuesta:
      { ok: True, municipio: "<canon>", region_ids: [1,2], personas: [ {ID,Nombre,Cargo,Telefono,...}, ... ] }
    """
    muni_raw = (request.args.get("municipio") or "").strip()
    if not muni_raw:
        return jsonify({"ok": False, "error": "Falta municipio"}), 400

    # Normaliza entrada
    muni_key = _normalize_muni_key(muni_raw)

    db = SessionLocal()
    try:
        # 1) Buscar filas de region_municipios que coincidan (comparando normalizado)
        #    Para evitar depender de cómo se guardó en BD, traemos todas y comparamos aquí.
        #    Si prefieres hacerlo sólo con SQL, asegúrate de almacenar una columna normalizada previo.
        all_rm = db.query(RegionMunicipio).all()
        matched_region_ids = []
        for rm in all_rm:
            rm_key = _normalize_muni_key(rm.municipio or "")
            if rm_key and rm_key == muni_key:
                matched_region_ids.append(rm.region_id)

        matched_region_ids = list(dict.fromkeys(matched_region_ids))  # unique, keep order

        if not matched_region_ids:
            # No hay región configurada para ese municipio
            return jsonify({"ok": True, "municipio": muni_raw, "region_ids": [], "personas": []})

        # 2) Obtener personas activas de esas regiones
        q = db.query(Persona).filter(Persona.region_id.in_(matched_region_ids))
        try:
            # Si tu modelo tiene columna 'activo', aplicarla
            _ = Persona.activo
            q = q.filter(Persona.activo == True)
        except Exception:
            pass

        q = q.order_by(Persona.nombre.asc())
        personas = q.all()

        out = []
        for p in personas:
            out.append({
                "ID": p.id,
                "Nombre": p.nombre or "",
                "Cargo": p.cargo or "",
                "Telefono": p.telefono or "",
                "Correo": p.correo or "",
                "Unidad/Region": p.unidad_region or "",
                "RegionID": p.region_id,
                "RegionNombre": getattr(p.region, "nombre", None) if getattr(p, "region", None) else None,
                "SexoID": p.sexo_id,
                "ParticularNombre": p.particular_nombre or "",
                "ParticularCargo": p.particular_cargo or "",
                "ParticularTel": p.particular_tel or "",
            })

        return jsonify({
            "ok": True,
            "municipio": muni_raw,
            "region_ids": matched_region_ids,
            "personas": out
        })
    finally:
        db.close()
# =============================================================================
# Actores
# =============================================================================
@app.get("/api/actores")
@auth_required(['admin'])
def api_actores_list():
    q = (request.args.get("q") or "").strip().lower()
    db = SessionLocal()
    try:
        rows = (db.query(Actor)
                  .filter(Actor.activo == True)
                  .order_by(Actor.nombre.asc())
                  .all())
        out = []
        for a in rows:
            if q:
                txt = f"{a.nombre} {a.cargo or ''} {a.telefono or ''}".lower()
                if q not in txt:
                    continue
            out.append({
                "ID": a.id,
                "Nombre": a.nombre or "",
                "Cargo": a.cargo or "",
                "Teléfono": a.telefono or "",
                "SexoID": a.sexo_id,
                "ParticularNombre": a.particular_nombre,
                "ParticularCargo": a.particular_cargo,
                "ParticularTel": a.particular_tel,
            })
        return jsonify(out)
    finally:
        db.close()

@app.post("/api/actor/create")
@auth_required(['admin'])
def api_actor_create():
    data = request.get_json() or {}
    nombre = (data.get("Nombre") or "").strip()
    cargo  = (data.get("Cargo") or "").strip()
    if not nombre:
        return jsonify({"ok": False, "error": "Nombre es obligatorio"}), 400

    db = SessionLocal()
    try:
        a = Actor(
            nombre=nombre,
            cargo=cargo,
            telefono=(data.get("Teléfono") or "").strip(),
            sexo_id=data.get("SexoID"),
            particular_nombre=data.get("ParticularNombre"),
            particular_cargo=data.get("ParticularCargo"),
            particular_tel=data.get("ParticularTel"),
            activo=True
        )
        db.add(a)
        db.commit()
        return jsonify({"ok": True, "id": a.id})
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()

@app.post("/api/actor/update")
@auth_required(['admin'])
def api_actor_update():
    data = request.get_json() or {}
    actor_id = data.get("id")

    if not actor_id:
        return jsonify({"ok": False, "error": "Falta el id del actor"}), 400

    db = SessionLocal()
    try:
        a = db.get(Actor, actor_id)
        if not a:
            return jsonify({"ok": False, "error": "Actor no encontrado"}), 404

        # Actualiza solo si vienen datos
        if "Nombre" in data: a.nombre = (data["Nombre"] or "").strip()
        if "Cargo" in data: a.cargo = (data["Cargo"] or "").strip()
        if "Teléfono" in data: a.telefono = (data["Teléfono"] or "").strip()
        if "SexoID" in data: a.sexo_id = data["SexoID"]
        if "ParticularNombre" in data: a.particular_nombre = (data["ParticularNombre"] or "").strip()
        if "ParticularCargo" in data: a.particular_cargo = (data["ParticularCargo"] or "").strip()
        if "ParticularTel" in data: a.particular_tel = (data["ParticularTel"] or "").strip()

        db.commit()
        return jsonify({"ok": True, "id": a.id})
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()

# ===== Eliminar actor (bloqueado si tiene invitaciones) =====
@app.delete("/api/actor/delete/<int:actor_id>")
@auth_required(['admin'])
def api_actor_delete(actor_id: int):
    db = SessionLocal()
    try:
        a = db.get(Actor, actor_id)
        if not a:
            return jsonify({"ok": False, "error": "Actor no encontrado"}), 404

        # Cuenta invitaciones que referencian al actor
        count = db.query(Invitacion).filter(Invitacion.actor_id == actor_id).count()
        if count > 0:
            # Opcional: listar algunas (para debug/UX)
            sample = (db.query(Invitacion.id, Invitacion.fecha, Invitacion.evento)
                        .filter(Invitacion.actor_id == actor_id)
                        .order_by(Invitacion.fecha.desc())
                        .limit(5).all())
            return jsonify({
                "ok": False,
                "error": f"No se puede eliminar. El actor está asignado a {count} invitacion(es). "
                         f"Elimina o reasigna esas invitaciones primero.",
                "count": count,
                "sample": [{"id": r.id, "fecha": str(r.fecha), "evento": r.evento} for r in sample]
            }), 409

        # Si quieres borrado lógico en vez de delete físico:
        # a.activo = False
        # db.commit()
        # return jsonify({"ok": True, "soft_delete": True})

        db.delete(a)
        db.commit()
        return jsonify({"ok": True})
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()

# =============================================================================
# Invitaciones
# =============================================================================
@app.get("/api/invitations")
@auth_required(['admin','viewer'])
def api_invitations_list():
    db = SessionLocal()
    try:
        q = db.query(Invitacion).options(
            joinedload(Invitacion.actor),
            joinedload(Invitacion.persona)
        )

        # Filtros (opcionales)
        estatus = (request.args.get("estatus") or "").strip()
        if estatus:
            q = q.filter(Invitacion.estatus == estatus)

        # Fechas (YYYY-MM-DD)
        desde = (request.args.get("desde") or "").strip()
        hasta = (request.args.get("hasta") or "").strip()
        from datetime import datetime
        if desde:
            try:
                d = datetime.strptime(desde, "%Y-%m-%d").date()
                q = q.filter(Invitacion.fecha >= d)
            except:
                pass
        if hasta:
            try:
                h = datetime.strptime(hasta, "%Y-%m-%d").date()
                q = q.filter(Invitacion.fecha <= h)
            except:
                pass

        municipio = (request.args.get("municipio") or "").strip()
        if municipio:
            q = q.filter(Invitacion.municipio.ilike(f"%{municipio}%"))

        # Búsqueda libre (evento / lugar / convoca)
        term = (request.args.get("q") or "").strip()
        if term:
            like = f"%{term}%"
            q = q.filter(
                or_(
                    Invitacion.evento.ilike(like),
                    Invitacion.lugar.ilike(like),
                    Invitacion.convoca.ilike(like),
                    Invitacion.partido_politico.ilike(like),
                    Invitacion.municipio.ilike(like),
                )
            )

        q = q.order_by(Invitacion.fecha.desc(), Invitacion.hora.desc())

        rows = []
        for inv in q.all():
            actor = inv.actor
            persona = inv.persona
            rows.append({
                "ID": inv.id,
                "Fecha": inv.fecha.isoformat() if inv.fecha else None,
                "Hora": inv.hora.strftime("%H:%M") if inv.hora else None,
                "Evento": inv.evento,
                "ConvocaCargo": inv.convoca_cargo,           # 👈 AÑADE ESTO
                "Convoca": inv.convoca,
                "Partido": inv.partido_politico,
                "Municipio": inv.municipio,
                "Lugar": inv.lugar,
                "Estatus": inv.estatus,
                "Observaciones": inv.observaciones,

                "ActorID": actor.id if actor else None,
                "ActorNombre": getattr(actor, "nombre", None) if actor else None,
                "ActorCargo": getattr(actor, "cargo", None) if actor else None,

                "PersonaID": persona.id if persona else None,
                "PersonaNombre": getattr(persona, "nombre", None) if persona else None,
                "PersonaCargo": getattr(persona, "cargo", None) if persona else None,

                "ArchivoNombre": inv.archivo_nombre,
                "ArchivoMime": inv.archivo_mime,
                "ArchivoTamano": inv.archivo_tamano,
                "ArchivoURL": inv.archivo_url,  # si lo usas
                    # ⬇️ nuevos
                "GrupoToken": inv.grupo_token or "",
                "SubTipo": inv.sub_tipo or "",
                
            })
        return jsonify(rows)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


def inv_to_dict(inv):
    from datetime import date as _date
    def safe_date(d): 
        try: return d.isoformat()
        except: return None
    def safe_time(t): 
        try: return t.strftime("%H:%M")
        except: return None
    def safe_fmt_dt(dt): 
        try: return fmt_dt(dt)
        except: return ""

    dias = None
    try:
        if isinstance(getattr(inv, "fecha", None), _date):
            dias = (inv.fecha - _date.today()).days
    except: 
        dias = None

    try: persona_nombre = inv.persona.nombre if getattr(inv, "persona", None) else None
    except: persona_nombre = None
    try: actor_nombre = inv.actor.nombre if getattr(inv, "actor", None) else None
    except: actor_nombre = None

    asignado_nombre = (persona_nombre or actor_nombre or (getattr(inv, "asignado_a", "") or ""))

    return {
        "ID": getattr(inv, "id", None),
        "PersonaID": getattr(inv, "persona_id", None),
        "ActorID": getattr(inv, "actor_id", None),

        "Evento": getattr(inv, "evento", "") or "",
        "Convoca Cargo": getattr(inv, "convoca_cargo", "") or "",
        "Convoca": getattr(inv, "convoca", "") or "",
        "Partido Político": getattr(inv, "partido_politico", "") or "",

        "Fecha": safe_date(getattr(inv, "fecha", None)),
        "Hora": safe_time(getattr(inv, "hora", None)),
        "FechaISO": safe_date(getattr(inv, "fecha", None)),
        "HoraISO": safe_time(getattr(inv, "hora", None)),
        "FechaFmt": (getattr(inv, "fecha", None).strftime("%d/%m/%y") if getattr(inv, "fecha", None) else ""),
        "HoraFmt": (getattr(inv, "hora", None).strftime("%H:%M") if getattr(inv, "hora", None) else ""),

        "Municipio/Dependencia": getattr(inv, "municipio", "") or "",
        "Lugar": getattr(inv, "lugar", "") or "",
        "Estatus": getattr(inv, "estatus", None) or "Pendiente",
        "Asignado A": asignado_nombre,
        "PersonaNombre": persona_nombre,
        "ActorNombre": actor_nombre,

        "Observaciones": getattr(inv, "observaciones", "") or "",
        "Fecha Asignación": safe_fmt_dt(getattr(inv, "fecha_asignacion", None)),
        "Última Modificación": safe_fmt_dt(getattr(inv, "ultima_modificacion", None)),
        "Modificado Por": getattr(inv, "modificado_por", "") or "",

        "ArchivoURL": getattr(inv, "archivo_url", "") or "",
        "ArchivoNombre": getattr(inv, "archivo_nombre", "") or "",
        "ArchivoMime": getattr(inv, "archivo_mime", "") or "",
        "ArchivoTamano": getattr(inv, "archivo_tamano", 0) or 0,
        "ArchivoTS": safe_fmt_dt(getattr(inv, "archivo_ts", None)),

        "DiasParaEvento": dias,
    }

UPLOAD_FOLDER = os.getenv(
    "UPLOAD_FOLDER",
    os.path.join(os.path.dirname(__file__), "uploads")
)
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
ALLOWED_EXTS = {"pdf", "jpg", "jpeg", "png"}
def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTS

# ---- Crear invitación (solo actor_id obligatorio en tu flujo actual) ----
@app.post("/api/invitation/create")
@auth_required(['admin'])
def api_invitation_create():
    db = SessionLocal()
    try:
        f = request.form
        files = request.files

        actor_id = (f.get("actor_id") or "").strip()
        if not actor_id:
            return jsonify({"ok": False, "error": "actor_id es obligatorio"}), 400

        # NOT NULL
        fecha   = (f.get("fecha") or "").strip()
        hora    = (f.get("hora") or "").strip()
        evento  = (f.get("evento") or "").strip()
        cargo   = (f.get("convoca_cargo") or "").strip()
        partido = (f.get("partido_politico") or "").strip()
        muni_in = (f.get("municipio") or "").strip()   # <- entrada cruda
        lugar   = (f.get("lugar") or "").strip()
        obs     = (f.get("observaciones") or "").strip()
        grupo_token = (f.get("grupo_token") or "").strip()
        sub_tipo    = (f.get("sub_tipo") or "").strip()  # 'pre'/'publico'/'mixto'
        req = {"fecha": fecha, "hora": hora, "evento": evento,
               "convoca_cargo": cargo, "partido_politico": partido,
               "municipio": muni_in, "lugar": lugar}
        faltan = [k for k,v in req.items() if not v]
        if faltan:
            return jsonify({"ok": False, "error": f"Faltan campos obligatorios: {', '.join(faltan)}"}), 400

        # === VALIDACIÓN DE MUNICIPIO (case-insensitive, normalizado) ===
        muni_key = " ".join(muni_in.split()).casefold()   # colapsa espacios y baja a minúsculas
        muni_can = VALID_MUNICIPIOS_LOWER.get(muni_key)
        if not muni_can:
            return jsonify({"ok": False, "error": f"Municipio inválido: '{muni_in}'"}), 400
        # usa siempre el nombre canónico:
        muni = muni_can

        # parse
        def _parse_date(s): return datetime.strptime(s, "%Y-%m-%d").date()
        def _parse_time(s):
            for fmt in ("%H:%M", "%H:%M:%S"):
                try: return datetime.strptime(s, fmt).time()
                except: pass
            raise ValueError("Hora inválida")
        fecha_dt = _parse_date(fecha)
        hora_dt  = _parse_time(hora)

        # Actor → convoca
        actor = db.query(Actor).get(int(actor_id))
        if not actor:
            return jsonify({"ok": False, "error": "Actor no encontrado"}), 404
        convoca_txt = (actor.nombre or "").strip()
        if not convoca_txt:
            return jsonify({"ok": False, "error": "El actor no tiene nombre para 'convoca'"}), 400

        inv_id = uuid4().hex
        inv = Invitacion(
            id=inv_id,
            fecha=fecha_dt, hora=hora_dt, evento=evento,
            convoca_cargo=cargo, convoca=convoca_txt,
            partido_politico=partido,
            municipio=muni,                      # <- nombre canónico validado
            lugar=lugar,
            estatus="Pendiente",
            observaciones=obs,
            fecha_asignacion=None,
            ultima_modificacion=datetime.utcnow(),
            modificado_por=getattr(g, "user", None).usuario if getattr(g, "user", None) else None,
            actor_id=int(actor_id),
            grupo_token=grupo_token,
            sub_tipo=sub_tipo,
    # ...
        )
        db.add(inv)
        db.flush()

        # archivo (opcional)
        up = files.get("archivo")
        if up and getattr(up, "filename", ""):
            meta = save_invitation_file(up, inv_id)
            inv.archivo_nombre = meta["nombre"]
            inv.archivo_mime   = meta["mime"]
            inv.archivo_tamano = meta["tamano"]
            inv.archivo_ts     = datetime.utcnow()
            inv.archivo_url    = meta["relpath"]

        db.commit()
        return jsonify({"ok": True, "id": inv.id})

    except ValueError as ve:
        db.rollback();  return jsonify({"ok": False, "error": str(ve)}), 400
    except Exception as e:
        db.rollback();  return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()


@app.get("/api/invitation/<id>/archivo")
@auth_required(['admin','viewer'])
def api_invitation_get_file(id):
    db = SessionLocal()
    try:
        inv = db.get(Invitacion, id)
        if not inv:
            abort(404)

        path_or_url = (inv.archivo_url or "").strip()
        if not path_or_url:
            abort(404)

        # Si es URL absoluta (http/https), reenvía:
        if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
            return redirect(path_or_url, code=302)

        # Si es ruta relativa almacenada (nuestro flujo local)
        return send_from_directory(
            directory=str(UPLOAD_ROOT),
            path=path_or_url,                        # p.ej. "invitaciones/<id>/x.pdf"
            as_attachment=False,
            download_name=(inv.archivo_nombre or "archivo"),
            mimetype=(inv.archivo_mime or None)
        )
    finally:
        db.close()
        
# Endpoint: Editar invitación
@app.post("/api/invitation/update")
@auth_required(['admin'])
def api_invitation_update():
    from datetime import datetime as dt, date
    import unicodedata
    from datetime import datetime as dt

    def _parse_date_flex(s):
        s = (s or "").strip()
        if not s:
            return None
        return dt.strptime(s, "%Y-%m-%d").date()

    def _parse_time_flex(s):
        s = (s or "").strip()
        if not s:
            return None
        for fmt in ("%H:%M", "%H:%M:%S"):
            try:
                return dt.strptime(s, fmt).time()
            except Exception:
                pass
        raise ValueError("Hora inválida (usa HH:MM)")
        # Normaliza (quita acentos/diacríticos) y pasa a minúsculas para comparar
    def _norm(s: str) -> str:
        s = (s or "").strip()
        s = unicodedata.normalize("NFD", s)
        s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
        return s.casefold()
    
        # Mapa {normalizado: canónico}
    _MUNI_MAP = {_norm(m): m for m in MUNICIPIOS_EDOMEX}
    inv_id = (request.form.get("id") or request.form.get("ID") or "").strip()
    if not inv_id:
        return jsonify({"ok": False, "error": "Falta ID"}), 400

    db = SessionLocal()
    try:
        inv = db.get(Invitacion, inv_id)
        if not inv:
            return jsonify({"ok": False, "error": "Invitación no encontrada"}), 404

        # ============ SNAPSHOT PREVIO ============
        prev = {
            "fecha": inv.fecha, "hora": inv.hora, "evento": inv.evento,
            "convoca_cargo": inv.convoca_cargo, "partido_politico": inv.partido_politico,
            "municipio": inv.municipio, "lugar": inv.lugar, "observaciones": inv.observaciones,
            "archivo_url": inv.archivo_url
        }

        # Helper: emite una única notificación "Reprogramado" con antes→ahora
        def emit_repro(label, before, after):
            """
            label: 'Fecha', 'Hora', 'Municipio' o 'Lugar'
            before/after: valores previos/nuevos (str o date/time)
            """
            # Normaliza a texto
            def _fmt(v):
                if hasattr(v, "strftime"):  # date/time
                    return v.strftime("%d/%m/%y") if isinstance(v, date) else v.strftime("%H:%M")
                return (v or "").strip()

            antes = f"{label}: {_fmt(before) or '-'}"
            ahora = f"{label}: {_fmt(after) or '-'}"

            # Trae objetos actualizados de persona/actor para teléfonos del snapshot
            persona_obj = db.get(Persona, inv.persona_id) if inv.persona_id else None
            actor_obj   = db.get(Actor,   inv.actor_id)   if inv.actor_id   else None

            # Usa tu helper que “congela” snapshot
            add_notif_for(
                db, inv,
                campo="Reprogramado",
                valor_anterior=antes,
                valor_nuevo=ahora,
                comentario=None,
                persona_obj=persona_obj,   # <- INCLUYE PERSONA
                actor_obj=actor_obj,       # <- E INCLUYE ACTOR
                estatus_override=inv.estatus or "Confirmado"
            )

        # ============ CAMPOS EDITABLES ============
        f = request.form
        f_fecha   = f.get("fecha")
        f_hora    = f.get("hora")
        f_evento  = f.get("evento")
        f_ccargo  = f.get("convoca_cargo")
        f_partido = f.get("partido_politico")
        f_muni    = f.get("municipio")
        f_lugar   = f.get("lugar")
        f_obs     = f.get("observaciones")
        f_del     = (f.get("eliminar_archivo") or "").strip().lower() in {"1","true","si","sí"}

        # Cambios sensibles a reprogramación
        if f_fecha is not None:
            nueva_fecha = _parse_date_flex(f_fecha)
            if prev["fecha"] != nueva_fecha:
                inv.fecha = nueva_fecha
                emit_repro("Fecha", prev["fecha"], nueva_fecha)

        if f_hora is not None:
            nueva_hora = _parse_time_flex(f_hora)
            if prev["hora"] != nueva_hora:
                inv.hora = nueva_hora
                emit_repro("Hora", prev["hora"], nueva_hora)
                
        if f_muni is not None:
            # VALIDACIÓN: municipio debe existir en la lista blanca
            muni_in = (f_muni or "").strip()
            if muni_in:
                muni_key = _norm(muni_in)
                if muni_key not in _MUNI_MAP:
                    return jsonify({
                        "ok": False,
                        "error": "Municipio inválido",
                        "detalle": f"'{muni_in}' no está en el catálogo permitido."
                    }), 400
                muni_canon = _MUNI_MAP[muni_key]  # canónico
            else:
                muni_canon = ""  # permitir limpiar si así lo usas
            if prev["municipio"] != muni_canon:
                inv.municipio = muni_canon
                emit_repro("Municipio", prev["municipio"], muni_canon)   
                       
        if f_lugar is not None:
            nuevo_lugar = (f_lugar or "").strip()
            if prev["lugar"] != nuevo_lugar:
                inv.lugar = nuevo_lugar
                emit_repro("Lugar", prev["lugar"], nuevo_lugar)

        # Resto de campos (no disparan reprogramación)
        if f_evento is not None:
            inv.evento = (f_evento or "").strip()
            if prev["evento"] != inv.evento:
                add_notif_for(db, inv, "Evento", prev["evento"] or "", inv.evento or "")

        if f_ccargo is not None:
            inv.convoca_cargo = (f_ccargo or "").strip()
            if prev["convoca_cargo"] != inv.convoca_cargo:
                add_notif_for(db, inv, "Convoca Cargo", prev["convoca_cargo"] or "", inv.convoca_cargo or "")

        if f_partido is not None:
            inv.partido_politico = (f_partido or "").strip()
            if prev["partido_politico"] != inv.partido_politico:
                add_notif_for(db, inv, "Partido", prev["partido_politico"] or "", inv.partido_politico or "")

        if f_obs is not None:
            inv.observaciones = (f_obs or "").strip()
            if prev["observaciones"] != inv.observaciones:
                add_notif_for(db, inv, "Observaciones", prev["observaciones"] or "", inv.observaciones or "")

        # ======= ARCHIVO (igual que ya tenías) =======
        up = request.files.get("archivo")
        if f_del and inv.archivo_url:
            delete_file_if_local(inv.archivo_url)
            inv.archivo_url    = None
            inv.archivo_nombre = None
            inv.archivo_mime   = None
            inv.archivo_tamano = None
            inv.archivo_ts     = None

        if up and getattr(up, "filename", ""):
            meta = save_invitation_file(up, inv.id)
            if prev["archivo_url"] and not _is_http_url(prev["archivo_url"]):
                delete_file_if_local(prev["archivo_url"])
            inv.archivo_nombre = meta["nombre"]
            inv.archivo_mime   = meta["mime"]
            inv.archivo_tamano = meta["tamano"]
            inv.archivo_ts     = datetime.utcnow()
            inv.archivo_url    = meta["relpath"]

        inv.ultima_modificacion = datetime.utcnow()
        inv.modificado_por = getattr(getattr(g, "user", None), "usuario", None)

        db.commit()
        return jsonify({"ok": True})

    except ValueError as ve:
        db.rollback();  return jsonify({"ok": False, "error": str(ve)}), 400
    except Exception as e:
        db.rollback();  return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()



  
@app.delete("/api/invitation/delete/<id>")
@auth_required(['admin'])
def api_invitation_delete(id):
    db = SessionLocal()
    try:
        inv = db.query(Invitacion).get(id)
        if not inv:
            return jsonify({"ok": False, "error": "Invitación no encontrada"}), 404

        db.delete(inv)
        db.commit()
        return jsonify({"ok": True})
    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()

# =============================================================================
# Asignación (PARCHADO)
# =============================================================================
@app.post("/api/assign")
@auth_required(['admin'])
def api_assign():
    data = request.get_json() or {}

    inv_id         = (data.get("id") or "").strip()        # PK es String/UUID
    persona_id_raw = data.get("persona_id")
    actor_id_raw   = data.get("actor_id")
    rol_in         = (data.get("rol") or "").strip()
    comentario     = (data.get("comentario") or "").strip()
    force          = bool(data.get("force", False))

    if not inv_id:
        return jsonify({"ok": False, "error": "id inválido"}), 400
    if not persona_id_raw and not actor_id_raw:
        return jsonify({"ok": False, "error": "Falta persona_id o actor_id"}), 400

    db = SessionLocal()
    try:
        # Invitación
        inv = db.query(Invitacion).filter(Invitacion.id == inv_id).first()
        if not inv:
            return jsonify({"ok": False, "error": "Invitación no encontrada"}), 404

        # Guarda referencias previas (para snapshot del saliente y actor convocante)
        prev_asig        = inv.asignado_a
        prev_rol         = inv.rol
        prev_estatus     = inv.estatus
        prev_persona_id  = inv.persona_id
        prev_actor_id    = inv.actor_id

        prev_persona = db.get(Persona, prev_persona_id) if prev_persona_id else None
        prev_actor   = db.get(Actor,   prev_actor_id)   if prev_actor_id   else None

        if persona_id_raw:
            # ========== Asignar PERSONA ==========
            try:
                persona_id = int(persona_id_raw)
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "persona_id inválido"}), 400

            p = db.get(Persona, persona_id)
            if not p:
                return jsonify({"ok": False, "error": "Persona no encontrada"}), 404

            # Conflicto de agenda
            # ===== Validación de agenda con duración, buffer y gap =====
            if inv.fecha and inv.hora and not force:
                # Trae eventos del mismo día para esa persona (excluye la propia invitación)
                same_day = (
                    db.query(Invitacion)
                    .filter(Invitacion.persona_id == p.id)
                    .filter(Invitacion.fecha == inv.fecha)
                    .filter(Invitacion.estatus.in_(["Confirmado", "Sustituido"]))
                    .filter(Invitacion.id != inv.id)
                    .all()
                )

                inv_ini, inv_fin = _rango(inv)
                if not inv_ini or not inv_fin:
                    return jsonify({"ok": False, "error": "Falta hora para validar agenda"}), 400

                chocan = []
                for m in same_day:
                    m_ini, m_fin = _rango(m)
                    if _traslapan_con_gap(inv_ini, inv_fin, m_ini, m_fin):
                        chocan.append(m)

                if chocan:
                    return jsonify({
                        "ok": False,
                        "error": "Conflicto de agenda (no hay suficiente separación entre eventos)",
                        "detalles": [inv_to_dict(m) for m in chocan]
                    }), 409
            # ===== Fin validación =====

            # Si había una persona previa distinta, registra SUSTITUIDO con snapshot del saliente
            if prev_persona and prev_persona.id != p.id:
                add_notif_for(
                    db, inv,
                    campo="Sustituido",
                    valor_anterior=prev_asig or "",
                    valor_nuevo=p.nombre or "",
                    comentario=comentario,
                    persona_obj=prev_persona,
                    # el estatus que deseas congelar en esta notificación
                    estatus_override="Sustituido"
                )

            # Actualiza asignación a persona (el actor convocante permanece en inv.actor_id)
            inv.persona_id = p.id
            inv.asignado_a = p.nombre
            inv.rol        = (rol_in if rol_in else (p.cargo or ""))
            inv.estatus    = "Confirmado"

            if comentario:
                inv.observaciones = ((inv.observaciones or "") + (" | " if inv.observaciones else "") + comentario)

            inv.fecha_asignacion     = datetime.utcnow()
            inv.ultima_modificacion  = datetime.utcnow()
            inv.modificado_por       = getattr(getattr(g, "user", None), "usuario", "atiapp")

            # Notificaciones del ENTRANTE (persona) — IMPORTANTE: incluir actor_obj=prev_actor
            add_notif_for(
                db, inv,
                campo="Asignado A",
                valor_anterior=prev_asig or "",
                valor_nuevo=inv.asignado_a or "",
                comentario=comentario,
                persona_obj=p,
                actor_obj=prev_actor,                 # ← para que llegue al actor también
                estatus_override="Confirmado"
            )

            if (prev_rol or "") != (inv.rol or ""):
                add_notif_for(
                    db, inv,
                    campo="Rol",
                    valor_anterior=prev_rol or "",
                    valor_nuevo=inv.rol or "",
                    comentario=comentario,
                    persona_obj=p,
                    actor_obj=prev_actor,             # ← idem
                    estatus_override="Confirmado"
                )

            # ⚠️ ESTA es la que consume el bot (campo='Estatus' y valor_nuevo='Confirmado')
            add_notif_for(
                db, inv,
                campo="Estatus",
                valor_anterior=(prev_estatus or ""),
                valor_nuevo="Confirmado",
                comentario=comentario,
                persona_obj=p,
                actor_obj=prev_actor,                 # ← CLAVE: teléfonos del actor en este snapshot
                estatus_override="Confirmado"
            )

            # (Opcional) Snapshot informativo para auditoría (el bot NO lo usa)
            # Manténlo si te sirve, pero no afecta envíos.
            # if prev_actor_id:
            #     add_notif_for(
            #         db, inv,
            #         campo="Asignado A (aviso a convoca)",
            #         valor_anterior=prev_asig or "",
            #         valor_nuevo=inv.asignado_a or "",
            #         comentario=comentario,
            #         actor_obj=prev_actor,
            #         estatus_override=inv.estatus
            #     )

        else:
            # ========== Asignar ACTOR ==========
            try:
                actor_id = int(actor_id_raw)
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "actor_id inválido"}), 400

            a = db.get(Actor, actor_id)
            if not a:
                return jsonify({"ok": False, "error": "Actor no encontrado"}), 404

            # Si había persona previa, déjala como SUSTITUIDA
            if prev_persona:
                add_notif_for(
                    db, inv,
                    campo="Sustituido",
                    valor_anterior=prev_asig or "",
                    valor_nuevo=a.nombre or "",
                    comentario=comentario,
                    persona_obj=prev_persona,
                    estatus_override="Sustituido"
                )

            # Actualiza asignación al actor (y desasigna persona)
            inv.actor_id   = a.id
            inv.persona_id = None
            inv.asignado_a = a.nombre
            inv.rol        = (rol_in if rol_in else (a.cargo or ""))
            inv.estatus    = "Confirmado"

            if comentario:
                inv.observaciones = ((inv.observaciones or "") + (" | " if inv.observaciones else "") + comentario)

            inv.fecha_asignacion     = datetime.utcnow()
            inv.ultima_modificacion  = datetime.utcnow()
            inv.modificado_por       = getattr(getattr(g, "user", None), "usuario", "atiapp")

            # Notifs del ENTRANTE (actor)
            add_notif_for(
                db, inv,
                campo="Asignado A",
                valor_anterior=prev_asig or "",
                valor_nuevo=inv.asignado_a or "",
                comentario=comentario,
                actor_obj=a,
                estatus_override="Confirmado"
            )

            if (prev_rol or "") != (inv.rol or ""):
                add_notif_for(
                    db, inv,
                    campo="Rol",
                    valor_anterior=prev_rol or "",
                    valor_nuevo=inv.rol or "",
                    comentario=comentario,
                    actor_obj=a,
                    estatus_override="Confirmado"
                )

            # ⚠️ ESTA dispara el bot (igual que en persona)
            add_notif_for(
                db, inv,
                campo="Estatus",
                valor_anterior=(prev_estatus or ""),
                valor_nuevo="Confirmado",
                comentario=comentario,
                actor_obj=a,
                estatus_override="Confirmado"
            )

        db.commit()
        return jsonify({"ok": True})

    except Exception as e:
        db.rollback()
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        db.close()



# ================================
# Helpers de snapshot
# ================================
def _sexo_nombre(db, sexo_id):
    if not sexo_id:
        return None
    try:
        # Asume modelo Sexo(id, nombre)
        s = db.query(Sexo).get(int(sexo_id))
        return s.nombre if s else None
    except Exception:
        return None

def _only_digits(s):
    return "".join(ch for ch in (s or "") if ch.isdigit())

# -- NUEVO: snapshot usando persona/actor "forzado" (saliente o entrante)
def add_notif_for(
    db,
    inv,                       # Invitacion
    campo,                     # str (usa "Estatus" para bot)
    valor_anterior,            # str
    valor_nuevo,               # str ("Confirmado" o "Sustituido")
    comentario=None,           # str | None
    persona_obj=None,          # Persona | None
    actor_obj=None,            # Actor | None
    estatus_override=None      # str | None (p.ej. "Confirmado" o "Sustituido")
):
    # Helpers locales
    def _sexo_nombre(db, sexo_id):
        if not sexo_id:
            return None
        try:
            s = db.query(Sexo).get(int(sexo_id))
            return s.nombre if s else None
        except Exception:
            return None

    def _only_digits(s):
        return "".join(ch for ch in (s or "") if ch and str(ch).isdigit())

    estatus = estatus_override if estatus_override is not None else (inv.estatus or "")

    # Snapshot de ACTOR (si aplica)
    actor_nombre = actor_cargo = actor_tel = actor_sexo = None
    actor_part_nombre = actor_part_cargo = actor_part_tel = None
    if actor_obj is not None:
        actor_nombre = getattr(actor_obj, "nombre", None) or None
        actor_cargo  = getattr(actor_obj, "cargo",  None) or None
        raw_tel      = getattr(actor_obj, "telefono", None)
        actor_tel    = _only_digits(raw_tel) if raw_tel else None
        actor_sexo   = _sexo_nombre(db, getattr(actor_obj, "sexo_id", None))
        actor_part_nombre = getattr(actor_obj, "particular_nombre", None)
        actor_part_cargo  = getattr(actor_obj, "particular_cargo",  None)
        raw_ptel          = getattr(actor_obj, "particular_tel",   None)
        actor_part_tel    = _only_digits(raw_ptel) if raw_ptel else None

    # Snapshot de PERSONA (si aplica)
    persona_tel = persona_sexo = None
    persona_part_nombre = persona_part_cargo = persona_part_tel = None
    if persona_obj is not None:
        raw_p_tel   = getattr(persona_obj, "telefono", None)
        persona_tel = _only_digits(raw_p_tel) if raw_p_tel else None
        persona_sexo = _sexo_nombre(db, getattr(persona_obj, "sexo_id", None))
        persona_part_nombre = getattr(persona_obj, "particular_nombre", None)
        persona_part_cargo  = getattr(persona_obj, "particular_cargo",  None)
        raw_p_ptel          = getattr(persona_obj, "particular_tel",    None)
        persona_part_tel    = _only_digits(raw_p_ptel) if raw_p_ptel else None

    notif = Notificacion(
        invitacion_id       = str(inv.id),

        # Qué cambió
        campo               = campo or "",
        valor_anterior      = (valor_anterior or ""),
        valor_nuevo         = (valor_nuevo or ""),
        comentario          = (comentario or ""),

        # Copia de datos de la invitación (snap)
        evento              = (inv.evento or ""),
        convoca             = (inv.convoca or ""),
        estatus             = estatus,
        asignado_a_nombre   = (inv.asignado_a or ""),
        rol                 = (inv.rol or ""),
        fecha               = inv.fecha,
        hora                = inv.hora,
        municipio           = (inv.municipio or ""),
        lugar               = (inv.lugar or ""),
        convoca_cargo       = (inv.convoca_cargo or ""),

        # Datos del actor (si aplica)
        actor_nombre        = actor_nombre,
        actor_cargo         = actor_cargo,
        actor_tel           = actor_tel,
        actor_sexo          = actor_sexo,
        actor_particular_nombre = actor_part_nombre,
        actor_particular_cargo  = actor_part_cargo,
        actor_particular_tel    = actor_part_tel,

        # Datos de la persona (si aplica)
        persona_tel         = persona_tel,
        persona_sexo        = persona_sexo,
        persona_particular_nombre = persona_part_nombre,
        persona_particular_cargo  = persona_part_cargo,
        persona_particular_tel    = persona_part_tel,

        enviado             = False,
        enviado_ts          = None,
    )
    db.add(notif)



       
@app.get("/api/notificaciones/<inv_id>")
@auth_required(['admin'])
def api_notif_by_inv(inv_id):
    db = SessionLocal()
    try:
        rows = (db.query(Notificacion)
                  .filter(Notificacion.invitacion_id == str(inv_id))
                  .order_by(Notificacion.ts.desc())
                  .all())
        out = []
        for n in rows:
            out.append({
                "id": n.id,
                "ts": n.ts.isoformat() if n.ts else None,
                "campo": n.campo,
                "valor_anterior": n.valor_anterior,
                "valor_nuevo": n.valor_nuevo,
                "comentario": n.comentario,
                "evento": n.evento,
                "convoca": n.convoca,
                "estatus": n.estatus,
                "asignado_a_nombre": n.asignado_a_nombre,
                "rol": n.rol,
                "fecha": n.fecha.isoformat() if n.fecha else None,
                "hora": n.hora.isoformat() if n.hora else None,
                "municipio": n.municipio,
                "lugar": n.lugar,
                "convoca_cargo": n.convoca_cargo,
                "actor_nombre": n.actor_nombre,
                "actor_cargo": n.actor_cargo,
                "actor_tel": n.actor_tel,
                "actor_sexo": n.actor_sexo,
                "actor_particular_nombre": n.actor_particular_nombre,
                "actor_particular_cargo": n.actor_particular_cargo,
                "actor_particular_tel": n.actor_particular_tel,
                "persona_tel": n.persona_tel,
                "persona_sexo": n.persona_sexo,
                "persona_particular_nombre": n.persona_particular_nombre,
                "persona_particular_cargo": n.persona_particular_cargo,
                "persona_particular_tel": n.persona_particular_tel,
                "enviado": n.enviado,
                "enviado_ts": n.enviado_ts.isoformat() if n.enviado_ts else None
            })
        return jsonify(out)
    finally:
        db.close()

@app.get("/_debug/report_xlsx")
@auth_required(['admin','viewer'])
def debug_export_xlsx():
    """
    Debug rápido: intenta ejecutar la lógica de export pero captura y devuelve la traza completa.
    Úsalo temporalmente para ver exactamente qué exception ocurre en Render.
    """
    db = SessionLocal()
    try:
        # --- aquí llama a tu función que genera `df` o copia la lógica ---
        # Para reutilizar, si tienes la función que construye `out`/`df` extrae esa lógica
        # a una función y llámala aquí. Si no, pega tu lógica para generar `df`.

        # ejemplo mínimo: intenta crear un pequeño df y convertirlo
        import pandas as pd
        from io import BytesIO

        sample = [{"a":1,"b":"x"},{"a":2,"b":"y"}]
        df = pd.DataFrame(sample)

        bio = BytesIO()
        with pd.ExcelWriter(bio, engine="openpyxl") as writer:
            df.to_excel(writer, index=False, sheet_name="Prueba")
        bio.seek(0)

        # si llegamos OK, respondemos con un mensaje pequeño (no el xlsx)
        return jsonify({"ok": True, "msg": "Generación de Excel de prueba OK en servidor."})

    except Exception as e:
        tb = traceback.format_exc()
        app_ctx.logger.exception("Debug export error")
        # devolver la traza en la respuesta (temporal, inseguro para producción)
        return make_response(jsonify({"ok": False, "error": str(e), "trace": tb}), 500)
    finally:
        db.close()

@app.get("/api/report/confirmados.xlsx")
@auth_required(['admin','viewer'])
def api_export_invitaciones_xlsx():
    """
    Exporta invitaciones e intenta mapear municipio -> región (columna "Región").
    Matching strategy:
      - normaliza ambos lados (lower, quitar tildes, collapse spaces)
      - exact match by normalized name
      - contains / startsWith fallback
      - registra/expone municipios no mapeados en hoja adicional para diagnóstico
    """
    db = SessionLocal()
    try:
        def normalize_name(s):
            if not s:
                return ""
            s = str(s).strip().lower()
            s = unicodedata.normalize('NFD', s)
            s = ''.join(ch for ch in s if not unicodedata.combining(ch))
            s = ' '.join(s.split())
            return s

        # --- cargar nombres de regiones (id -> nombre) ---
        region_names = {}
        try:
            regs = db.query(Region).all()
            for r in regs:
                region_names[getattr(r, 'id')] = getattr(r, 'nombre', '') or ''
        except Exception:
            # si no existe Region/tabla, seguir con vacio
            region_names = {}

        # --- construir mapeo municipio_normalizado -> region_id leyendo region_municipios ---
        muni_to_region = {}
        try:
            q = text("SELECT region_id, municipio FROM region_municipios")
            rows = db.execute(q).fetchall()
            for row in rows:
                try:
                    region_id = row['region_id'] if 'region_id' in row.keys() else row[0]
                    muni_raw  = row['municipio']   if 'municipio'   in row.keys() else row[1]
                except Exception:
                    region_id = row[0]
                    muni_raw = row[1]
                key = normalize_name(muni_raw)
                if key:
                    muni_to_region[key] = int(region_id) if region_id is not None else None
        except Exception:
            # tabla no existe o error -> mapa vacío
            muni_to_region = {}

        # --- Traer invitaciones (con persona y actor) ---
        rows = (
            db.query(Invitacion, Persona, Actor)
              .outerjoin(Persona, Persona.id == Invitacion.persona_id)
              .outerjoin(Actor,   Actor.id   == Invitacion.actor_id)
              .order_by(Invitacion.fecha.asc().nulls_last(),
                        Invitacion.hora.asc().nulls_last(),
                        Invitacion.id.asc())
              .all()
        )

        def fmt_d(d): return d.strftime("%Y-%m-%d") if d else ""
        def fmt_t(t): return t.strftime("%H:%M") if t else ""

        out = []
        unmatched = {}  # muni_norm -> set of raw municipality examples
        muni_keys = sorted(muni_to_region.keys(), key=lambda x: -len(x))  # claves largas primero

        for inv, per, act in rows:
            municipio_raw = (inv.municipio or "").strip()
            muni_norm = normalize_name(municipio_raw)

            region_id = None
            region_nombre = None

            # 1) match exact
            if muni_norm and muni_norm in muni_to_region:
                region_id = muni_to_region[muni_norm]
                region_nombre = region_names.get(region_id) if region_id is not None else None

            # 2) fallback: buscar key del mapa que contenga muni_norm
            if region_id is None and muni_norm:
                for k in muni_keys:
                    if k.find(muni_norm) != -1:
                        region_id = muni_to_region.get(k)
                        region_nombre = region_names.get(region_id) if region_id is not None else None
                        break

            # 3) fallback inverso: muni_norm contiene alguna key
            if region_id is None and muni_norm:
                for k in muni_keys:
                    if muni_norm.find(k) != -1:
                        region_id = muni_to_region.get(k)
                        region_nombre = region_names.get(region_id) if region_id is not None else None
                        break

            # 4) fallback: persona asignada tiene region_id
            if region_id is None and per is not None:
                try:
                    rpid = getattr(per, "region_id", None)
                    if rpid:
                        region_id = int(rpid)
                        region_nombre = region_names.get(region_id) if region_id is not None else None
                except Exception:
                    pass

            # 5) fallback: unidad_region texto de persona
            if not region_nombre and per is not None:
                unidad_txt = getattr(per, "unidad_region", None)
                if unidad_txt:
                    region_nombre = unidad_txt

            # si no encontramos region, registramos para diagnostico
            if not region_nombre:
                if muni_norm not in unmatched:
                    unmatched[muni_norm] = set()
                unmatched[muni_norm].add(municipio_raw)

            out.append({
                "Municipio":             municipio_raw or "",
                "Región":                region_nombre or "",
                "Partido Político":      inv.partido_politico or "",
                "Quien Convoca/Actor":   (act.nombre if act else "") or "",
                "Cargo Actor":           (act.cargo  if act else "") or "",
                "Asignado/Persona":      (per.nombre if per else "") or "",
                "Cargo Persona":         (per.cargo  if per else "") or "",
                "Unidad/Región":         (getattr(per, "unidad_region", None) or "") or "",
                "Fecha":                 fmt_d(inv.fecha),
                "Lugar":                 inv.lugar or "",
                "Hora":                  fmt_t(inv.hora),
                "Quien convoca":         inv.convoca or "",
            })

        # --- Crear DataFrame principal ---
        df = pd.DataFrame(out, columns=[
            "Municipio",
            "Región",
            "Partido Político",
            "Quien Convoca/Actor",
            "Cargo Actor",
            "Asignado/Persona",
            "Cargo Persona",
            "Unidad/Región",
            "Fecha",
            "Lugar",
            "Hora",
            "Quien convoca",
        ])

        # --- Hoja de diagnostico: municipios no mapeados ---
        unmatched_list = []
        for k, s in unmatched.items():
            unmatched_list.append({
                "municipio_normalizado": k,
                "ejemplos_raw": "; ".join(sorted(s))
            })
        df_unmatched = pd.DataFrame(unmatched_list)

        # --- Generar Excel en memoria ---
        bio = BytesIO()
        try:
            with pd.ExcelWriter(bio, engine="openpyxl") as writer:
                df.to_excel(writer, index=False, sheet_name="Invitaciones")
                if not df_unmatched.empty:
                    df_unmatched.to_excel(writer, index=False, sheet_name="Municipios_no_mapeados")
            bio.seek(0)
        except Exception:
            app_ctx.logger.exception("Error generando Excel con pandas/openpyxl.")
            return jsonify({"ok": False, "error": "Error generando Excel en servidor."}), 500

        filename = f"invitaciones_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        try:
            resp = send_file(
                bio,
                mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                as_attachment=True,
                download_name=filename
            )
            # Exponer header si usas fetch cross-origin
            resp.headers['Access-Control-Expose-Headers'] = 'Content-Disposition'
            resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
            return resp
        except Exception:
            app_ctx.logger.exception("Error devolviendo send_file.")
            return jsonify({"ok": False, "error": "Error preparando la respuesta de descarga."}), 500

    except Exception:
        app_ctx.logger.exception("Error en api_export_invitaciones_xlsx (general).")
        return jsonify({"ok": False, "error": "Error interno del servidor. Revisa logs."}), 500
    finally:
        db.close()


        
# GET /api/invitaciones/updates?since=2025-11-12T10:00:00
@app.get("/api/invitaciones/updates")
@auth_required(['admin'])
def api_invitaciones_updates():
    from datetime import datetime as dt
    since = (request.args.get("since") or "").strip()
    try:
        since_dt = dt.fromisoformat(since) if since else None
    except Exception:
        return jsonify({"ok": False, "error": "since inválido (ISO 8601)"}), 400

    db = SessionLocal()
    try:
        q = db.query(Invitacion)
        if since_dt:
            q = q.filter(Invitacion.ultima_modificacion > since_dt)
        rows = (q.order_by(Invitacion.ultima_modificacion.desc())
                  .limit(200)
                  .all())
        out = [inv_to_dict(r) for r in rows]  # usa tu helper existente
        return jsonify({"ok": True, "items": out, "now": dt.utcnow().isoformat()})
    finally:
        db.close()

# =============================================================================
# Archivos
# =============================================================================
@app.get("/api/files/<path:fname>")
def api_files(fname):
    path = os.path.join(os.path.dirname(__file__), "uploads", fname)
    if not os.path.isfile(path):
        return jsonify({"ok": False, "error": "Archivo no encontrado"}), 404
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return send_file(path, mimetype=mime, as_attachment=False, download_name=fname)

# =============================================================================
# Salud
# =============================================================================
@app.get("/api/health")
def api_health():
    u = get_user_from_token()
    return jsonify({"ok": True, "ts": datetime.utcnow().isoformat(), "auth": bool(u)})

# =============================================================================
# Main
# =============================================================================
if __name__ == "__main__":
    os.makedirs(os.path.join(os.path.dirname(__file__), "uploads"), exist_ok=True)
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=bool(os.getenv("DEBUG", "1") == "1"))
