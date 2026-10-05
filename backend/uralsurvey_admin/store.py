"""Всё, что администратор делает с сервером: проверка данных и работа с базой.

Здесь нет ни сети, ни HTTP — только операции. Ошибка, которую должен увидеть человек,
поднимается как Problem с текстом простыми словами.
"""

from __future__ import annotations

import datetime as dt
import decimal
import ipaddress
import json
import math
import re
from typing import Any

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from . import security
from .db import Database

SESSION_HOURS = 12


class Problem(Exception):
    """Отказ с объяснением для человека. status — код ответа HTTP."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------- Проверка входных данных ----------

def _text(max_len: int = 200, pattern: str | None = None, hint: str = ""):
    def check(value, name):
        if value is None:
            return ""
        if not isinstance(value, str):
            raise Problem(f"{name}: нужен текст.")
        value = value.strip()
        if len(value) > max_len:
            raise Problem(f"{name}: не длиннее {max_len} знаков.")
        if pattern and value and not re.fullmatch(pattern, value):
            raise Problem(f"{name}: {hint}.")
        return value
    return check


def _int(low: int, high: int, nullable: bool = False):
    def check(value, name):
        if value is None or value == "":
            if nullable:
                return None
            raise Problem(f"{name}: нужно число от {low} до {high}.")
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            raise Problem(f"{name}: нужно целое число.")
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise Problem(f"{name}: нужно целое число.") from None
        if isinstance(value, float) and value != number:
            raise Problem(f"{name}: нужно целое число.")
        if not low <= number <= high:
            raise Problem(f"{name}: число от {low} до {high}.")
        return number
    return check


def _bool(value, name):
    if isinstance(value, bool):
        return value
    raise Problem(f"{name}: нужно «да» или «нет».")


def _date(nullable: bool = False):
    def check(value, name):
        if value in (None, ""):
            if nullable:
                return None
            raise Problem(f"{name}: нужна дата в виде ГГГГ-ММ-ДД.")
        try:
            return dt.date.fromisoformat(str(value))
        except ValueError:
            raise Problem(f"{name}: нужна дата в виде ГГГГ-ММ-ДД.") from None
    return check


def _decimal(places: int, low: float, high: float, nullable: bool = True):
    def check(value, name):
        if value in (None, ""):
            if nullable:
                return None
            raise Problem(f"{name}: нужно число.")
        try:
            number = decimal.Decimal(str(value).replace(",", ".").replace(" ", ""))
        except decimal.InvalidOperation:
            raise Problem(f"{name}: нужно число.") from None
        if not number.is_finite() or not low <= number <= high:
            raise Problem(f"{name}: число от {low} до {high}.")
        return number.quantize(decimal.Decimal(1).scaleb(-places))
    return check


def _enum(*allowed: str):
    def check(value, name):
        if value not in allowed:
            raise Problem(f"{name}: одно из значений {', '.join(allowed)}.")
        return value
    return check


def _addresses(value, name):
    """Список разрешённых адресов станции: адреса и подсети IPv4."""
    if value in (None, ""):
        return []
    if isinstance(value, str):
        value = [v for v in re.split(r"[\s,;]+", value) if v]
    if not isinstance(value, list):
        raise Problem(f"{name}: список адресов.")
    out = []
    for item in value:
        try:
            net = ipaddress.ip_network(str(item).strip(), strict=False)
        except ValueError:
            raise Problem(f"{name}: «{item}» — не адрес IPv4 и не подсеть вида 10.0.0.0/8.") from None
        if net.version != 4:
            raise Problem(f"{name}: поддерживаются только адреса IPv4.")
        out.append(str(net.network_address) if net.prefixlen == 32 else str(net))
    return out


CODE = r"[A-Za-z0-9_-]{1,32}"

FIELDS: dict[str, dict[str, Any]] = {
    "stations": {
        "code": _text(32, CODE, "латинские буквы, цифры, «_» и «-», до 32 знаков"),
        "name": _text(80),
        "enabled": _bool,
        "source_mode": _enum("listen", "ntrip", "tcp", "sim"),
        "source_host": _text(120),
        "source_port": _int(1, 65535, nullable=True),
        "source_mountpoint": _text(64),
        "source_username": _text(64),
        "allow_addresses": _addresses,
        "x": _decimal(4, -7e6, 7e6),
        "y": _decimal(4, -7e6, 7e6),
        "z": _decimal(4, -7e6, 7e6),
        "antenna_height": _decimal(4, 0, 6.5535),
        "antenna_type": _text(31, r"[\x20-\x7e]*", "только латиница, цифры и знаки, до 31 знака"),
        "receiver_type": _text(31, r"[\x20-\x7e]*", "только латиница, цифры и знаки, до 31 знака"),
        "note": _text(500),
    },
    "mountpoints": {
        "name": _text(32, CODE, "латинские буквы, цифры, «_» и «-», до 32 знаков"),
        "station_id": _int(1, 2**31 - 1),
        "rtcm_station_id": _int(0, 4095, nullable=True),
        "listed": _bool,
        "enabled": _bool,
        "access": _enum("all", "tariff", "staff"),
        "note": _text(500),
    },
    "clients": {
        "name": _text(200),
        "inn": _text(12, r"(\d{10}|\d{12})?", "10 или 12 цифр"),
        "contact": _text(120),
        "phone": _text(40),
        "email": _text(120, r"([^@\s]+@[^@\s]+\.[^@\s]+)?", "адрес вида имя@узел"),
        "contract_no": _text(60),
        "contract_date": _date(nullable=True),
        "note": _text(1000),
    },
    "tariffs": {
        "name": _text(80),
        "period_days": _int(1, 3660),
        "all_mountpoints": _bool,
        "max_sessions": _int(1, 100),
        "price": _decimal(2, 0, 1e9),
        "note": _text(500),
    },
    "subscriptions": {
        "client_id": _int(1, 2**31 - 1),
        "tariff_id": _int(1, 2**31 - 1),
        "starts_on": _date(),
        "ends_on": _date(),
        "logins_limit": _int(1, 1000),
        "paid": _bool,
        "trial": _bool,
        "note": _text(500),
    },
    "ntrip_logins": {
        "client_id": _int(1, 2**31 - 1, nullable=True),
        "login": _text(32, r"[A-Za-z0-9_.@-]{2,32}", "латинские буквы, цифры и знаки _ . @ -, от 2 до 32"),
        "device": _text(120),
        "max_sessions": _int(1, 100),
        "on_limit": _enum("evict", "refuse"),
        "staff": _bool,
        "active": _bool,
    },
    "admins": {
        "login": _text(32, r"[A-Za-z0-9_.-]{2,32}", "латинские буквы, цифры и знаки _ . -, от 2 до 32"),
        "role": _enum("admin", "operator"),
        "full_name": _text(120),
        "active": _bool,
    },
}

REQUIRED = {
    "stations": ["code"],
    "mountpoints": ["name", "station_id"],
    "clients": ["name"],
    "tariffs": ["name", "period_days"],
    "subscriptions": ["client_id", "tariff_id", "starts_on", "ends_on"],
    "ntrip_logins": ["login"],
    "admins": ["login", "role"],
}

TITLES = {
    "subnets": "подсеть",
    "stations": "станция", "mountpoints": "точка подключения", "clients": "клиент", "tariffs": "тариф",
    "subscriptions": "подписка", "ntrip_logins": "логин", "admins": "администратор",
}

# Настройки, которые можно менять из панели: ключ -> (нижняя граница, верхняя, что это)
SETTINGS = {
    "trial_days": (1, 60, "срок пробного доступа, дней"),
    "expiring_days": (1, 60, "за сколько дней подписка считается истекающей"),
    "max_sessions_default": (1, 100, "одновременных сеансов на логин по умолчанию"),
    "station_lost_seconds": (5, 600, "сколько секунд сеанс держится без данных станции"),
    "nearest_max_km": (1, 1000, "предельное удаление ровера от ближайшей станции, км"),
    "session_keep_days": (1, 3650, "срок хранения журнала сеансов, дней"),
    "refusal_keep_days": (1, 3650, "срок хранения журнала отказов, дней"),
}


def clean(table: str, data: dict, partial: bool) -> dict:
    """Проверяет поля и отбрасывает незнакомые. partial — правка: проверяются только присланные."""
    if not isinstance(data, dict):
        raise Problem("Запрос должен быть набором полей.")
    out = {}
    for name, check in FIELDS[table].items():
        if name in data:
            out[name] = check(data[name], name)
        elif not partial and name in REQUIRED[table]:
            raise Problem(f"Не заполнено поле {name}.")
    for name in REQUIRED[table]:
        if name in out and out[name] in ("", None):
            raise Problem(f"Поле {name} не может быть пустым.")
    return out


def _jsonable(row: dict | None) -> dict | None:
    if row is None:
        return None
    out = {}
    for key, value in row.items():
        if isinstance(value, decimal.Decimal):
            out[key] = float(value)
        elif isinstance(value, (dt.datetime, dt.date)):
            out[key] = value.isoformat()
        else:
            out[key] = value
    return out


def subscription_state(row: dict, today: dt.date, expiring_days: int) -> str:
    """Состояние подписки по датам и отметкам."""
    if row["suspended"]:
        return "suspended"
    if row["ends_on"] < today:
        return "expired"
    if not (row["paid"] or row["trial"]):
        return "request"
    if row["starts_on"] > today:
        return "pending"
    if (row["ends_on"] - today).days <= expiring_days:
        return "expiring"
    return "trial" if row["trial"] and not row["paid"] else "active"


# Состояния, при которых раздача логинам клиента разрешена
OPEN_STATES = {"trial", "active", "expiring"}


class Store:
    def __init__(self, db: Database, vault: security.Vault):
        self.db = db
        self.vault = vault

    # ---------- Общие операции ----------

    def _audit(self, conn, who: dict | None, action: str, entity: str = "", entity_id: Any = "", details: dict | None = None):
        conn.execute(
            "INSERT INTO audit_log (admin_login, action, entity, entity_id, details, ip) VALUES (%s, %s, %s, %s, %s, %s)",
            ((who or {}).get("login", ""), action, entity, str(entity_id), Jsonb(details or {}), (who or {}).get("ip", "")),
        )

    @staticmethod
    def _friendly(exc: psycopg.Error, table: str) -> Problem:
        title = TITLES.get(table, "запись")
        if isinstance(exc, psycopg.errors.UniqueViolation):
            return Problem(f"Такая запись уже есть: {title} с этим именем или кодом заведена раньше.", 409)
        # Запрет удаления по связи приходит отдельным видом ошибки (ON DELETE RESTRICT)
        if isinstance(exc, (psycopg.errors.ForeignKeyViolation, psycopg.errors.RestrictViolation)):
            return Problem("Запись связана с другими: сначала уберите то, что на неё ссылается, либо укажите существующую связанную запись.", 409)
        if isinstance(exc, psycopg.errors.CheckViolation):
            return Problem(f"Данные не проходят проверку базы: {exc.diag.constraint_name or 'ограничение'}.", 400)
        return Problem("База данных отклонила запись.", 400)

    def _insert(self, conn, table: str, data: dict) -> dict:
        cols = list(data)
        query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
            sql.Identifier(table), sql.SQL(", ").join(map(sql.Identifier, cols)), sql.SQL(", ").join(sql.Placeholder() * len(cols)))
        try:
            return conn.execute(query, [data[c] for c in cols]).fetchone()
        except psycopg.Error as exc:
            raise self._friendly(exc, table) from exc

    def _update(self, conn, table: str, row_id: int, data: dict) -> dict:
        if not data:
            row = conn.execute(sql.SQL("SELECT * FROM {} WHERE id = %s").format(sql.Identifier(table)), (row_id,)).fetchone()
        else:
            sets = sql.SQL(", ").join(sql.SQL("{} = {}").format(sql.Identifier(c), sql.Placeholder()) for c in data)
            query = sql.SQL("UPDATE {} SET {} WHERE id = %s RETURNING *").format(sql.Identifier(table), sets)
            try:
                row = conn.execute(query, [*data.values(), row_id]).fetchone()
            except psycopg.Error as exc:
                raise self._friendly(exc, table) from exc
        if row is None:
            raise Problem(f"Нет такой записи: {TITLES.get(table, table)} №{row_id}.", 404)
        return row

    def _delete(self, conn, table: str, row_id: int) -> dict:
        try:
            row = conn.execute(sql.SQL("DELETE FROM {} WHERE id = %s RETURNING *").format(sql.Identifier(table)), (row_id,)).fetchone()
        except psycopg.Error as exc:
            raise self._friendly(exc, table) from exc
        if row is None:
            raise Problem(f"Нет такой записи: {TITLES.get(table, table)} №{row_id}.", 404)
        return row

    def _setting(self, conn, key: str) -> int:
        row = conn.execute("SELECT value FROM settings WHERE key = %s", (key,)).fetchone()
        return int(row["value"]) if row else SETTINGS[key][0]

    # ---------- Администраторы и вход ----------

    def create_admin(self, who: dict | None, data: dict) -> dict:
        fields = clean("admins", data, partial=False)
        password = data.get("password") or ""
        if len(password) < security.MIN_ADMIN_PASSWORD:
            raise Problem(f"Пароль администратора — не короче {security.MIN_ADMIN_PASSWORD} знаков.")
        fields["password_hash"], fields["salt"] = security.hash_password(password)
        with self.db.transaction() as conn:
            row = self._insert(conn, "admins", fields)
            self._audit(conn, who, "создан", "admins", row["id"], {"login": row["login"], "role": row["role"]})
        return self._admin_view(row)

    @staticmethod
    def _admin_view(row: dict) -> dict:
        return _jsonable({k: v for k, v in row.items() if k not in ("password_hash", "salt")})

    def list_admins(self) -> list[dict]:
        with self.db.connection() as conn:
            return [self._admin_view(r) for r in conn.execute("SELECT * FROM admins ORDER BY login")]

    def update_admin(self, who: dict, admin_id: int, data: dict) -> dict:
        fields = clean("admins", data, partial=True)
        fields.pop("login", None)  # логин не меняется: по нему ведётся журнал действий
        if "password" in data and data["password"]:
            if len(data["password"]) < security.MIN_ADMIN_PASSWORD:
                raise Problem(f"Пароль администратора — не короче {security.MIN_ADMIN_PASSWORD} знаков.")
            fields["password_hash"], fields["salt"] = security.hash_password(data["password"])
        with self.db.transaction() as conn:
            before = conn.execute("SELECT * FROM admins WHERE id = %s FOR UPDATE", (admin_id,)).fetchone()
            if before is None:
                raise Problem(f"Нет такого администратора: №{admin_id}.", 404)
            losing = before["role"] == "admin" and before["active"] and (fields.get("role", "admin") != "admin" or fields.get("active") is False)
            if losing and self._other_admins(conn, admin_id) == 0:
                raise Problem("Это единственный действующий администратор: снять с него права или отключить его нельзя.", 409)
            row = self._update(conn, "admins", admin_id, fields)
            if "password_hash" in fields or fields.get("active") is False:
                # Смена пароля и отключение закрывают все открытые сеансы панели
                conn.execute("DELETE FROM admin_sessions WHERE admin_id = %s", (admin_id,))
            self._audit(conn, who, "изменён", "admins", admin_id,
                        {"fields": sorted(k for k in fields if k not in ("password_hash", "salt")), "password": "password_hash" in fields})
        return self._admin_view(row)

    @staticmethod
    def _other_admins(conn, admin_id: int) -> int:
        return conn.execute("SELECT count(*) AS n FROM admins WHERE role = 'admin' AND active AND id <> %s", (admin_id,)).fetchone()["n"]

    def delete_admin(self, who: dict, admin_id: int) -> None:
        if who.get("id") == admin_id:
            raise Problem("Удалить самого себя нельзя.", 409)
        with self.db.transaction() as conn:
            if self._other_admins(conn, admin_id) == 0:
                raise Problem("Это единственный действующий администратор: удалить его нельзя.", 409)
            row = self._delete(conn, "admins", admin_id)
            self._audit(conn, who, "удалён", "admins", admin_id, {"login": row["login"]})

    def login(self, login: str, password: str, ip: str) -> tuple[str, dict]:
        with self.db.connection() as conn:
            row = conn.execute("SELECT * FROM admins WHERE login = %s", (str(login),)).fetchone()
        # Проверка выполняется и для несуществующего логина: по времени ответа их не различить
        ok = security.verify_password(password, row["password_hash"], row["salt"]) if row else security.verify_password(password, "0" * 64, "00" * 16)
        if not row or not ok or not row["active"]:
            # Неудача записывается своей транзакцией: отказ во входе не должен её откатить
            with self.db.transaction() as conn:
                self._audit(conn, {"login": str(login)[:32], "ip": ip}, "неудачный вход")
            raise Problem("Неверный логин или пароль.", 401)
        with self.db.transaction() as conn:
            token, digest = security.new_token()
            conn.execute("DELETE FROM admin_sessions WHERE expires_at < now()")
            conn.execute("INSERT INTO admin_sessions (token_hash, admin_id, expires_at, ip) VALUES (%s, %s, now() + %s, %s)",
                         (digest, row["id"], dt.timedelta(hours=SESSION_HOURS), ip))
            conn.execute("UPDATE admins SET last_login_at = now() WHERE id = %s", (row["id"],))
            self._audit(conn, {"login": row["login"], "ip": ip}, "вход")
        return token, self._admin_view(row)

    def who(self, token: str | None) -> dict | None:
        if not token:
            return None
        with self.db.connection() as conn:
            row = conn.execute(
                "SELECT a.* FROM admin_sessions s JOIN admins a ON a.id = s.admin_id "
                "WHERE s.token_hash = %s AND s.expires_at > now() AND a.active", (security.token_hash(token),)).fetchone()
        return self._admin_view(row) if row else None

    def logout(self, token: str | None) -> None:
        if token:
            with self.db.connection() as conn:
                conn.execute("DELETE FROM admin_sessions WHERE token_hash = %s", (security.token_hash(token),))

    def has_admins(self) -> bool:
        with self.db.connection() as conn:
            return conn.execute("SELECT EXISTS (SELECT 1 FROM admins WHERE active) AS yes").fetchone()["yes"]

    # ---------- Станции ----------

    def _station_view(self, row: dict) -> dict:
        out = _jsonable(row)
        out["has_source_password"] = bool(out.pop("source_password_enc"))
        out["has_station_password"] = bool(out.pop("station_password_enc"))
        return out

    @staticmethod
    def _check_position(fields: dict, current: dict | None = None) -> None:
        xyz = [fields.get(k, (current or {}).get(k)) for k in "xyz"]
        if all(v is None for v in xyz):
            return
        if any(v is None for v in xyz):
            raise Problem("Координаты задаются тремя числами сразу: X, Y и Z.")
        radius = math.sqrt(sum(float(v) ** 2 for v in xyz))
        if not 6.33e6 <= radius <= 6.40e6:
            raise Problem(f"Координаты не похожи на точку на поверхности Земли: расстояние до центра {radius / 1000:.1f} км, должно быть около 6 371.")

    def _station_secrets(self, fields: dict, data: dict) -> None:
        # Пустая строка стирает пароль, отсутствие поля оставляет прежний
        if "source_password" in data:
            fields["source_password_enc"] = self.vault.encrypt(str(data["source_password"] or ""))
        if "station_password" in data:
            value = str(data["station_password"] or "")
            if value and not re.fullmatch(r"[\x21-\x7e]{4,64}", value):
                raise Problem("Пароль станции: от 4 до 64 знаков, латиница, цифры и знаки без пробелов.")
            fields["station_password_enc"] = self.vault.encrypt(value)

    @staticmethod
    def _check_source(row: dict) -> None:
        mode = row["source_mode"]
        if mode in ("ntrip", "tcp") and not row["source_host"]:
            raise Problem("У источника не указан адрес.")
        if mode in ("ntrip", "tcp", "listen") and not row["source_port"]:
            raise Problem("У источника не указан порт.")
        if mode == "ntrip" and not row["source_mountpoint"]:
            raise Problem("У источника NTRIP не указана точка подключения.")
        if mode == "sim" and row["x"] is None:
            raise Problem("Имитатору нужны координаты станции.")

    def list_stations(self) -> list[dict]:
        with self.db.connection() as conn:
            rows = conn.execute(
                "SELECT s.*, COALESCE((SELECT array_agg(m.name ORDER BY m.name) FROM mountpoints m WHERE m.station_id = s.id), '{}') AS mountpoints "
                "FROM stations s ORDER BY s.code").fetchall()
        return [self._station_view(r) for r in rows]

    def get_station(self, station_id: int) -> dict:
        with self.db.connection() as conn:
            row = conn.execute("SELECT * FROM stations WHERE id = %s", (station_id,)).fetchone()
            if row is None:
                raise Problem(f"Нет такой станции: №{station_id}.", 404)
            history = conn.execute("SELECT * FROM station_coords WHERE station_id = %s ORDER BY valid_from DESC, id DESC LIMIT 50", (station_id,)).fetchall()
        out = self._station_view(row)
        out["coords_history"] = [_jsonable(h) for h in history]
        return out

    def create_station(self, who: dict, data: dict) -> dict:
        fields = clean("stations", data, partial=False)
        self._check_position(fields)
        self._station_secrets(fields, data)
        with self.db.transaction() as conn:
            row = self._insert(conn, "stations", fields)
            try:
                self._check_source(row)
            except Problem:
                raise
            if row["x"] is not None:
                self._coords(conn, who, row, data.get("coords_note", "первая запись"))
            self._audit(conn, who, "создана", "stations", row["id"], {"code": row["code"], "source": row["source_mode"]})
        return self._station_view(row)

    def _coords(self, conn, who: dict, row: dict, note: str) -> None:
        conn.execute("INSERT INTO station_coords (station_id, x, y, z, antenna_height, author, note) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                     (row["id"], row["x"], row["y"], row["z"], row["antenna_height"], who.get("login", ""), str(note or "")[:200]))

    def update_station(self, who: dict, station_id: int, data: dict) -> dict:
        fields = clean("stations", data, partial=True)
        self._station_secrets(fields, data)
        with self.db.transaction() as conn:
            before = conn.execute("SELECT * FROM stations WHERE id = %s FOR UPDATE", (station_id,)).fetchone()
            if before is None:
                raise Problem(f"Нет такой станции: №{station_id}.", 404)
            self._check_position(fields, before)
            moved = any(k in fields and fields[k] != before[k] for k in ("x", "y", "z", "antenna_height"))
            if moved and before["x"] is not None and fields.get("x", before["x"]) is not None:
                shift = math.sqrt(sum((float(fields.get(k, before[k])) - float(before[k])) ** 2 for k in "xyz"))
                # Сдвиг больше 10 м — почти наверняка ошибка ввода: требуем отдельного подтверждения
                if shift > 10 and not data.get("confirm_shift"):
                    raise Problem(f"Новые координаты отличаются от прежних на {shift:.1f} м. Если это не ошибка, подтвердите изменение отдельно.", 409)
            fields["updated_at"] = dt.datetime.now(dt.timezone.utc)
            row = self._update(conn, "stations", station_id, fields)
            self._check_source(row)
            if moved and row["x"] is not None:
                self._coords(conn, who, row, data.get("coords_note", ""))
            changed = sorted(k for k in fields if k not in ("updated_at", "source_password_enc", "station_password_enc"))
            self._audit(conn, who, "изменена", "stations", station_id,
                        {"code": row["code"], "fields": changed, "coords": moved,
                         "source_password": "source_password_enc" in fields, "station_password": "station_password_enc" in fields})
        return self._station_view(row)

    def set_stations_enabled(self, who: dict, enabled: bool) -> dict:
        """Остановить или возобновить приём по всей сети разом."""
        with self.db.transaction() as conn:
            rows = conn.execute("UPDATE stations SET enabled = %s, updated_at = now() WHERE enabled <> %s RETURNING code", (enabled, enabled)).fetchall()
            if rows:
                self._audit(conn, who, "приём по сети возобновлён" if enabled else "приём по сети остановлен", "stations", "", {"stations": sorted(r["code"] for r in rows)})
        return {"changed": len(rows), "enabled": enabled}

    def delete_station(self, who: dict, station_id: int) -> None:
        with self.db.transaction() as conn:
            row = self._delete(conn, "stations", station_id)
            self._audit(conn, who, "удалена", "stations", station_id, {"code": row["code"]})

    # ---------- Точки подключения ----------

    def list_mountpoints(self) -> list[dict]:
        with self.db.connection() as conn:
            rows = conn.execute("SELECT m.*, s.code AS station_code, s.name AS station_name, s.enabled AS station_enabled "
                                "FROM mountpoints m JOIN stations s ON s.id = m.station_id ORDER BY m.name").fetchall()
        return [_jsonable(r) for r in rows]

    def save_mountpoint(self, who: dict, data: dict, row_id: int | None = None) -> dict:
        fields = clean("mountpoints", data, partial=row_id is not None)
        with self.db.transaction() as conn:
            row = self._insert(conn, "mountpoints", fields) if row_id is None else self._update(conn, "mountpoints", row_id, fields)
            self._audit(conn, who, "создана" if row_id is None else "изменена", "mountpoints", row["id"], {"name": row["name"], "fields": sorted(fields)})
        return _jsonable(row)

    def delete_mountpoint(self, who: dict, row_id: int) -> None:
        with self.db.transaction() as conn:
            row = self._delete(conn, "mountpoints", row_id)
            self._audit(conn, who, "удалена", "mountpoints", row_id, {"name": row["name"]})

    # ---------- Клиенты ----------

    def list_clients(self, search: str = "") -> list[dict]:
        like = f"%{search.strip()}%"
        with self.db.connection() as conn:
            expiring = self._setting(conn, "expiring_days")
            rows = conn.execute(
                "SELECT c.*, (SELECT count(*) FROM ntrip_logins l WHERE l.client_id = c.id) AS logins "
                "FROM clients c WHERE %s = '%%' OR c.name ILIKE %s OR c.inn ILIKE %s OR c.email ILIKE %s OR c.contact ILIKE %s "
                "OR EXISTS (SELECT 1 FROM ntrip_logins l WHERE l.client_id = c.id AND l.login ILIKE %s) ORDER BY c.name",
                (like, like, like, like, like, like)).fetchall()
            subs = conn.execute("SELECT * FROM subscriptions ORDER BY ends_on DESC").fetchall()
        today = dt.date.today()
        best: dict[int, dict] = {}
        for s in subs:
            state = subscription_state(s, today, expiring)
            cur = best.get(s["client_id"])
            # Показываем самую «живую» подписку клиента
            if cur is None or (state in OPEN_STATES and cur["state"] not in OPEN_STATES):
                best[s["client_id"]] = {"state": state, "ends_on": s["ends_on"].isoformat()}
        out = []
        for r in rows:
            item = _jsonable(r)
            item["subscription"] = best.get(r["id"])
            out.append(item)
        return out

    def get_client(self, client_id: int) -> dict:
        with self.db.connection() as conn:
            row = conn.execute("SELECT * FROM clients WHERE id = %s", (client_id,)).fetchone()
            if row is None:
                raise Problem(f"Нет такого клиента: №{client_id}.", 404)
        out = _jsonable(row)
        out["logins"] = self.list_logins(client_id=client_id)
        out["subscriptions"] = self.list_subscriptions(client_id=client_id)
        return out

    def save_client(self, who: dict, data: dict, row_id: int | None = None) -> dict:
        fields = clean("clients", data, partial=row_id is not None)
        with self.db.transaction() as conn:
            row = self._insert(conn, "clients", fields) if row_id is None else self._update(conn, "clients", row_id, fields)
            self._audit(conn, who, "создан" if row_id is None else "изменён", "clients", row["id"], {"name": row["name"], "fields": sorted(fields)})
        return _jsonable(row)

    def delete_client(self, who: dict, row_id: int) -> None:
        with self.db.transaction() as conn:
            row = self._delete(conn, "clients", row_id)
            self._audit(conn, who, "удалён", "clients", row_id, {"name": row["name"]})

    # ---------- Тарифы ----------

    def list_tariffs(self) -> list[dict]:
        with self.db.connection() as conn:
            rows = conn.execute(
                "SELECT t.*, COALESCE((SELECT array_agg(tm.mountpoint_id ORDER BY tm.mountpoint_id) FROM tariff_mountpoints tm WHERE tm.tariff_id = t.id), '{}') AS mountpoint_ids, "
                "(SELECT count(*) FROM subscriptions s WHERE s.tariff_id = t.id) AS subscriptions FROM tariffs t ORDER BY t.name").fetchall()
        return [_jsonable(r) for r in rows]

    def save_tariff(self, who: dict, data: dict, row_id: int | None = None) -> dict:
        fields = clean("tariffs", data, partial=row_id is not None)
        points = data.get("mountpoint_ids")
        if points is not None and (not isinstance(points, list) or not all(isinstance(p, int) and not isinstance(p, bool) for p in points)):
            raise Problem("Точки тарифа: список номеров точек подключения.")
        with self.db.transaction() as conn:
            row = self._insert(conn, "tariffs", fields) if row_id is None else self._update(conn, "tariffs", row_id, fields)
            if points is not None:
                conn.execute("DELETE FROM tariff_mountpoints WHERE tariff_id = %s", (row["id"],))
                try:
                    for p in sorted(set(points)):
                        conn.execute("INSERT INTO tariff_mountpoints (tariff_id, mountpoint_id) VALUES (%s, %s)", (row["id"], p))
                except psycopg.Error as exc:
                    raise Problem("В списке точек тарифа есть несуществующая точка подключения.") from exc
            self._audit(conn, who, "создан" if row_id is None else "изменён", "tariffs", row["id"], {"name": row["name"], "fields": sorted(fields)})
        return next(t for t in self.list_tariffs() if t["id"] == row["id"])

    def delete_tariff(self, who: dict, row_id: int) -> None:
        with self.db.transaction() as conn:
            row = self._delete(conn, "tariffs", row_id)
            self._audit(conn, who, "удалён", "tariffs", row_id, {"name": row["name"]})

    # ---------- Подписки ----------

    def list_subscriptions(self, client_id: int | None = None, state: str | None = None) -> list[dict]:
        with self.db.connection() as conn:
            expiring = self._setting(conn, "expiring_days")
            rows = conn.execute(
                "SELECT s.*, c.name AS client_name, t.name AS tariff_name FROM subscriptions s "
                "JOIN clients c ON c.id = s.client_id JOIN tariffs t ON t.id = s.tariff_id "
                "WHERE %s::int IS NULL OR s.client_id = %s ORDER BY s.ends_on DESC, s.id DESC", (client_id, client_id)).fetchall()
        today = dt.date.today()
        out = []
        for r in rows:
            item = _jsonable(r)
            item["state"] = subscription_state(r, today, expiring)
            item["days_left"] = (r["ends_on"] - today).days
            if state is None or item["state"] == state:
                out.append(item)
        return out

    def save_subscription(self, who: dict, data: dict, row_id: int | None = None) -> dict:
        fields = clean("subscriptions", data, partial=row_id is not None)
        with self.db.transaction() as conn:
            row = self._insert(conn, "subscriptions", fields) if row_id is None else self._update(conn, "subscriptions", row_id, fields)
            self._audit(conn, who, "создана" if row_id is None else "изменена", "subscriptions", row["id"],
                        {"client_id": row["client_id"], "ends_on": row["ends_on"].isoformat(), "fields": sorted(fields)})
        return next(s for s in self.list_subscriptions(client_id=row["client_id"]) if s["id"] == row["id"])

    def trial_subscription(self, who: dict, client_id: int, tariff_id: int) -> dict:
        """Пробный доступ на срок из настроек: его может выдать и оператор."""
        with self.db.connection() as conn:
            days = self._setting(conn, "trial_days")
        today = dt.date.today()
        return self.save_subscription(who, {"client_id": client_id, "tariff_id": tariff_id, "starts_on": today.isoformat(),
                                            "ends_on": (today + dt.timedelta(days=days)).isoformat(), "trial": True, "paid": False, "note": "пробный доступ"})

    def extend_subscription(self, who: dict, row_id: int, days: int | None = None, paid: bool | None = None) -> dict:
        with self.db.transaction() as conn:
            row = conn.execute("SELECT s.*, t.period_days FROM subscriptions s JOIN tariffs t ON t.id = s.tariff_id WHERE s.id = %s FOR UPDATE OF s", (row_id,)).fetchone()
            if row is None:
                raise Problem(f"Нет такой подписки: №{row_id}.", 404)
            add = _int(1, 3660)(days if days is not None else row["period_days"], "days")
            # Истёкшая подписка продлевается от сегодняшнего дня, действующая — от своей даты конца
            start = max(row["ends_on"], dt.date.today())
            fields = {"ends_on": start + dt.timedelta(days=add)}
            if paid is not None:
                fields["paid"] = _bool(paid, "paid")
            new = self._update(conn, "subscriptions", row_id, fields)
            self._audit(conn, who, "продлена", "subscriptions", row_id, {"days": add, "ends_on": new["ends_on"].isoformat(), "paid": new["paid"]})
        return next(s for s in self.list_subscriptions(client_id=new["client_id"]) if s["id"] == row_id)

    def suspend_subscription(self, who: dict, row_id: int, suspended: bool, reason: str = "") -> dict:
        reason = _text(300)(reason, "reason")
        if suspended and not reason:
            raise Problem("Укажите причину приостановки: она записывается в журнал и видна клиенту.")
        with self.db.transaction() as conn:
            row = self._update(conn, "subscriptions", row_id, {"suspended": bool(suspended), "suspend_reason": reason if suspended else ""})
            self._audit(conn, who, "приостановлена" if suspended else "возобновлена", "subscriptions", row_id, {"reason": reason})
        return next(s for s in self.list_subscriptions(client_id=row["client_id"]) if s["id"] == row_id)

    def delete_subscription(self, who: dict, row_id: int) -> None:
        with self.db.transaction() as conn:
            row = self._delete(conn, "subscriptions", row_id)
            self._audit(conn, who, "удалена", "subscriptions", row_id, {"client_id": row["client_id"]})

    # ---------- Логины NTRIP ----------

    @staticmethod
    def _login_view(row: dict) -> dict:
        out = _jsonable(row)
        out.pop("password_enc", None)
        return out

    def list_logins(self, client_id: int | None = None, search: str = "") -> list[dict]:
        like = f"%{search.strip()}%"
        with self.db.connection() as conn:
            rows = conn.execute(
                "SELECT l.*, c.name AS client_name FROM ntrip_logins l LEFT JOIN clients c ON c.id = l.client_id "
                "WHERE (%s::int IS NULL OR l.client_id = %s) AND (%s = '%%' OR l.login ILIKE %s OR l.device ILIKE %s) ORDER BY l.login",
                (client_id, client_id, like, like, like)).fetchall()
        return [self._login_view(r) for r in rows]

    def create_login(self, who: dict, data: dict) -> dict:
        fields = clean("ntrip_logins", data, partial=False)
        password = str(data.get("password") or "") or security.generate_ntrip_password()
        self._check_ntrip_password(password)
        fields["password_enc"] = self.vault.encrypt(password)
        if not fields.get("staff") and not fields.get("client_id"):
            raise Problem("Обычный логин заводится у клиента; без клиента бывают только служебные логины.")
        with self.db.transaction() as conn:
            if fields.get("client_id") and not fields.get("staff"):
                self._check_logins_limit(conn, fields["client_id"])
            row = self._insert(conn, "ntrip_logins", fields)
            self._audit(conn, who, "создан", "ntrip_logins", row["id"], {"login": row["login"], "client_id": row["client_id"], "staff": row["staff"]})
        out = self._login_view(row)
        out["password"] = password  # показывается один раз, при создании
        return out

    @staticmethod
    def _check_ntrip_password(password: str) -> None:
        if not re.fullmatch(r"[\x21-\x7e]{4,32}", password) or ":" in password:
            raise Problem("Пароль NTRIP: от 4 до 32 знаков, латиница, цифры и знаки без пробелов и двоеточия.")

    def _check_logins_limit(self, conn, client_id: int) -> None:
        expiring = self._setting(conn, "expiring_days")
        today = dt.date.today()
        subs = conn.execute("SELECT * FROM subscriptions WHERE client_id = %s", (client_id,)).fetchall()
        limit = max((s["logins_limit"] for s in subs if subscription_state(s, today, expiring) in OPEN_STATES | {"request", "pending"}), default=None)
        if limit is None:
            return  # подписки ещё нет: логин можно завести заранее, работать он начнёт с подпиской
        have = conn.execute("SELECT count(*) AS n FROM ntrip_logins WHERE client_id = %s AND NOT staff", (client_id,)).fetchone()["n"]
        if have >= limit:
            raise Problem(f"У клиента уже {have} логинов, а подписка разрешает {limit}. Увеличьте число логинов в подписке.", 409)

    def update_login(self, who: dict, row_id: int, data: dict) -> dict:
        fields = clean("ntrip_logins", data, partial=True)
        fields.pop("login", None)  # имя логина не меняется: по нему ведётся журнал сеансов
        if data.get("password"):
            self._check_ntrip_password(str(data["password"]))
            fields["password_enc"] = self.vault.encrypt(str(data["password"]))
        with self.db.transaction() as conn:
            row = self._update(conn, "ntrip_logins", row_id, fields)
            self._audit(conn, who, "изменён", "ntrip_logins", row_id,
                        {"login": row["login"], "fields": sorted(k for k in fields if k != "password_enc"), "password": "password_enc" in fields})
        return self._login_view(row)

    def reveal_login_password(self, who: dict, row_id: int) -> dict:
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM ntrip_logins WHERE id = %s", (row_id,)).fetchone()
            if row is None:
                raise Problem(f"Нет такого логина: №{row_id}.", 404)
            self._audit(conn, who, "показан пароль", "ntrip_logins", row_id, {"login": row["login"]})
        return {"id": row_id, "login": row["login"], "password": self.vault.decrypt(row["password_enc"])}

    def regenerate_login_password(self, who: dict, row_id: int) -> dict:
        password = security.generate_ntrip_password()
        with self.db.transaction() as conn:
            row = self._update(conn, "ntrip_logins", row_id, {"password_enc": self.vault.encrypt(password)})
            self._audit(conn, who, "сменён пароль", "ntrip_logins", row_id, {"login": row["login"]})
        return {"id": row_id, "login": row["login"], "password": password}

    def delete_login(self, who: dict, row_id: int) -> None:
        with self.db.transaction() as conn:
            row = self._delete(conn, "ntrip_logins", row_id)
            self._audit(conn, who, "удалён", "ntrip_logins", row_id, {"login": row["login"]})

    # ---------- Журналы ----------

    def list_sessions(self, login: str = "", mountpoint: str = "", date_from: str = "", date_to: str = "",
                      open_only: bool = False, limit: int = 200, offset: int = 0) -> dict:
        where, args = ["true"], []
        if login:
            where.append("login = %s")
            args.append(login)
        if mountpoint:
            where.append("mountpoint = %s")
            args.append(mountpoint)
        if date_from:
            where.append("started_at >= %s")
            args.append(_date()(date_from, "from"))
        if date_to:
            where.append("started_at < %s")
            args.append(_date()(date_to, "to") + dt.timedelta(days=1))
        if open_only:
            where.append("ended_at IS NULL")
        limit = _int(1, 1000)(limit, "limit")
        offset = _int(0, 10**9)(offset, "offset")
        cond = " AND ".join(where)
        with self.db.connection() as conn:
            total = conn.execute(f"SELECT count(*) AS n FROM sessions WHERE {cond}", args).fetchone()["n"]
            rows = conn.execute(f"SELECT * FROM sessions WHERE {cond} ORDER BY started_at DESC, id DESC LIMIT %s OFFSET %s", [*args, limit, offset]).fetchall()
        return {"total": total, "items": [_jsonable(r) for r in rows]}

    def list_refusals(self, login: str = "", limit: int = 200, offset: int = 0) -> dict:
        limit = _int(1, 1000)(limit, "limit")
        offset = _int(0, 10**9)(offset, "offset")
        with self.db.connection() as conn:
            total = conn.execute("SELECT count(*) AS n FROM refusals WHERE %s = '' OR login = %s", (login, login)).fetchone()["n"]
            rows = conn.execute("SELECT * FROM refusals WHERE %s = '' OR login = %s ORDER BY at DESC, id DESC LIMIT %s OFFSET %s", (login, login, limit, offset)).fetchall()
        return {"total": total, "items": [_jsonable(r) for r in rows]}

    def list_audit(self, admin: str = "", entity: str = "", limit: int = 200, offset: int = 0) -> dict:
        limit = _int(1, 1000)(limit, "limit")
        offset = _int(0, 10**9)(offset, "offset")
        with self.db.connection() as conn:
            cond = "(%s = '' OR admin_login = %s) AND (%s = '' OR entity = %s)"
            args = (admin, admin, entity, entity)
            total = conn.execute(f"SELECT count(*) AS n FROM audit_log WHERE {cond}", args).fetchone()["n"]
            rows = conn.execute(f"SELECT * FROM audit_log WHERE {cond} ORDER BY at DESC, id DESC LIMIT %s OFFSET %s", (*args, limit, offset)).fetchall()
        return {"total": total, "items": [_jsonable(r) for r in rows]}

    def note(self, who: dict, action: str, entity: str = "", entity_id: Any = "", details: dict | None = None) -> None:
        """Запись в журнал действий о том, что сделано не в базе: например, закрыт сеанс ровера."""
        with self.db.transaction() as conn:
            self._audit(conn, who, action, entity, entity_id, details)

    # ---------- Настройки ----------

    def get_settings(self) -> list[dict]:
        with self.db.connection() as conn:
            rows = {r["key"]: r for r in conn.execute("SELECT * FROM settings")}
        return [{"key": k, "value": int(rows[k]["value"]) if k in rows else low, "min": low, "max": high, "title": title,
                 "updated_at": rows[k]["updated_at"].isoformat() if k in rows else None} for k, (low, high, title) in SETTINGS.items()]

    def set_settings(self, who: dict, data: dict) -> list[dict]:
        if not isinstance(data, dict) or not data:
            raise Problem("Не прислано ни одной настройки.")
        changes = {}
        for key, value in data.items():
            if key not in SETTINGS:
                raise Problem(f"Нет такой настройки: {key}.")
            low, high, _ = SETTINGS[key]
            changes[key] = _int(low, high)(value, key)
        with self.db.transaction() as conn:
            for key, value in changes.items():
                conn.execute("INSERT INTO settings (key, value, updated_at) VALUES (%s, %s, now()) "
                             "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", (key, Jsonb(value)))
            self._audit(conn, who, "изменены", "settings", "", changes)
        return self.get_settings()

    # ---------- Сводка ----------

    def counts(self) -> dict:
        with self.db.connection() as conn:
            row = conn.execute(
                "SELECT (SELECT count(*) FROM stations) AS stations, (SELECT count(*) FROM stations WHERE enabled) AS stations_enabled, "
                "(SELECT count(*) FROM mountpoints) AS mountpoints, (SELECT count(*) FROM clients) AS clients, "
                "(SELECT count(*) FROM ntrip_logins) AS logins, (SELECT count(*) FROM ntrip_logins WHERE active) AS logins_active, "
                "(SELECT count(*) FROM sessions WHERE ended_at IS NULL) AS sessions_open, "
                "(SELECT count(*) FROM sessions WHERE started_at >= date_trunc('day', now())) AS sessions_today, "
                "(SELECT count(*) FROM refusals WHERE at >= now() - interval '24 hours') AS refusals_day").fetchone()
        out = dict(row)
        states: dict[str, int] = {}
        for s in self.list_subscriptions():
            states[s["state"]] = states.get(s["state"], 0) + 1
        out["subscriptions"] = states
        return out

    # ---------- Справочник для служб приёма и раздачи ----------

    def directory(self) -> dict:
        """Что должны знать приём и раздача: станции, точки и логины с правами.
        Содержит пароли в открытом виде — отдаётся только внутри машины и по ключу."""
        with self.db.connection() as conn:
            expiring = self._setting(conn, "expiring_days")
            stations = conn.execute("SELECT * FROM stations WHERE enabled ORDER BY code").fetchall()
            points = conn.execute("SELECT m.*, s.code AS station_code FROM mountpoints m JOIN stations s ON s.id = m.station_id WHERE s.enabled ORDER BY m.name").fetchall()
            logins = conn.execute("SELECT * FROM ntrip_logins ORDER BY login").fetchall()
            subs = conn.execute("SELECT s.*, t.all_mountpoints, t.max_sessions AS tariff_sessions FROM subscriptions s JOIN tariffs t ON t.id = s.tariff_id").fetchall()
            tariff_points = conn.execute("SELECT tm.tariff_id, m.name FROM tariff_mountpoints tm JOIN mountpoints m ON m.id = tm.mountpoint_id").fetchall()
            lost = self._setting(conn, "station_lost_seconds")
            accepted = {r["id"]: r["accepted"] for r in conn.execute("SELECT id, accepted FROM subnets")}
        today = dt.date.today()
        by_tariff: dict[int, list[str]] = {}
        for tp in tariff_points:
            by_tariff.setdefault(tp["tariff_id"], []).append(tp["name"])
        open_points = [p["name"] for p in points if p["access"] == "all"]
        all_points = [p["name"] for p in points]
        staff_logins = [row["login"] for row in logins if row["staff"] and row["active"]]

        # Права клиента — объединение всех его действующих подписок
        rights: dict[int, dict] = {}
        for s in subs:
            if subscription_state(s, today, expiring) not in OPEN_STATES:
                continue
            r = rights.setdefault(s["client_id"], {"points": set(), "ends": s["ends_on"], "sessions": 1})
            r["points"].update(open_points if s["all_mountpoints"] else [])
            r["points"].update(by_tariff.get(s["tariff_id"], []))
            r["ends"] = max(r["ends"], s["ends_on"])
            r["sessions"] = max(r["sessions"], s["tariff_sessions"])

        users = {}
        for row in logins:
            entry = {"password": self.vault.decrypt(row["password_enc"]), "maxSessions": row["max_sessions"], "onLimit": row["on_limit"], "active": row["active"]}
            if row["staff"]:
                entry["mountpoints"] = all_points
            else:
                r = rights.get(row["client_id"])
                if r is None:
                    # Подписки нет или она не действует: раздача ответит «подписка истекла»
                    entry["mountpoints"] = []
                    entry["expires"] = "2000-01-01"
                else:
                    entry["mountpoints"] = sorted(r["points"])
                    # Открытый сеанс дорабатывает до полуночи после даты конца (время Екатеринбурга)
                    entry["expires"] = dt.datetime.combine(r["ends"] + dt.timedelta(days=1), dt.time(0), dt.timezone(dt.timedelta(hours=5))).isoformat()
            users[row["login"]] = entry

        # Точка подсети раздаёт поток станции с координатами базы, принятыми в подсети.
        # Пока координаты не приняты, такой точки для раздачи нет: чужие координаты она не выдаст.
        def own_position(p: dict):
            if p["subnet_id"] is None:
                return None
            got = (accepted.get(p["subnet_id"]) or {}).get(p["station_code"])
            return [float(got["x"]), float(got["y"]), float(got["z"])] if got else None

        def station_source(s: dict) -> dict:
            src: dict[str, Any] = {"mode": s["source_mode"]}
            if s["source_mode"] in ("ntrip", "tcp"):
                src.update(host=s["source_host"], port=s["source_port"])
            if s["source_mode"] == "ntrip":
                src.update(mountpoint=s["source_mountpoint"], username=s["source_username"], password=self.vault.decrypt(s["source_password_enc"]))
            if s["source_mode"] == "listen":
                src.update(port=s["source_port"], allow=list(s["allow_addresses"]), stationPassword=self.vault.decrypt(s["station_password_enc"]))
            if s["source_mode"] == "sim":
                src.update(ecef=[float(s["x"]), float(s["y"]), float(s["z"])])
            return src

        return {
            "stations": [{"code": s["code"], "name": s["name"] or s["code"], "source": station_source(s),
                          "ecef": None if s["x"] is None else [float(s["x"]), float(s["y"]), float(s["z"])],
                          "antennaHeight": None if s["antenna_height"] is None else float(s["antenna_height"]),
                          "antennaType": s["antenna_type"], "receiverType": s["receiver_type"]} for s in stations],
            "mountpoints": [{"name": p["name"], "station": p["station_code"], "stationId": p["rtcm_station_id"], "listed": p["listed"],
                             "enabled": p["enabled"], "access": staff_logins if p["access"] == "staff" else None,
                             "position": own_position(p)} for p in points if p["subnet_id"] is None or own_position(p)],
            "users": users,
            "rules": {"stationLostMs": lost * 1000},
        }

    # ---------- События от службы раздачи ----------

    def record_events(self, events: list[dict]) -> int:
        """Сеансы и отказы, о которых сообщила раздача. Повторная доставка события ничего не портит."""
        if not isinstance(events, list):
            raise Problem("Ожидается список событий.")
        done = 0
        with self.db.transaction() as conn:
            for e in events[:5000]:
                kind = e.get("t")
                at = dt.datetime.fromtimestamp(float(e.get("at", 0)) / 1000, dt.timezone.utc)
                if kind == "open":
                    conn.execute(
                        "INSERT INTO sessions (caster_id, login, mountpoint, station, started_at, address, agent, ntrip_version) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (caster_id) WHERE caster_id <> '' DO NOTHING",
                        (str(e["id"]), str(e.get("login", ""))[:64], str(e.get("point", ""))[:64], str(e.get("station", ""))[:64], at,
                         str(e.get("address", ""))[:64], str(e.get("agent", ""))[:120], e.get("version")))
                    conn.execute("UPDATE ntrip_logins SET last_seen_at = %s WHERE login = %s", (at, str(e.get("login", ""))))
                elif kind in ("close", "update"):
                    pos = e.get("position") or {}
                    first = e.get("first") or {}
                    conn.execute(
                        "UPDATE sessions SET bytes = GREATEST(bytes, %s), last_lat = COALESCE(%s, last_lat), last_lon = COALESCE(%s, last_lon), "
                        "last_kind = COALESCE(NULLIF(%s, ''), last_kind), first_lat = COALESCE(first_lat, %s), first_lon = COALESCE(first_lon, %s), "
                        "ended_at = CASE WHEN %s THEN %s ELSE ended_at END, end_reason = CASE WHEN %s THEN %s ELSE end_reason END WHERE caster_id = %s",
                        (int(e.get("bytes", 0)), pos.get("lat"), pos.get("lon"), str(pos.get("kind", "")), first.get("lat"), first.get("lon"),
                         kind == "close", at, kind == "close", str(e.get("reason", ""))[:200], str(e["id"])))
                    if kind == "close":
                        conn.execute("UPDATE ntrip_logins SET last_seen_at = %s WHERE login = %s", (at, str(e.get("login", ""))))
                elif kind == "refusal":
                    conn.execute("INSERT INTO refusals (at, login, mountpoint, code, reason, address) VALUES (%s, %s, %s, %s, %s, %s)",
                                 (at, str(e.get("login") or "")[:64], str(e.get("point") or "")[:64], e.get("code"), str(e.get("reason", ""))[:200], str(e.get("address", ""))[:64]))
                    if e.get("login"):
                        conn.execute("UPDATE ntrip_logins SET last_refusal = %s WHERE login = %s", (str(e.get("reason", ""))[:200], str(e["login"])))
                else:
                    continue
                done += 1
        return done

    def close_stale_sessions(self, alive_ids: list[str]) -> int:
        """Сеансы, которых у раздачи уже нет (служба перезапускалась), закрываются в журнале."""
        with self.db.transaction() as conn:
            cur = conn.execute("UPDATE sessions SET ended_at = now(), end_reason = 'служба раздачи перезапущена' "
                               "WHERE ended_at IS NULL AND NOT (caster_id = ANY(%s))", (list(map(str, alive_ids)),))
            return cur.rowcount

    def cleanup(self) -> dict:
        """Удаляет записи журналов старше сроков из настроек."""
        with self.db.transaction() as conn:
            s = conn.execute("DELETE FROM sessions WHERE started_at < now() - make_interval(days => %s)", (self._setting(conn, "session_keep_days"),)).rowcount
            r = conn.execute("DELETE FROM refusals WHERE at < now() - make_interval(days => %s)", (self._setting(conn, "refusal_keep_days"),)).rowcount
            conn.execute("DELETE FROM admin_sessions WHERE expires_at < now()")
        return {"sessions": s, "refusals": r}

    def import_stations(self, who: dict, items: list[dict]) -> dict:
        """Заводит станции и по точке подключения на каждую, если их ещё нет. Существующие не трогает."""
        added = 0
        with self.db.transaction() as conn:
            have = {r["code"] for r in conn.execute("SELECT code FROM stations")}
            points = {r["name"] for r in conn.execute("SELECT name FROM mountpoints")}
            for item in items:
                fields = clean("stations", item, partial=False)
                if fields["code"] in have:
                    continue
                self._check_position(fields)
                row = self._insert(conn, "stations", fields)
                self._check_source(row)
                if row["x"] is not None:
                    self._coords(conn, who, row, "загрузка списком")
                if row["code"] not in points:
                    self._insert(conn, "mountpoints", {"name": row["code"], "station_id": row["id"]})
                added += 1
            if added:
                self._audit(conn, who, "загружены списком", "stations", "", {"added": added})
        return {"added": added, "skipped": len(items) - added}

    def import_caster(self, who: dict, host: str, port: int, username: str, password: str, mounts: list[dict]) -> dict:
        """Заводит станции по точкам действующего кастера: поток каждой берётся с него по NTRIP.
        Точка подключения у нас получает то же имя, что на кастере, — роверы не перенастраиваются.
        mounts: [{"name": имя точки на кастере, "title": название}]. Существующие станции не трогаются."""
        added, skipped = [], []
        secret = self.vault.encrypt(password)
        with self.db.transaction() as conn:
            have = {r["code"] for r in conn.execute("SELECT code FROM stations")}
            points = {r["name"] for r in conn.execute("SELECT name FROM mountpoints")}
            for m in mounts:
                # Код станции — имя точки без хвоста с типом выдачи: REFT_MSM4 -> REFT
                code = re.sub(r"_(MSM\d|RTCM\d+)$", "", m["name"], flags=re.I)
                if code in have or m["name"] in points:
                    skipped.append(m["name"])
                    continue
                fields = clean("stations", {"code": code, "name": m.get("title") or code, "source_mode": "ntrip", "source_host": host,
                                            "source_port": port, "source_mountpoint": m["name"], "source_username": username,
                                            "note": f"поток с кастера {host}:{port}"}, partial=False)
                fields["source_password_enc"] = secret
                row = self._insert(conn, "stations", fields)
                self._insert(conn, "mountpoints", {"name": m["name"], "station_id": row["id"]})
                have.add(code)
                points.add(m["name"])
                added.append(m["name"])
            if added:
                self._audit(conn, who, "загружены с кастера", "stations", "", {"caster": f"{host}:{port}", "added": added})
        return {"added": added, "skipped": skipped}

    def remove_testnet(self, who: dict) -> int:
        """Убирает станции тестовой сети вместе с их точками подключения."""
        with self.db.transaction() as conn:
            rows = conn.execute("DELETE FROM stations WHERE note LIKE 'тестовая сеть:%%' RETURNING code").fetchall()
            if rows:
                self._audit(conn, who, "убрана тестовая сеть", "stations", "", {"removed": len(rows)})
        return len(rows)

    # ---------- Подсети ----------

    @staticmethod
    def _subnet_fields(data: dict, partial: bool) -> dict:
        if not isinstance(data, dict):
            raise Problem("Запрос должен быть набором полей.")
        out: dict[str, Any] = {}
        if "name" in data or not partial:
            name = str(data.get("name") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9]{1,12}", name):
                raise Problem("Имя подсети: латинские буквы и цифры, до 12 знаков. С него начинаются имена её точек подключения.")
            out["name"] = name.upper()
        for key, limit in (("title", 80), ("note", 500)):
            if key in data:
                out[key] = str(data[key] or "").strip()[:limit]
        if "contour" in data:
            pts = data["contour"] or []
            ok = isinstance(pts, list) and len(pts) <= 200 and all(
                isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in p)
                and -90 <= p[0] <= 90 and -180 <= p[1] <= 180 for p in pts)
            if not ok or len(pts) in (1, 2):
                raise Problem("Контур — от трёх точек «широта, долгота», не больше двухсот.")
            out["contour"] = Jsonb([[round(float(p[0]), 7), round(float(p[1]), 7)] for p in pts])
        if "station_ids" in data:
            ids = data["station_ids"]
            if not isinstance(ids, list) or len(ids) > 500 or any(not isinstance(i, int) or isinstance(i, bool) or i < 1 for i in ids):
                raise Problem("Станции подсети — список их номеров.")
            out["station_ids"] = sorted(set(ids))
        if "reference_station_id" in data:
            ref = data["reference_station_id"]
            if ref is not None and (not isinstance(ref, int) or isinstance(ref, bool)):
                raise Problem("Опорная станция — номер станции.")
            out["reference_station_id"] = ref
        for key in ("ref_x", "ref_y", "ref_z"):
            if key in data:
                out[key] = _decimal(4, -7e6, 7e6)(data[key], key)
        return out

    def _subnet_view(self, row: dict, codes: dict[int, str], points: list[dict]) -> dict:
        out = _jsonable(row)
        out["stations"] = [codes[i] for i in row["station_ids"] if i in codes]
        out["reference"] = codes.get(row["reference_station_id"])
        out["mountpoints"] = [{"id": p["id"], "name": p["name"], "station": codes.get(p["station_id"]), "enabled": p["enabled"]}
                              for p in points if p["subnet_id"] == row["id"]]
        return out

    def list_subnets(self) -> list[dict]:
        with self.db.connection() as conn:
            rows = conn.execute("SELECT * FROM subnets ORDER BY name").fetchall()
            codes = {r["id"]: r["code"] for r in conn.execute("SELECT id, code FROM stations")}
            points = conn.execute("SELECT id, name, station_id, subnet_id, enabled FROM mountpoints WHERE subnet_id IS NOT NULL ORDER BY name").fetchall()
        return [self._subnet_view(r, codes, points) for r in rows]

    def _subnet(self, conn, subnet_id: int, lock: bool = False) -> dict:
        row = conn.execute("SELECT * FROM subnets WHERE id = %s" + (" FOR UPDATE" if lock else ""), (subnet_id,)).fetchone()
        if row is None:
            raise Problem(f"Нет такой подсети: №{subnet_id}.", 404)
        return row

    def _subnet_out(self, conn, row: dict) -> dict:
        codes = {r["id"]: r["code"] for r in conn.execute("SELECT id, code FROM stations")}
        points = conn.execute("SELECT id, name, station_id, subnet_id, enabled FROM mountpoints WHERE subnet_id = %s ORDER BY name", (row["id"],)).fetchall()
        return self._subnet_view(row, codes, points)

    def save_subnet(self, who: dict, data: dict, row_id: int | None = None) -> dict:
        fields = self._subnet_fields(data, partial=row_id is not None)
        with self.db.transaction() as conn:
            before = self._subnet(conn, row_id, lock=True) if row_id is not None else None
            # Состав и опора на ходу расчёта не меняются: результат относился бы к другой сети
            if before and before["calc_state"] == "running" and any(k in fields for k in ("station_ids", "reference_station_id", "ref_x", "ref_y", "ref_z")):
                raise Problem("Идёт расчёт. Чтобы изменить состав подсети или опорную станцию, сначала остановите его.", 409)
            if "station_ids" in fields:
                known = {r["id"] for r in conn.execute("SELECT id FROM stations WHERE id = ANY(%s)", (fields["station_ids"],))}
                if known != set(fields["station_ids"]):
                    raise Problem("В списке есть станция, которой нет в каталоге.")
            merged = {**(before or {}), **fields}
            ref = merged.get("reference_station_id")
            if ref is not None and ref not in (merged.get("station_ids") or []):
                raise Problem("Опорная станция должна входить в подсеть.")
            self._check_position({k[-1]: fields[k] for k in ("ref_x", "ref_y", "ref_z") if k in fields},
                                 {k[-1]: before[k] for k in ("ref_x", "ref_y", "ref_z")} if before else None)
            fields["updated_at"] = dt.datetime.now(dt.timezone.utc)
            row = self._insert(conn, "subnets", fields) if row_id is None else self._update(conn, "subnets", row_id, fields)
            self._audit(conn, who, "создана" if row_id is None else "изменена", "subnets", row["id"],
                        {"name": row["name"], "fields": sorted(k for k in fields if k != "updated_at")})
            return self._subnet_out(conn, row)

    def delete_subnet(self, who: dict, row_id: int) -> None:
        with self.db.transaction() as conn:
            row = self._delete(conn, "subnets", row_id)
            self._audit(conn, who, "удалена", "subnets", row_id, {"name": row["name"]})

    def subnet_calc(self, who: dict, row_id: int, run: bool, once: bool = False) -> dict:
        """Начать или остановить расчёт подсети. once — разовый расчёт («вычислить текущие
        координаты»): служба расчёта отвечает один раз, и расчёт считается выполненным."""
        with self.db.transaction() as conn:
            row = self._subnet(conn, row_id, lock=True)
            if run:
                if len(row["station_ids"]) < 2:
                    raise Problem("В подсети должно быть не меньше двух станций.")
                if row["reference_station_id"] is None or row["ref_x"] is None:
                    raise Problem("Выберите опорную станцию и введите её координаты X, Y, Z.")
                fields = {"calc_state": "running", "calc_once": once, "calc_started_at": dt.datetime.now(dt.timezone.utc), "results": Jsonb({}), "results_at": None}
            else:
                fields = {"calc_state": "stopped"}
            row = self._update(conn, "subnets", row_id, fields)
            self._audit(conn, who, ("вычисление текущих координат" if once else "расчёт начат") if run else "расчёт остановлен", "subnets", row_id, {"name": row["name"]})
            return self._subnet_out(conn, row)

    def subnet_accept(self, who: dict, row_id: int, codes: list | None = None) -> dict:
        """Принять рассчитанные координаты. codes — какие станции; без списка — все, у кого есть решение."""
        with self.db.transaction() as conn:
            row = self._subnet(conn, row_id, lock=True)
            got = (row["results"] or {}).get("stations") or {}
            accepted = dict(row["accepted"] or {})
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            done = []
            for code, r in got.items():
                if codes is not None and code not in codes:
                    continue
                if not isinstance(r, dict) or r.get("x") is None:
                    continue
                self._check_position({"x": r["x"], "y": r["y"], "z": r["z"]})
                accepted[code] = {k: r.get(k) for k in ("x", "y", "z", "quality", "sd", "spread", "from", "length_km", "minutes", "ratio")}
                accepted[code].update(at=now, by=who.get("login", ""), frame=row["frame"])
                done.append(code)
            if not done:
                raise Problem("Принимать нечего: решений по станциям пока нет.")
            row = self._update(conn, "subnets", row_id, {"accepted": Jsonb(accepted), "accepted_at": dt.datetime.now(dt.timezone.utc), "accepted_by": who.get("login", "")})
            self._audit(conn, who, "приняты координаты", "subnets", row_id,
                        {"name": row["name"], "stations": sorted(done), "quality": {c: accepted[c].get("quality") for c in sorted(done)}})
            return self._subnet_out(conn, row)

    def subnet_points(self, who: dict, row_id: int) -> dict:
        """Завести точки подключения подсети: по одной на станцию с принятыми координатами.
        Точка доступна только по тарифу, где она названа: подсеть выдаётся клиенту отдельно."""
        with self.db.transaction() as conn:
            row = self._subnet(conn, row_id, lock=True)
            stations = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM stations WHERE id = ANY(%s)", (row["station_ids"],))}
            have = {r["station_id"] for r in conn.execute("SELECT station_id FROM mountpoints WHERE subnet_id = %s", (row_id,))}
            added = []
            for code in sorted(row["accepted"] or {}):
                if code not in stations or stations[code] in have:
                    continue
                name = f"{row['name']}_{code}"[:32]
                self._insert(conn, "mountpoints", {"name": name, "station_id": stations[code], "subnet_id": row_id, "access": "tariff",
                                                   "note": f"подсеть {row['name']}: координаты базы из расчёта подсети"})
                added.append(name)
            if not added:
                raise Problem("Новых точек нет: точки заводятся для станций с принятыми координатами, и у этих они уже есть.")
            self._audit(conn, who, "созданы точки подсети", "subnets", row_id, {"name": row["name"], "points": added})
            return self._subnet_out(conn, row)

    def solver_tasks(self) -> list[dict]:
        """Что считать службе расчёта: подсети, у которых расчёт идёт."""
        with self.db.connection() as conn:
            rows = conn.execute("SELECT * FROM subnets WHERE calc_state = 'running' AND reference_station_id IS NOT NULL AND ref_x IS NOT NULL ORDER BY id").fetchall()
            codes = {r["id"]: r["code"] for r in conn.execute("SELECT id, code FROM stations")}
            # Типы антенн из каталога: с ними расчёт учитывает фазовые центры антенн станций
            antennas = {r["code"]: r["antenna_type"].strip() for r in conn.execute("SELECT code, antenna_type FROM stations WHERE btrim(antenna_type) <> ''")}
        return [{"id": r["id"], "name": r["name"], "startedAt": r["calc_started_at"].isoformat(), "once": r["calc_once"],
                 "antennas": {codes[i]: antennas[codes[i]] for i in r["station_ids"] if codes.get(i) in antennas}, "reference": codes.get(r["reference_station_id"]),
                 "ecef": [float(r["ref_x"]), float(r["ref_y"]), float(r["ref_z"])],
                 "stations": [codes[i] for i in r["station_ids"] if i in codes]} for r in rows if codes.get(r["reference_station_id"])]

    def solver_results(self, subnet_id: int, started_at: str, results: dict, final: bool = False) -> bool:
        """Ответ службы расчёта. Принимается, только если расчёт тот же самый и ещё идёт.
        final — разовый расчёт закончен: подсеть переходит в «выполнен»."""
        if not isinstance(results, dict) or len(dumps(results)) > 400_000:
            return False
        with self.db.transaction() as conn:
            row = conn.execute("SELECT calc_state, calc_started_at FROM subnets WHERE id = %s FOR UPDATE", (subnet_id,)).fetchone()
            if row is None or row["calc_state"] != "running" or row["calc_started_at"].isoformat() != started_at:
                return False
            conn.execute("UPDATE subnets SET results = %s, results_at = now(), calc_state = %s WHERE id = %s",
                         (Jsonb(results), "stopped" if final else "running", subnet_id))
        return True

    # ---------- Выгрузка ----------

    def export_subscriptions_csv(self) -> str:
        """Список подписок для бухгалтерии."""
        rows = self.list_subscriptions()
        names = {"request": "заявка", "pending": "ещё не началась", "trial": "пробная", "active": "действует",
                 "expiring": "истекает", "expired": "истекла", "suspended": "приостановлена"}
        lines = ["Клиент;Тариф;Начало;Конец;Состояние;Оплачено;Логинов"]
        for r in rows:
            cell = lambda v: '"' + str(v).replace('"', '""') + '"'  # noqa: E731
            lines.append(";".join([cell(r["client_name"]), cell(r["tariff_name"]), r["starts_on"], r["ends_on"], names[r["state"]],
                                   "да" if r["paid"] else "нет", str(r["logins_limit"])]))
        return "﻿" + "\r\n".join(lines) + "\r\n"


def dumps(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
