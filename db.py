"""
db.py — Acceso a base de datos.

Soporta PostgreSQL (Railway, producción) y SQLite (desarrollo local).
Sin ORM: SQL crudo, igual que el resto del stack.

Variables de entorno:
  DATABASE_URL   postgres://...   -> PostgreSQL
                 (ausente)        -> SQLite en ./data/levantamiento.db
"""
import os
import json
import sqlite3
import threading
from contextlib import contextmanager

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# Railway entrega postgres:// ; psycopg2 quiere postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

_pool = None
_pool_lock = threading.Lock()
_sqlite_path = os.environ.get("SQLITE_PATH", os.path.join("data", "levantamiento.db"))


def _init_pool():
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            from psycopg2.pool import ThreadedConnectionPool
            _pool = ThreadedConnectionPool(
                1,
                int(os.environ.get("DB_POOL_MAX", "10")),
                dsn=DATABASE_URL,
                connect_timeout=10,
            )
    return _pool


@contextmanager
def conn_ctx():
    """Entrega una conexión y la devuelve al pool al salir."""
    if USE_PG:
        pool = _init_pool()
        con = pool.getconn()
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            pool.putconn(con)
    else:
        os.makedirs(os.path.dirname(_sqlite_path) or ".", exist_ok=True)
        con = sqlite3.connect(_sqlite_path, timeout=15)
        con.row_factory = sqlite3.Row
        try:
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA foreign_keys=ON")
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def q(sql: str) -> str:
    """Adapta los placeholders: se escribe siempre con ?, se traduce a %s en PG."""
    return sql.replace("?", "%s") if USE_PG else sql


def _dictify(cur, rows):
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in rows]


def rows(sql, params=()):
    with conn_ctx() as con:
        cur = con.cursor()
        cur.execute(q(sql), params)
        data = _dictify(cur, cur.fetchall())
        cur.close()
        return data


def row(sql, params=()):
    r = rows(sql, params)
    return r[0] if r else None


def execute(sql, params=()):
    with conn_ctx() as con:
        cur = con.cursor()
        cur.execute(q(sql), params)
        n = cur.rowcount
        cur.close()
        return n


def execute_many(statements):
    """statements: lista de (sql, params)."""
    with conn_ctx() as con:
        cur = con.cursor()
        for sql, params in statements:
            cur.execute(q(sql), params)
        cur.close()


def jload(value, default=None):
    """Los JSON se guardan como TEXT para que PG y SQLite se comporten igual."""
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, memoryview)):
        value = bytes(value).decode("utf-8")
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return default


def jdump(value):
    return json.dumps(value, ensure_ascii=False)


def to_bytes(value):
    """Normaliza lo que devuelve cada driver para columnas binarias."""
    if value is None:
        return b""
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, bytearray):
        return bytes(value)
    return value


def binary(data: bytes):
    """Envuelve bytes para el driver correspondiente."""
    if USE_PG:
        import psycopg2
        return psycopg2.Binary(data)
    return sqlite3.Binary(data)


NOW = "NOW()" if USE_PG else "CURRENT_TIMESTAMP"
