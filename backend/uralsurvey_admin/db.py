"""Подключение к PostgreSQL и применение схемы.

Соединения берутся из небольшого запаса: панель — это единицы запросов в секунду,
большего ей не нужно. Каждая операция идёт в своей транзакции.
"""

from __future__ import annotations

import contextlib
import os
import pathlib
import queue
import threading

import psycopg
from psycopg.rows import dict_row

MIGRATIONS = pathlib.Path(__file__).resolve().parent.parent / "migrations"


def default_dsn() -> str:
    """Строка подключения: из переменной URAL_DSN, иначе база uralsurvey через локальный сокет."""
    return os.environ.get("URAL_DSN", "dbname=uralsurvey")


class Database:
    def __init__(self, dsn: str | None = None, size: int = 4):
        self.dsn = dsn or default_dsn()
        self._pool: queue.LifoQueue = queue.LifoQueue()
        self._lock = threading.Lock()
        self._made = 0
        self._size = size

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self.dsn, row_factory=dict_row, autocommit=True)

    @contextlib.contextmanager
    def connection(self):
        conn = None
        try:
            conn = self._pool.get_nowait()
        except queue.Empty:
            with self._lock:
                can_make = self._made < self._size
                if can_make:
                    self._made += 1
            conn = self._connect() if can_make else self._pool.get(timeout=10)
        try:
            if conn.closed or conn.broken:
                conn = self._connect()
            yield conn
        finally:
            if conn.closed or conn.broken:
                with self._lock:
                    self._made -= 1
            else:
                self._pool.put(conn)

    @contextlib.contextmanager
    def transaction(self):
        """Одна транзакция: всё либо записано целиком, либо не записано вовсе."""
        with self.connection() as conn, conn.transaction():
            yield conn

    def close(self) -> None:
        while True:
            try:
                self._pool.get_nowait().close()
            except queue.Empty:
                break

    def migrate(self) -> list[str]:
        """Применяет ещё не применённые файлы схемы по порядку. Возвращает их имена."""
        applied: list[str] = []
        with self.transaction() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            # Два процесса не должны применять схему одновременно
            conn.execute("SELECT pg_advisory_xact_lock(726001)")
            done = {r["name"] for r in conn.execute("SELECT name FROM schema_migrations")}
            for path in sorted(MIGRATIONS.glob("*.sql")):
                if path.name in done:
                    continue
                conn.execute(path.read_text(encoding="utf-8"))
                conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
                applied.append(path.name)
        return applied
