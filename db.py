# db.py
import os
from datetime import datetime
from sqlalchemy import (
    create_engine, Column, Integer, String, Text, Boolean, Date, Time, DateTime,
    ForeignKey, Index
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

DB_URL = os.getenv("DB_URL")  # p.ej. postgresql+psycopg://user:pass@host:5432/dbname
if DB_URL and DB_URL.startswith("postgresql://"):
    DB_URL = "postgresql+psycopg://" + DB_URL.split("://", 1)[1]

engine = create_engine(DB_URL, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)
Base = declarative_base()

# ----------------- MODELOS -----------------

class Sexo(Base):
    __tablename__ = "sexo"
    id     = Column(Integer, primary_key=True)
    nombre = Column(Text, unique=True, nullable=False)

class Partido(Base):
    __tablename__ = "partidos"
    id     = Column(Integer, primary_key=True)
    nombre = Column(Text, unique=True, nullable=False)

class Usuario(Base):
    __tablename__ = "usuarios"
    id       = Column(Integer, primary_key=True)
    usuario  = Column(String(80), unique=True, nullable=False, index=True)
    pwd_hash = Column(String(200), nullable=False)
    rol      = Column(String(20), default="editor")  # admin|editor
    activo   = Column(Boolean, default=True)
    creado_ts= Column(DateTime, default=datetime.utcnow)

    # requerido por Flask-Login
    @property
    def is_authenticated(self): return True
    @property
    def is_active(self): return self.activo
    @property
    def is_anonymous(self): return False
    def get_id(self): return str(self.id)

class Actor(Base):
    __tablename__ = "actores"
    id        = Column(Integer, primary_key=True)
    nombre    = Column(Text, nullable=False)
    cargo     = Column(Text)
    telefono  = Column(Text)
    sexo_id   = Column(Integer, ForeignKey("sexo.id"))
    activo    = Column(Boolean, default=True, nullable=False)

    particular_nombre = Column(Text)
    particular_cargo  = Column(Text)
    particular_tel    = Column(Text)

    sexo      = relationship("Sexo")

class Persona(Base):
    __tablename__ = "personas"
    id            = Column(Integer, primary_key=True)
    nombre        = Column(String, nullable=False, index=True)
    cargo         = Column(String)
    telefono      = Column(String)
    correo        = Column(String)
    unidad_region = Column(String)
    activo        = Column(Boolean, default=True, nullable=False)

    sexo_id       = Column(Integer, ForeignKey("sexo.id"))
    particular_nombre = Column(Text)
    particular_cargo  = Column(Text)
    particular_tel    = Column(Text)
     # ... lo que ya tienes ...
    region_id         = Column(Integer, ForeignKey("regiones.id", ondelete="SET NULL"))
    region        = relationship("Region", back_populates="personas")
    sexo          = relationship("Sexo")
    invitaciones  = relationship("Invitacion", back_populates="persona", lazy="selectin")

class Invitacion(Base):
    __tablename__ = "invitaciones"
    # __table_args__ = {"schema": "public"}  # (opcional) fija esquema

    id                   = Column(String, primary_key=True)  # <-- era Integer
    fecha                = Column(Date, nullable=False)
    hora                 = Column(Time, nullable=False)
    evento               = Column(Text, nullable=False)
    convoca_cargo        = Column(Text, nullable=False)
    convoca              = Column(Text, nullable=False)
    partido_politico     = Column(Text, nullable=False)
    municipio            = Column(Text, nullable=False)
    lugar                = Column(Text, nullable=False)

    estatus              = Column(String, default="Pendiente", nullable=False)
    asignado_a           = Column(Text)
    rol                  = Column(Text)
    observaciones        = Column(Text)

    fecha_asignacion     = Column(DateTime)
    ultima_modificacion  = Column(DateTime, default=datetime.utcnow)
    modificado_por       = Column(String)

    actor_id             = Column(Integer, ForeignKey("actores.id", ondelete="SET NULL"), nullable=True)
    persona_id           = Column(Integer, ForeignKey("personas.id", ondelete="SET NULL"), nullable=True)

    actor                = relationship("Actor", lazy="joined")
    persona              = relationship("Persona", back_populates="invitaciones", lazy="joined")

    archivo_url          = Column(Text)
    archivo_nombre       = Column(Text)
    archivo_mime         = Column(Text)
    archivo_tamano       = Column(Integer)
    archivo_ts           = Column(DateTime)
    grupo_token          = Column(Text)
    sub_tipo             = Column(Text)

    __table_args__ = (
        Index("idx_invitaciones_estatus", "estatus"),
        Index("idx_invitaciones_fecha", "fecha"),
        Index("idx_invitaciones_actor", "actor_id"),
        Index("idx_invitaciones_persona", "persona_id"),
    )

class Notificacion(Base):
    __tablename__ = "notificaciones"
    id                = Column(Integer, primary_key=True)
    ts                = Column(DateTime, default=datetime.utcnow, nullable=False)

    invitacion_id     = Column(String, index=True)
    campo             = Column(Text)

    evento            = Column(Text)
    convoca           = Column(Text)
    estatus           = Column(Text)
    asignado_a_nombre = Column(Text)
    rol               = Column(Text)
    valor_anterior    = Column(Text)
    valor_nuevo       = Column(Text)
    comentario        = Column(Text)

    fecha             = Column(Date)
    hora              = Column(Time)
    municipio         = Column(Text)
    lugar             = Column(Text)
    convoca_cargo     = Column(Text)

    actor_nombre      = Column(Text)
    actor_cargo       = Column(Text)
    actor_tel         = Column(Text)
    actor_sexo        = Column(Text)
    actor_particular_nombre = Column(Text)
    actor_particular_cargo  = Column(Text)
    actor_particular_tel    = Column(Text)

    persona_tel       = Column(Text)
    persona_sexo      = Column(Text)
    persona_particular_nombre = Column(Text)
    persona_particular_cargo  = Column(Text)
    persona_particular_tel    = Column(Text)

    enviado           = Column(Boolean, default=False, nullable=False)
    enviado_ts        = Column(DateTime)

    __table_args__ = (
        Index("idx_notif_enviado", "enviado"),
        Index("idx_notif_ts", "ts"),
        Index("idx_notif_inv_id", "invitacion_id"),
    )
    
class Region(Base):
    __tablename__ = "regiones"

    id    = Column(Integer, primary_key=True)
    nombre = Column(Text, nullable=False)
    slug   = Column(Text, unique=True)
    color  = Column(Text)   # opcional (para mapita / badges)

    municipios = relationship("RegionMunicipio", back_populates="region", lazy="joined")
    personas   = relationship("Persona", back_populates="region", lazy="selectin")


class RegionMunicipio(Base):
    __tablename__ = "region_municipios"

    id        = Column(Integer, primary_key=True)
    region_id = Column(Integer, ForeignKey("regiones.id", ondelete="CASCADE"), nullable=False)
    municipio = Column(Text, nullable=False)  # usa el nombre canónico tal como lo valida VALID_MUNICIPIOS

    region = relationship("Region", back_populates="municipios")
