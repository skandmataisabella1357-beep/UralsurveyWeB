"""Модуль «Доступы»: один список — логин, чей он, до какого дня работает и сколько подключений держит.

Своих таблиц у модуля нет: он читает и правит те же клиенты, подписки и логины, что и разделы
панели, поэтому раздача о нём ничего не знает и работает как прежде.
"""
from __future__ import annotations

import datetime as dt
import re

from .store import OPEN_STATES, Problem, subscription_state

IMPORT_TARIFF = "Перенос из NRS"
LOGIN_RE = re.compile(r"[A-Za-z0-9_.@-]{2,32}")
# Переносимые пароли берутся как есть, даже короткие: иначе роверы клиентов перестанут подключаться
OLD_PASSWORD_RE = re.compile(r"[\x21-\x7e]{1,32}")


def _date(value, name: str) -> dt.date:
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        raise Problem(f"Дата «{name}»: нужен вид ГГГГ-ММ-ДД.") from None


def _weak(password: str, login: str) -> str:
    """Чем плох пароль: совпадает с логином или слишком короток. Сам пароль наружу не уходит."""
    if password.lower() == login.lower():
        return "same"
    return "short" if len(password) < 6 else ""


def _best(subs: list[dict], today: dt.date, expiring: int) -> dict | None:
    """Подписка, по которой клиент работает: действующая с самым дальним концом, иначе самая поздняя."""
    live = [s for s in subs if subscription_state(s, today, expiring) in OPEN_STATES]
    pool = live or subs
    return max(pool, key=lambda s: (s["ends_on"], s["id"])) if pool else None


def access_list(store) -> dict:
    with store.db.connection() as conn:
        expiring = store._setting(conn, "expiring_days")
        logins = conn.execute(
            "SELECT l.*, c.name AS client_name, c.phone AS client_phone, c.note AS client_note "
            "FROM ntrip_logins l LEFT JOIN clients c ON c.id = l.client_id ORDER BY lower(l.login)").fetchall()
        subs = conn.execute("SELECT s.*, t.name AS tariff_name FROM subscriptions s JOIN tariffs t ON t.id = s.tariff_id").fetchall()
    today = dt.date.today()
    by_client: dict[int, list[dict]] = {}
    for s in subs:
        by_client.setdefault(s["client_id"], []).append(s)
    rows = []
    counts: dict[str, int] = {}
    for row in logins:
        sub = None if row["staff"] else _best(by_client.get(row["client_id"], []), today, expiring)
        if row["staff"]:
            state = "staff" if row["active"] else "off"
        elif not row["active"]:
            state = "off"
        elif sub is None:
            state = "none"
        else:
            state = subscription_state(sub, today, expiring)
        counts[state] = counts.get(state, 0) + 1
        weak = _weak(store.vault.decrypt(row["password_enc"]), row["login"])
        if weak:
            counts["weak"] = counts.get("weak", 0) + 1
        rows.append({
            "id": row["id"], "login": row["login"], "state": state, "staff": row["staff"], "active": row["active"],
            "client_id": row["client_id"], "client": row["client_name"] or "", "phone": row["client_phone"] or "", "note": row["client_note"] or "",
            "device": row["device"], "max_sessions": row["max_sessions"], "on_limit": row["on_limit"],
            "ends_on": sub["ends_on"].isoformat() if sub else None, "days_left": (sub["ends_on"] - today).days if sub else None,
            "subscription_id": sub["id"] if sub else None, "tariff": sub["tariff_name"] if sub else "",
            "suspend_reason": sub["suspend_reason"] if sub and sub["suspended"] else "",
            "last_seen_at": row["last_seen_at"].isoformat() if row["last_seen_at"] else None, "last_refusal": row["last_refusal"], "weak": weak,
        })
    return {"today": today.isoformat(), "expiring_days": expiring, "counts": counts, "items": rows}


def access_update(store, who: dict, login_id: int, data: dict, answer: bool = True) -> dict | None:
    """Правка доступа одним действием: срок, число подключений, включён ли логин, чей он."""
    with store.db.connection() as conn:
        row = conn.execute("SELECT * FROM ntrip_logins WHERE id = %s", (login_id,)).fetchone()
        if row is None:
            raise Problem(f"Нет такого логина: №{login_id}.", 404)
        expiring = store._setting(conn, "expiring_days")
        subs = conn.execute("SELECT * FROM subscriptions WHERE client_id = %s", (row["client_id"],)).fetchall() if row["client_id"] else []
        tariff = conn.execute("SELECT t.id FROM tariffs t ORDER BY (t.name = %s) DESC, (SELECT count(*) FROM subscriptions s WHERE s.tariff_id = t.id) DESC, t.id LIMIT 1", (IMPORT_TARIFF,)).fetchone()
    today = dt.date.today()
    sub = _best(subs, today, expiring)

    login_fields = {k: data[k] for k in ("max_sessions", "on_limit", "active", "device") if k in data}
    if login_fields:
        store.update_login(who, login_id, login_fields)

    client_fields = {k: data[src] for k, src in (("name", "client"), ("phone", "phone"), ("note", "note")) if src in data}
    if client_fields and row["client_id"]:
        store.save_client(who, client_fields, row["client_id"])

    ends = None
    if data.get("ends_on"):
        ends = _date(data["ends_on"], "работает до")
    elif data.get("add_days"):
        try:
            days = int(data["add_days"])
        except (TypeError, ValueError):
            raise Problem("Продление: число дней.") from None
        if not 1 <= days <= 3660:
            raise Problem("Продление: от 1 до 3660 дней.")
        ends = max(sub["ends_on"] if sub else today, today) + dt.timedelta(days=days)
    if ends is not None:
        if row["staff"]:
            raise Problem("У служебного логина срока нет: он работает, пока включён.")
        if sub is None:
            if tariff is None:
                raise Problem("Сначала заведите тариф: срок доступа записывается в подписку клиента.")
            store.save_subscription(who, {"client_id": row["client_id"], "tariff_id": tariff["id"], "starts_on": min(today, ends).isoformat(),
                                          "ends_on": ends.isoformat(), "logins_limit": 1, "paid": True, "note": "выдано в разделе «Доступы»"})
        else:
            fields = {"ends_on": ends.isoformat(), "paid": True}
            if sub["starts_on"] > ends:
                fields["starts_on"] = ends.isoformat()
            store.save_subscription(who, fields, sub["id"])

    if "suspended" in data and sub is not None:
        store.suspend_subscription(who, sub["id"], bool(data["suspended"]), str(data.get("reason") or ""))

    return next(r for r in access_list(store)["items"] if r["id"] == login_id) if answer else None


