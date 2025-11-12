# init_db.py
from db import Base, engine, SessionLocal, Sexo, Partido

def main():
    Base.metadata.create_all(engine)
    # siembra mínima (por si no está)
    db = SessionLocal()
    try:
        for s in ["Hombre", "Mujer", "No especificado"]:
            if not db.query(Sexo).filter_by(nombre=s).first():
                db.add(Sexo(nombre=s))
        for p in ["MORENA","PAN","PRI","PRD","MC","PVEM","INDEPENDIENTE"]:
            if not db.query(Partido).filter_by(nombre=p).first():
                db.add(Partido(nombre=p))
        db.commit()
        print("OK: tablas listas y catálogos sembrados.")
    finally:
        db.close()

if __name__ == "__main__":
    main()
