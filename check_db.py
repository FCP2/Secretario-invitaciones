# check_db.py
from sqlalchemy import inspect
from db import engine

def check():
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    if not tables:
        print("⚠️ No hay tablas en la base de datos.")
    else:
        print("✅ Tablas encontradas en la base de datos:")
        for t in tables:
            print(f" - {t}")

if __name__ == "__main__":
    check()