BULK_FIELDS = ("add_days", "ends_on", "suspended", "reason", "active", "max_sessions", "on_limit")


def access_bulk(store, who: dict, ids, data: dict) -> dict:
    """Одно действие над несколькими логинами. Каждый логин правится отдельно: если у одного не вышло
    (например, у служебного нет срока), остальные всё равно меняются, а причина возвращается в ответе."""
    if not isinstance(ids, list) or not ids or len(ids) > 2000 or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        raise Problem("Выберите логины: нужен список их номеров.")
    change = {k: data[k] for k in BULK_FIELDS if k in data}
    if not set(change) - {"reason"}:
        raise Problem("Не сказано, что сделать с выбранными логинами.")
    with store.db.connection() as conn:
        names = {r["id"]: r["login"] for r in conn.execute("SELECT id, login FROM ntrip_logins WHERE id = ANY(%s)", (ids,)).fetchall()}
    done, failed = 0, []
    for login_id in dict.fromkeys(ids):
        try:
            access_update(store, who, login_id, change, answer=False)
            done += 1
        except Problem as exc:
            failed.append({"login": names.get(login_id, f"№{login_id}"), "why": str(exc)})
    return {"done": done, "failed": failed}


def access_import(store, who: dict, items, source: str = "NRS") -> dict:
    """Перенос логинов из прежней программы. Каждый логин становится клиентом с подпиской до своего
    срока; пароль остаётся прежним. Логины, которые уже есть, не трогаются — перенос можно повторять."""
    if not isinstance(items, list) or not items:
        raise Problem("Перенос: нужен список логинов.")
    today = dt.date.today()
    created, skipped, invalid = [], [], []
    with store.db.transaction() as conn:
        tariff = conn.execute("SELECT id FROM tariffs WHERE name = %s", (IMPORT_TARIFF,)).fetchone()
        if tariff is None:
            tariff = store._insert(conn, "tariffs", {"name": IMPORT_TARIFF, "period_days": 365, "all_mountpoints": True, "max_sessions": 100,
                                                     "note": "Сроки и число подключений перенесены из прежней программы"})
        have = {r["login"].lower() for r in conn.execute("SELECT login FROM ntrip_logins").fetchall()}
        for item in items:
            login = str(item.get("login") or "").strip()
            password = str(item.get("password") or "")
            if not LOGIN_RE.fullmatch(login):
                invalid.append({"login": login[:40], "why": "имя логина не по правилам"})
                continue
            if not OLD_PASSWORD_RE.fullmatch(password) or ":" in password:
                invalid.append({"login": login, "why": "пароль: пробел, двоеточие или не латиница"})
                continue
            if login.lower() in have:
                skipped.append(login)
                continue
            try:
                ends = dt.date.fromisoformat(str(item.get("ends_on"))[:10])
            except ValueError:
                invalid.append({"login": login, "why": "нет срока"})
                continue
            try:
                seen = dt.datetime.fromisoformat(str(item["last_seen"])[:10]).replace(tzinfo=dt.timezone.utc) if item.get("last_seen") else None
            except ValueError:
                seen = None
            org = str(item.get("org") or "").strip()[:120]
            client = store._insert(conn, "clients", {"name": org or login, "phone": str(item.get("phone") or "").strip()[:40], "note": f"Перенос из {source}"})
            store._insert(conn, "subscriptions", {"client_id": client["id"], "tariff_id": tariff["id"], "starts_on": min(today, ends), "ends_on": ends,
                                                  "logins_limit": 1, "paid": True, "note": f"срок из {source}"})
            sessions = max(1, min(100, int(item.get("max_sessions") or 1)))
            row = store._insert(conn, "ntrip_logins", {"client_id": client["id"], "login": login, "password_enc": store.vault.encrypt(password),
                                                       "device": str(item.get("device") or "").strip()[:120], "max_sessions": sessions})
            if seen:
                conn.execute("UPDATE ntrip_logins SET last_seen_at = %s WHERE id = %s", (seen, row["id"]))
            have.add(login.lower())
            created.append(login)
        store._audit(conn, who, "перенос логинов", "ntrip_logins", "", {"source": source, "created": len(created), "skipped": len(skipped), "invalid": len(invalid)})
    return {"created": len(created), "skipped": skipped, "invalid": invalid}
