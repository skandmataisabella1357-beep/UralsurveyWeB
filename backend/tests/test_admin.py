"""Тесты службы управления на настоящем PostgreSQL.

Нужна переменная URAL_TEST_DSN — подключение к серверу, где можно создавать базы, например
    URAL_TEST_DSN="host=/путь/к/сокету port=54329 user=test dbname=postgres"
Каждый прогон создаёт свою базу и удаляет её в конце. Без переменной тесты пропускаются.

    python -m unittest discover -s backend/tests -v
"""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402

from uralsurvey_admin import security  # noqa: E402
from uralsurvey_admin.api import serve  # noqa: E402
from uralsurvey_admin.db import Database  # noqa: E402
from uralsurvey_admin.store import Problem, Store, subscription_state  # noqa: E402

BASE_DSN = os.environ.get("URAL_TEST_DSN")
ADMIN_PASSWORD = "correct horse battery"
XYZ = {"x": 1647585.2585, "y": 3057841.8377, "z": 5331652.6642}


class Client:
    """Браузер в миниатюре: хранит cookie и разбирает ответы."""

    def __init__(self, base: str):
        self.base, self.cookie = base, ""

    def call(self, method: str, path: str, body=None, headers=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                raw, status, heads = res.read(), res.status, res.headers
        except urllib.error.HTTPError as exc:
            raw, status, heads = exc.read(), exc.code, exc.headers
        if heads.get("Set-Cookie"):
            self.cookie = heads["Set-Cookie"].split(";")[0]
        ctype = heads.get("Content-Type", "")
        return status, (json.loads(raw.decode("utf-8")) if ctype.startswith("application/json") else raw), heads


@unittest.skipUnless(BASE_DSN, "нет URAL_TEST_DSN: тесты базы пропущены")
class AdminTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dbname = f"ural_test_{os.getpid()}"
        with psycopg.connect(BASE_DSN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{cls.dbname}"')
            conn.execute(f'CREATE DATABASE "{cls.dbname}"')
        cls.tmp = tempfile.TemporaryDirectory()
        dsn = " ".join(p for p in BASE_DSN.split() if not p.startswith("dbname=")) + f" dbname={cls.dbname}"
        cls.db = Database(dsn)
        cls.applied = cls.db.migrate()
        cls.store = Store(cls.db, security.Vault(pathlib.Path(cls.tmp.name) / "secret.key"))
        cls.server = serve(cls.store, "127.0.0.1", 0, internal_key="internal-test-key")
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.db.close()
        with psycopg.connect(BASE_DSN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{cls.dbname}" WITH (FORCE)')
        cls.tmp.cleanup()

    # Тесты идут по порядку имён: каждый следующий опирается на записи предыдущих

    def test_01_schema_and_secrets(self):
        self.assertEqual(self.applied, ["001_init.sql", "002_subnets.sql", "003_subnet_once.sql", "004_subnet_ppp.sql", "005_layers.sql"])
        self.assertEqual(self.db.migrate(), [], "повторное применение схемы ничего не делает")
        digest, salt = security.hash_password(ADMIN_PASSWORD)
        self.assertTrue(security.verify_password(ADMIN_PASSWORD, digest, salt))
        self.assertFalse(security.verify_password(ADMIN_PASSWORD + "x", digest, salt))
        self.assertNotEqual(digest, security.hash_password(ADMIN_PASSWORD)[0])
        secret = self.store.vault.encrypt("пароль-станции")
        self.assertNotIn("пароль", secret)
        self.assertEqual(self.store.vault.decrypt(secret), "пароль-станции")
        password = security.generate_ntrip_password()
        self.assertEqual(len(password), 10)
        self.assertFalse(set(password) & set("0O1lI"), "в пароле NTRIP нет похожих знаков")
        key_mode = (pathlib.Path(self.tmp.name) / "secret.key").stat().st_mode & 0o777
        if os.name != "nt":
            self.assertEqual(key_mode, 0o600)

    def test_02_login(self):
        c = Client(self.base)
        self.assertEqual(c.call("GET", "/api/me")[1], {"signedIn": False, "configured": False, "admin": None})
        self.assertEqual(c.call("POST", "/api/login", {"login": "root", "password": ADMIN_PASSWORD})[0], 409)
        self.assertEqual(c.call("GET", "/api/admin/stations")[0], 401)
        with self.assertRaisesRegex(Problem, "не короче"):
            self.store.create_admin(None, {"login": "root", "password": "short", "role": "admin"})
        self.store.create_admin({"login": "консоль"}, {"login": "root", "password": ADMIN_PASSWORD, "role": "admin"})
        self.assertEqual(c.call("POST", "/api/login", {"login": "root", "password": "wrong password"})[0], 401)
        self.assertEqual(c.call("POST", "/api/login", {"login": "nobody", "password": ADMIN_PASSWORD})[0], 401)
        status, body, heads = c.call("POST", "/api/login", {"login": "root", "password": ADMIN_PASSWORD}, {"X-Forwarded-Proto": "https"})
        self.assertEqual(status, 200)
        self.assertEqual(body["admin"], {"login": "root", "role": "admin", "full_name": ""})
        self.assertRegex(heads["Set-Cookie"], r"^ural_session=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$")
        self.assertTrue(c.call("GET", "/api/me")[1]["signedIn"])
        # В базе лежит хеш токена, а не сам токен
        with self.db.connection() as conn:
            stored = conn.execute("SELECT token_hash FROM admin_sessions").fetchone()["token_hash"]
        self.assertNotIn(stored, c.cookie)
        # Чужой cookie не проходит; выход закрывает сеанс
        other = Client(self.base)
        other.cookie = "ural_session=" + "a" * 64
        self.assertEqual(other.call("GET", "/api/admin/stations")[0], 401)
        self.assertEqual(c.call("POST", "/api/logout")[0], 200)
        self.assertEqual(c.call("GET", "/api/admin/stations")[0], 401)
        type(self).admin = Client(self.base)
        self.assertEqual(self.admin.call("POST", "/api/login", {"login": "root", "password": ADMIN_PASSWORD})[0], 200)

    def test_03_stations(self):
        a = self.admin
        status, st, _ = a.call("POST", "/api/admin/stations", {"code": "REFT", "name": "Рефтинский", "source_mode": "listen", "source_port": 2110,
                                                                 "allow_addresses": "10.0.0.0/8, 185.41.162.156", "station_password": "st-secret", **XYZ})
        self.assertEqual(status, 201, st)
        self.assertEqual((st["x"], st["y"], st["z"]), (XYZ["x"], XYZ["y"], XYZ["z"]), "координаты хранятся до 0,1 мм")
        self.assertEqual(st["allow_addresses"], ["10.0.0.0/8", "185.41.162.156"])
        self.assertTrue(st["has_station_password"])
        self.assertNotIn("station_password_enc", st)
        self.assertNotIn("st-secret", json.dumps(st))
        # Ошибки ввода объясняются словами
        for body, text in [({"code": "плохой код"}, "латинские"), ({"code": "A", "x": 1, "y": 2, "z": 3, "source_mode": "sim"}, "поверхности Земли"),
                           ({"code": "A", "x": 1647585.0, "source_mode": "sim"}, "тремя числами"), ({"code": "A", "source_mode": "ntrip", "source_port": 2101}, "адрес"),
                           ({"code": "A", "source_mode": "listen", "source_port": 2111, "allow_addresses": ["300.1.1.1"]}, "не адрес"),
                           ({"code": "REFT", "source_mode": "listen", "source_port": 2112}, "уже есть")]:
            status, res, _ = a.call("POST", "/api/admin/stations", body)
            self.assertIn(status, (400, 409), body)
            self.assertIn(text, res["error"], body)
        self.assertEqual(len(a.call("GET", "/api/admin/stations")[1]), 1, "неудачные попытки ничего не оставили в базе")
        # Сдвиг больше 10 м требует отдельного подтверждения
        moved = {"x": XYZ["x"] + 25.0}
        status, res, _ = a.call("PATCH", f"/api/admin/stations/{st['id']}", moved)
        self.assertEqual(status, 409)
        self.assertIn("25.0 м", res["error"])
        self.assertEqual(a.call("PATCH", f"/api/admin/stations/{st['id']}", {**moved, "confirm_shift": True, "coords_note": "перенос антенны"})[0], 200)
        # Малая поправка проходит без подтверждения
        self.assertEqual(a.call("PATCH", f"/api/admin/stations/{st['id']}", {"z": XYZ["z"] + 0.0123})[0], 200)
        full = a.call("GET", f"/api/admin/stations/{st['id']}")[1]
        self.assertEqual(len(full["coords_history"]), 3)
        self.assertEqual(full["coords_history"][1]["note"], "перенос антенны")
        self.assertEqual(full["coords_history"][0]["author"], "root")
        self.assertEqual(full["z"], round(XYZ["z"] + 0.0123, 4))
        # Правка без координат историю не трогает; пустой пароль его стирает
        self.assertFalse(a.call("PATCH", f"/api/admin/stations/{st['id']}", {"name": "Рефт", "station_password": ""})[1]["has_station_password"])
        self.assertEqual(len(a.call("GET", f"/api/admin/stations/{st['id']}")[1]["coords_history"]), 3)
        a.call("PATCH", f"/api/admin/stations/{st['id']}", {"station_password": "st-secret"})
        self.assertEqual(a.call("GET", "/api/admin/stations/9999")[0], 404)
        type(self).station = st["id"]
        self.assertEqual(a.call("POST", "/api/admin/stations", {"code": "EKB2", "source_mode": "ntrip", "source_host": "caster.example", "source_port": 2101,
                                                                 "source_mountpoint": "EKB2_MSM4", "source_username": "u", "source_password": "src-secret"})[0], 201)

    def test_04_mountpoints(self):
        a = self.admin
        for body in [{"name": "REFT", "station_id": self.station}, {"name": "REFT_19", "station_id": self.station, "rtcm_station_id": 19, "listed": False},
                     {"name": "REFT_RAW", "station_id": self.station, "access": "staff"}, {"name": "REFT_PRO", "station_id": self.station, "access": "tariff"}]:
            self.assertEqual(a.call("POST", "/api/admin/mountpoints", body)[0], 201, body)
        self.assertEqual(a.call("POST", "/api/admin/mountpoints", {"name": "REFT", "station_id": self.station})[0], 409)
        self.assertIn("4095", a.call("POST", "/api/admin/mountpoints", {"name": "X", "station_id": self.station, "rtcm_station_id": 5000})[1]["error"])
        self.assertEqual(a.call("POST", "/api/admin/mountpoints", {"name": "X", "station_id": 9999})[0], 409, "несуществующая станция")
        points = {p["name"]: p for p in a.call("GET", "/api/admin/mountpoints")[1]}
        self.assertEqual(points["REFT_19"]["station_code"], "REFT")
        self.assertEqual(a.call("PATCH", f"/api/admin/mountpoints/{points['REFT_19']['id']}", {"enabled": False})[1]["enabled"], False)
        type(self).points = {n: p["id"] for n, p in points.items()}

    def test_05_clients_tariffs_logins(self):
        a = self.admin
        client = a.call("POST", "/api/admin/clients", {"name": "ООО «Геодезия»", "inn": "6670000000", "email": "geo@example.ru", "contract_no": "12/26"})[1]
        self.assertIn("10 или 12", a.call("POST", "/api/admin/clients", {"name": "Х", "inn": "123"})[1]["error"])
        basic = a.call("POST", "/api/admin/tariffs", {"name": "Месяц", "period_days": 30, "price": 3000})[1]
        pro = a.call("POST", "/api/admin/tariffs", {"name": "Про", "period_days": 365, "all_mountpoints": False, "mountpoint_ids": [self.points["REFT_PRO"]], "max_sessions": 2})[1]
        self.assertEqual(pro["mountpoint_ids"], [self.points["REFT_PRO"]])
        # Логин можно завести заранее, пароль создаёт сервер и показывает один раз
        status, login, _ = a.call("POST", "/api/admin/logins", {"client_id": client["id"], "login": "geo01", "device": "Trimble R10"})
        self.assertEqual(status, 201)
        self.assertRegex(login["password"], r"^[a-zA-Z2-9]{10}$")
        self.assertNotIn("password", a.call("GET", "/api/admin/logins")[1][0])
        self.assertIn("клиента", a.call("POST", "/api/admin/logins", {"login": "orphan"})[1]["error"])
        staff = a.call("POST", "/api/admin/logins", {"login": "uci-staff", "staff": True, "password": "staff-pass"})[1]
        self.assertEqual(staff["password"], "staff-pass")
        self.assertEqual(a.call("POST", f"/api/admin/logins/{login['id']}/reveal")[1]["password"], login["password"])
        new = a.call("POST", f"/api/admin/logins/{login['id']}/regenerate")[1]["password"]
        self.assertNotEqual(new, login["password"])
        self.assertEqual(a.call("PATCH", f"/api/admin/logins/{login['id']}", {"login": "renamed", "max_sessions": 2})[1]["login"], "geo01", "имя логина не меняется")
        type(self).ids = {"client": client["id"], "basic": basic["id"], "pro": pro["id"], "login": login["id"], "password": new}

    def test_06_subscriptions_and_directory(self):
        a, ids = self.admin, self.ids
        directory = self.store.directory()
        self.assertEqual(directory["users"]["geo01"]["mountpoints"], [], "без подписки логин не раздаётся")
        self.assertEqual(directory["users"]["uci-staff"]["mountpoints"], ["REFT", "REFT_19", "REFT_PRO", "REFT_RAW"])
        today = dt.date.today()
        status, sub, _ = a.call("POST", "/api/admin/subscriptions", {"client_id": ids["client"], "tariff_id": ids["basic"], "starts_on": today.isoformat(),
                                                                      "ends_on": (today + dt.timedelta(days=30)).isoformat(), "logins_limit": 1})
        self.assertEqual((status, sub["state"]), (201, "request"), "без оплаты и пробного доступа — заявка")
        self.assertEqual(self.store.directory()["users"]["geo01"]["mountpoints"], [])
        sub = a.call("PATCH", f"/api/admin/subscriptions/{sub['id']}", {"paid": True})[1]
        self.assertEqual((sub["state"], sub["days_left"]), ("active", 30))
        user = self.store.directory()["users"]["geo01"]
        self.assertEqual(user["mountpoints"], ["REFT", "REFT_19"], "обычный тариф даёт точки с доступом «все»")
        self.assertEqual(user["password"], ids["password"])
        self.assertEqual((user["maxSessions"], user["onLimit"], user["active"]), (2, "evict", True))
        self.assertTrue(user["expires"].startswith((today + dt.timedelta(days=31)).isoformat()), "сеанс дорабатывает до полуночи после даты конца")
        # Второй логин сверх числа в подписке не заводится
        res = a.call("POST", "/api/admin/logins", {"client_id": ids["client"], "login": "geo02"})
        self.assertEqual(res[0], 409)
        self.assertIn("разрешает 1", res[1]["error"])
        # Приостановка требует причины и сразу закрывает доступ
        self.assertIn("причину", a.call("POST", f"/api/admin/subscriptions/{sub['id']}/suspend", {})[1]["error"])
        self.assertEqual(a.call("POST", f"/api/admin/subscriptions/{sub['id']}/suspend", {"reason": "нет оплаты"})[1]["state"], "suspended")
        self.assertEqual(self.store.directory()["users"]["geo01"]["mountpoints"], [])
        self.assertEqual(a.call("POST", f"/api/admin/subscriptions/{sub['id']}/resume")[1]["state"], "active")
        # Продление: по умолчанию на срок тарифа, от даты конца
        ext = a.call("POST", f"/api/admin/subscriptions/{sub['id']}/extend", {})[1]
        self.assertEqual(ext["ends_on"], (today + dt.timedelta(days=60)).isoformat())
        # Вторая подписка на тариф с названной точкой расширяет права
        a.call("POST", "/api/admin/subscriptions", {"client_id": ids["client"], "tariff_id": ids["pro"], "starts_on": today.isoformat(),
                                                    "ends_on": (today + dt.timedelta(days=5)).isoformat(), "paid": True})
        self.assertEqual(self.store.directory()["users"]["geo01"]["mountpoints"], ["REFT", "REFT_19", "REFT_PRO"])
        # Состояния по датам
        row = {"suspended": False, "paid": True, "trial": False, "starts_on": today, "ends_on": today + dt.timedelta(days=3)}
        self.assertEqual(subscription_state(row, today, 7), "expiring")
        self.assertEqual(subscription_state({**row, "ends_on": today - dt.timedelta(days=1)}, today, 7), "expired")
        self.assertEqual(subscription_state({**row, "starts_on": today + dt.timedelta(days=2), "ends_on": today + dt.timedelta(days=40)}, today, 7), "pending")
        self.assertEqual(subscription_state({**row, "paid": False, "trial": True, "ends_on": today + dt.timedelta(days=40)}, today, 7), "trial")
        # Справочник для служб: станции с источниками и расшифрованными паролями, точки с правами
        d = self.store.directory()
        reft = next(s for s in d["stations"] if s["code"] == "REFT")
        self.assertEqual(reft["source"], {"mode": "listen", "port": 2110, "allow": ["10.0.0.0/8", "185.41.162.156"], "stationPassword": "st-secret"})
        self.assertEqual(next(s for s in d["stations"] if s["code"] == "EKB2")["source"]["password"], "src-secret")
        raw = next(p for p in d["mountpoints"] if p["name"] == "REFT_RAW")
        self.assertEqual(raw["access"], ["uci-staff"], "служебная точка открыта только служебным логинам")
        self.assertEqual(next(p for p in d["mountpoints"] if p["name"] == "REFT_19")["stationId"], 19)
        clients = a.call("GET", "/api/admin/clients?search=geo01")[1]
        self.assertEqual((len(clients), clients[0]["logins"], clients[0]["subscription"]["state"]), (1, 1, "active"))
        self.assertEqual(a.call("GET", "/api/admin/clients?search=zzz")[1], [])
        csv = a.call("GET", "/api/admin/subscriptions.csv")
        self.assertIn("Геодезия", csv[1].decode("utf-8-sig"))
        self.assertIn("attachment", csv[2]["Content-Disposition"])

    def test_07_operator(self):
        a = self.admin
        self.assertEqual(a.call("POST", "/api/admin/admins", {"login": "oper", "password": "operator password", "role": "operator", "full_name": "Оператор"})[0], 201)
        o = Client(self.base)
        self.assertEqual(o.call("POST", "/api/login", {"login": "oper", "password": "operator password"})[0], 200)
        self.assertEqual(o.call("GET", "/api/admin/stations")[0], 200, "оператор смотрит")
        for method, path, body in [("POST", "/api/admin/stations", {"code": "X"}), ("PATCH", f"/api/admin/stations/{self.station}", {"name": "x"}),
                                   ("DELETE", f"/api/admin/mountpoints/{self.points['REFT']}", None), ("POST", "/api/admin/tariffs", {"name": "t", "period_days": 1}),
                                   ("GET", "/api/admin/admins", None), ("GET", "/api/admin/audit", None), ("PATCH", "/api/admin/settings", {"trial_days": 5}),
                                   ("POST", f"/api/admin/logins/{self.ids['login']}/reveal", None)]:
            res = o.call(method, path, body)
            self.assertEqual(res[0], 403, f"{method} {path}")
            self.assertIn("только администратору", res[1]["error"])
        # Пробный доступ оператор выдать может
        other = a.call("POST", "/api/admin/clients", {"name": "ИП Петров"})[1]
        trial = o.call("POST", "/api/admin/subscriptions/trial", {"client_id": other["id"], "tariff_id": self.ids["basic"]})
        self.assertEqual((trial[0], trial[1]["state"], trial[1]["days_left"]), (201, "expiring", 3))
        # Единственного администратора нельзя ни удалить, ни разжаловать; отключённый оператор теряет сеанс
        root = next(x for x in a.call("GET", "/api/admin/admins")[1] if x["login"] == "root")
        self.assertEqual(a.call("PATCH", f"/api/admin/admins/{root['id']}", {"role": "operator"})[0], 409)
        self.assertEqual(a.call("DELETE", f"/api/admin/admins/{root['id']}")[0], 409)
        oper = next(x for x in a.call("GET", "/api/admin/admins")[1] if x["login"] == "oper")
        self.assertNotIn("password_hash", oper)
        self.assertEqual(a.call("PATCH", f"/api/admin/admins/{oper['id']}", {"active": False})[0], 200)
        self.assertEqual(o.call("GET", "/api/admin/stations")[0], 401)

    def test_08_events_and_journals(self):
        a = self.admin
        now = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
        events = [
            {"t": "open", "id": "c1-1", "at": now - 60000, "login": "geo01", "point": "REFT", "station": "REFT", "address": "5.6.7.8", "agent": "NTRIP Rover", "version": 1},
            {"t": "update", "id": "c1-1", "at": now - 30000, "bytes": 1000, "position": {"lat": 57.09, "lon": 61.68, "kind": "float"}, "first": {"lat": 57.09, "lon": 61.68}},
            {"t": "close", "id": "c1-1", "at": now, "login": "geo01", "bytes": 5000, "reason": "ровер отключился", "position": {"lat": 57.1, "lon": 61.7, "kind": "fixed"}},
            {"t": "open", "id": "c1-2", "at": now, "login": "geo01", "point": "REFT", "station": "REFT", "address": "5.6.7.8", "agent": "NTRIP Rover", "version": 2},
            {"t": "refusal", "at": now, "login": "geo01", "point": "REFT_RAW", "code": 403, "reason": "точка не входит в подписку", "address": "5.6.7.8"},
            {"t": "мусор"},
        ]
        key = {"X-Ural-Key": "internal-test-key"}
        anon = Client(self.base)
        self.assertEqual(anon.call("POST", "/internal/events", {"events": events})[0], 404, "без ключа адреса как будто нет")
        self.assertEqual(anon.call("GET", "/internal/directory", headers={"X-Ural-Key": "wrong"})[0], 404)
        self.assertEqual(anon.call("GET", "/internal/directory", headers={**key, "X-Real-IP": "8.8.8.8"})[0], 404, "запрос, пришедший через nginx, не принимается")
        self.assertEqual(anon.call("POST", "/internal/events", {"events": events}, key)[1], {"recorded": 5})
        self.assertEqual(anon.call("POST", "/internal/events", {"events": events[:3]}, key)[0], 200, "повторная доставка не ломает журнал")
        self.assertIn("geo01", anon.call("GET", "/internal/directory", headers=key)[1]["users"])
        sessions = a.call("GET", "/api/admin/sessions?login=geo01")[1]
        self.assertEqual(sessions["total"], 2)
        done = next(s for s in sessions["items"] if s["caster_id"] == "c1-1")
        self.assertEqual((done["bytes"], done["end_reason"], done["last_kind"], done["first_lat"], done["last_lat"]), (5000, "ровер отключился", "fixed", 57.09, 57.1))
        self.assertEqual(a.call("GET", "/api/admin/sessions?open=1")[1]["total"], 1)
        today = dt.date.today().isoformat()
        self.assertEqual(a.call("GET", f"/api/admin/sessions?from={today}&to={today}&mountpoint=REFT")[1]["total"], 2)
        self.assertIn("ГГГГ-ММ-ДД", a.call("GET", "/api/admin/sessions?from=yesterday")[1]["error"])
        self.assertEqual(a.call("GET", "/api/admin/refusals?login=geo01")[1]["items"][0]["code"], 403)
        login = next(x for x in a.call("GET", "/api/admin/logins")[1] if x["login"] == "geo01")
        self.assertEqual(login["last_refusal"], "точка не входит в подписку")
        self.assertIsNotNone(login["last_seen_at"])
        # Раздача перезапустилась и сеанса c1-2 у неё больше нет
        self.assertEqual(anon.call("POST", "/internal/events", {"events": [], "alive": []}, key)[0], 200)
        self.assertEqual(a.call("GET", "/api/admin/sessions?open=1")[1]["total"], 0)
        counts = a.call("GET", "/api/admin/counts")[1]
        self.assertEqual((counts["stations"], counts["mountpoints"], counts["sessions_today"], counts["refusals_day"]), (2, 4, 2, 1))

    def test_09_audit_settings_static(self):
        a = self.admin
        audit = a.call("GET", "/api/admin/audit?limit=500")[1]
        actions = {(r["action"], r["entity"]) for r in audit["items"]}
        for expected in [("вход", ""), ("неудачный вход", ""), ("создана", "stations"), ("изменена", "stations"), ("показан пароль", "ntrip_logins"),
                         ("сменён пароль", "ntrip_logins"), ("приостановлена", "subscriptions"), ("продлена", "subscriptions"), ("создан", "admins")]:
            self.assertIn(expected, actions)
        self.assertNotIn("st-secret", json.dumps(audit, ensure_ascii=False), "паролей в журнале действий нет")
        self.assertNotIn(self.ids["password"], json.dumps(audit, ensure_ascii=False))
        with self.assertRaises(psycopg.Error), self.db.transaction() as conn:
            conn.execute("DELETE FROM audit_log")
        with self.assertRaises(psycopg.Error), self.db.transaction() as conn:
            conn.execute("UPDATE audit_log SET action = 'x'")
        settings = {s["key"]: s for s in a.call("GET", "/api/admin/settings")[1]}
        self.assertEqual(settings["trial_days"]["value"], 3)
        self.assertEqual(a.call("PATCH", "/api/admin/settings", {"trial_days": 500})[0], 400)
        self.assertEqual(a.call("PATCH", "/api/admin/settings", {"нет такой": 1})[0], 400)
        self.assertEqual({s["key"]: s["value"] for s in a.call("PATCH", "/api/admin/settings", {"trial_days": 5})[1]}["trial_days"], 5)
        # Страницы, чужие файлы и неизвестные адреса
        for path in ("/admin.html", "/admin"):
            status, page, _ = a.call("GET", path)
            self.assertEqual(status, 200)
            page = page.decode("utf-8")
            # Страница собрана на Python: все окна на месте, адреса файлов — с отметкой времени
            for part in ('id="login-form"', 'id="form-dialog"', 'id="detail"', 'id="sub-dialog"', 'id="set-dialog"', 'id="map"', 'id="rail"'):
                self.assertIn(part, page)
            self.assertRegex(page, r'src="/admin\.js\?v=\d+"')
        self.assertEqual(a.call("GET", "/ui/styles.css")[0], 200)
        for path in ["/ui/..%2F..%2Fpackage.json", "/..%2F..%2Fbackend/requirements.txt", "/%00", "/nope.html"]:
            self.assertEqual(a.call("GET", path)[0], 404, path)
        self.assertEqual(a.call("GET", "/api/admin/nope")[0], 404)
        self.assertEqual(a.call("DELETE", "/api/admin/settings")[0], 405)
        self.assertEqual(a.call("POST", "/api/admin/clients", headers={"Content-Length": "999999"})[0], 413)
        # Удаление станции убирает её точки; удаление клиента — его логины и подписки
        self.assertEqual(a.call("DELETE", f"/api/admin/stations/{self.station}")[0], 200)
        self.assertEqual(a.call("GET", "/api/admin/mountpoints")[1], [])
        self.assertEqual(a.call("DELETE", f"/api/admin/tariffs/{self.ids['basic']}")[0], 409, "тариф с подписками не удаляется")
        self.assertEqual(a.call("DELETE", f"/api/admin/clients/{self.ids['client']}")[0], 200)
        self.assertEqual([x["login"] for x in a.call("GET", "/api/admin/logins")[1]], ["uci-staff"])
        self.assertEqual(self.store.cleanup(), {"sessions": 0, "refusals": 0})

    def test_09a_network_stop(self):
        a = self.admin
        before = {s["code"]: s["enabled"] for s in a.call("GET", "/api/admin/stations")[1]}
        on = sum(before.values())
        # Остановка приёма по всей сети: служба приёма получает пустой список станций
        status, res, _ = a.call("POST", "/api/admin/stations/enabled", {"enabled": False})
        self.assertEqual((status, res["changed"]), (200, on))
        self.assertEqual(a.call("GET", "/internal/directory", headers={"X-Ural-Key": "internal-test-key"})[1]["stations"], [])
        status, res, _ = a.call("POST", "/api/admin/stations/enabled", {"enabled": True})
        self.assertEqual((status, res["changed"]), (200, len(before)))
        for code, was in before.items():
            if not was:
                st = next(s for s in a.call("GET", "/api/admin/stations")[1] if s["code"] == code)
                a.call("PATCH", f"/api/admin/stations/{st['id']}", {"enabled": False})

    def test_09c_layers(self):
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        square = [[56.6, 60.3], [56.6, 60.9], [57.0, 60.9], [57.0, 60.3]]
        for body, text in [({"name": "", "format": "kml", "features": []}, "имя"), ({"name": "A", "format": "shp", "features": []}, "KML или DXF"),
                           ({"name": "A", "format": "kml", "features": [{"kind": "polygon", "points": [[1, 2]]}]}, "не принят"),
                           ({"name": "A", "format": "kml", "features": [{"kind": "polygon", "points": [[100, 2], [1, 2], [3, 4]]}]}, "не принят")]:
            status, res, _ = a.call("POST", "/api/admin/layers", body)
            self.assertEqual(status, 400, res)
            self.assertIn(text, res["error"])
        status, layer, _ = a.call("POST", "/api/admin/layers", {"name": "Участок", "format": "dxf", "crs": "msk66-1",
                                                                "features": [{"kind": "polygon", "name": "Граница", "points": square}, {"kind": "line", "points": square[:2]}]})
        self.assertEqual(status, 201, layer)
        self.assertEqual((layer["polygons"], layer["lines"], layer["logins"]), (1, 1, []))
        self.assertNotIn("features", layer)
        self.assertEqual(a.call("GET", f"/api/admin/layers/{layer['id']}")[1]["features"][0]["points"], square)
        status, only_lines, _ = a.call("POST", "/api/admin/layers", {"name": "Трасса", "format": "kml", "features": [{"kind": "line", "points": square[:3]}]})
        self.assertEqual(status, 201, only_lines)
        # Область работы: логину назначается слой с контурами; раздача получает контуры
        status, login, _ = a.call("POST", "/api/admin/logins", {"login": "fence01", "staff": True})
        self.assertEqual(status, 201, login)
        self.assertEqual(a.call("POST", f"/api/admin/layers/{only_lines['id']}/logins", {"login_ids": [login["id"]]})[0], 400, "по линиям область не задать")
        status, got, _ = a.call("POST", f"/api/admin/layers/{layer['id']}/logins", {"login_ids": [login["id"]]})
        self.assertEqual((status, [u["login"] for u in got["logins"]]), (200, [login["login"]]))
        users = a.call("GET", "/internal/directory", headers=key)[1]["users"]
        self.assertEqual(users[login["login"]]["area"], [square])
        self.assertTrue(all(u["area"] is None for name, u in users.items() if name != login["login"]))
        shown = next(x for x in a.call("GET", "/api/admin/logins")[1] if x["id"] == login["id"])
        self.assertEqual(shown["area_layer_name"], "Участок")
        # То же через карточку логина; удаление слоя снимает ограничение
        self.assertEqual(a.call("PATCH", f"/api/admin/logins/{login['id']}", {"area_layer_id": None})[0], 200)
        self.assertIsNone(a.call("GET", "/internal/directory", headers=key)[1]["users"][login["login"]]["area"])
        self.assertEqual(a.call("PATCH", f"/api/admin/logins/{login['id']}", {"area_layer_id": layer["id"]})[0], 200)
        self.assertEqual(self.operator_status("DELETE", f"/api/admin/layers/{layer['id']}"), 403)
        self.assertEqual(a.call("DELETE", f"/api/admin/layers/{layer['id']}")[0], 200)
        self.assertIsNone(a.call("GET", "/internal/directory", headers=key)[1]["users"][login["login"]]["area"])
        self.assertEqual(a.call("DELETE", f"/api/admin/layers/{only_lines['id']}")[0], 200)
        self.assertEqual(a.call("DELETE", f"/api/admin/logins/{login['id']}")[0], 200)

    def operator_status(self, method, path):
        oper = Client(self.base)
        if oper.call("POST", "/api/login", {"login": "oper", "password": "operator password"})[0] != 200:
            return 403
        return oper.call(method, path)[0]

    def test_09b_subnets(self):
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        status, first, _ = a.call("POST", "/api/admin/stations", {"code": "SUB1", "source_mode": "listen", "source_port": 2149})
        self.assertEqual(status, 201, first)
        self.assertEqual(a.call("POST", "/api/admin/mountpoints", {"name": "SUB1", "station_id": first["id"]})[0], 201)
        status, second, _ = a.call("POST", "/api/admin/stations", {"code": "SUB2", "source_mode": "listen", "source_port": 2150})
        self.assertEqual(status, 201, second)
        ids = [first["id"], second["id"]]
        # Ошибки ввода объясняются словами
        for body, text in [({"name": "плохое"}, "латинские"), ({"name": "EKB", "contour": [[57, 61], [58, 62]]}, "трёх точек"),
                           ({"name": "EKB", "station_ids": [999999]}, "нет в каталоге"),
                           ({"name": "EKB", "station_ids": [ids[0]], "reference_station_id": ids[1]}, "входить в подсеть")]:
            status, res, _ = a.call("POST", "/api/admin/subnets", body)
            self.assertEqual(status, 400, res)
            self.assertIn(text, res["error"])
        status, sub, _ = a.call("POST", "/api/admin/subnets", {"name": "ekb", "title": "Екатеринбург", "contour": [[56, 60], [58, 60], [58, 63]], "station_ids": ids})
        self.assertEqual(status, 201, sub)
        self.assertEqual((sub["name"], sub["stations"], sub["calc_state"]), ("EKB", ["SUB1", "SUB2"], "idle"))
        base = f"/api/admin/subnets/{sub['id']}"
        # Без опорной станции расчёт не начинается; у службы расчёта заданий нет
        status, res, _ = a.call("POST", base + "/start", {})
        self.assertEqual(status, 400, res)
        self.assertIn("опорную", res["error"])
        self.assertEqual(a.call("GET", "/internal/solver", headers=key)[1], {"subnets": [], "ppp": []})
        # PPP-AR: задание службе расчёта; промежуточный ответ расчёт не закрывает, итоговый — закрывает
        status, got, _ = a.call("POST", base + "/ppp/start", {})
        self.assertEqual((status, got["ppp_state"]), (200, "running"))
        job = a.call("GET", "/internal/solver", headers=key)[1]["ppp"][0]
        self.assertEqual((job["name"], job["stations"]), ("EKB", ["SUB1", "SUB2"]))
        post = lambda results, final: a.call("POST", "/internal/solver", {"kind": "ppp", "id": sub["id"], "startedAt": job["startedAt"], "results": results, "final": final}, key)[1]
        self.assertEqual(post({"note": "ждём продукты"}, False), {"stored": True})
        self.assertEqual(len(a.call("GET", "/internal/solver", headers=key)[1]["ppp"]), 1)
        self.assertEqual(post({"stations": {"SUB1": {"x": XYZ["x"], "y": XYZ["y"], "z": XYZ["z"], "fixed": True}}}, True), {"stored": True})
        got = next(s for s in a.call("GET", "/api/admin/subnets")[1] if s["id"] == sub["id"])
        self.assertEqual((got["ppp_state"], got["ppp_results"]["stations"]["SUB1"]["fixed"]), ("stopped", True))
        self.assertEqual(a.call("GET", "/internal/solver", headers=key)[1]["ppp"], [])
        status, sub, _ = a.call("PATCH", base, {"reference_station_id": ids[0], "ref_x": XYZ["x"], "ref_y": XYZ["y"], "ref_z": XYZ["z"]})
        self.assertEqual((status, sub["reference"]), (200, "SUB1"))
        status, sub, _ = a.call("POST", base + "/start", {})
        self.assertEqual((status, sub["calc_state"]), (200, "running"))
        # На ходу расчёта состав не меняется
        self.assertEqual(a.call("PATCH", base, {"station_ids": [ids[0]]})[0], 409)
        task = a.call("GET", "/internal/solver", headers=key)[1]["subnets"][0]
        self.assertEqual((task["name"], task["reference"], task["stations"], task["ecef"]), ("EKB", "SUB1", ["SUB1", "SUB2"], [XYZ["x"], XYZ["y"], XYZ["z"]]))
        self.assertEqual(a.call("GET", "/internal/solver")[0], 404, "без ключа адрес службы расчёта закрыт")
        # Ответ чужого (прежнего) расчёта не принимается; своего — принимается
        results = {"cycles": 3, "stations": {"SUB1": {"quality": "reference", "x": XYZ["x"], "y": XYZ["y"], "z": XYZ["z"]},
                                             "SUB2": {"quality": "float", "from": "SUB1", "length_km": 41.2, "x": XYZ["x"] + 30000.1234, "y": XYZ["y"], "z": XYZ["z"] - 9000.5,
                                                      "sd": [0.01, 0.01, 0.02], "spread": 0.004, "minutes": 40}}}
        self.assertEqual(a.call("POST", "/internal/solver", {"id": sub["id"], "startedAt": "2000-01-01T00:00:00+00:00", "results": results}, key)[1], {"stored": False})
        self.assertEqual(a.call("POST", "/internal/solver", {"id": sub["id"], "startedAt": task["startedAt"], "results": results}, key)[1], {"stored": True})
        # Точек подсети нет, пока координаты не приняты
        self.assertEqual(a.call("POST", base + "/points", {})[0], 400)
        oper = Client(self.base)
        if oper.call("POST", "/api/login", {"login": "oper", "password": "operator password"})[0] == 200:
            self.assertEqual(oper.call("POST", base + "/accept", {})[0], 403, "принимать координаты может только администратор")
        status, sub, _ = a.call("POST", base + "/accept", {})
        self.assertEqual(status, 200, sub)
        self.assertEqual(sub["accepted"]["SUB2"]["x"], round(XYZ["x"] + 30000.1234, 4))
        self.assertEqual((sub["accepted"]["SUB2"]["quality"], sub["accepted"]["SUB2"]["by"]), ("float", "root"))
        status, sub, _ = a.call("POST", base + "/points", {})
        self.assertEqual(status, 200, sub)
        self.assertEqual(sorted(p["name"] for p in sub["mountpoints"]), ["EKB_SUB1", "EKB_SUB2"])
        # Раздача получает точку подсети со своими координатами, обычная точка станции — без них
        points = {p["name"]: p for p in a.call("GET", "/internal/directory", headers=key)[1]["mountpoints"]}
        self.assertEqual(points["EKB_SUB2"]["position"], [round(XYZ["x"] + 30000.1234, 4), XYZ["y"], round(XYZ["z"] - 9000.5, 4)])
        self.assertEqual(points["EKB_SUB2"]["station"], "SUB2")
        self.assertIsNone(points["SUB1"]["position"])
        status, sub, _ = a.call("POST", base + "/stop", {})
        self.assertEqual((status, sub["calc_state"]), (200, "stopped"))
        self.assertEqual(a.call("GET", "/internal/solver", headers=key)[1]["subnets"], [])
        # «Вычислить текущие координаты»: разовое задание; после ответа с отметкой final расчёт выполнен
        status, sub, _ = a.call("POST", base + "/compute", {})
        self.assertEqual((status, sub["calc_state"], sub["calc_once"]), (200, "running", True))
        task = a.call("GET", "/internal/solver", headers=key)[1]["subnets"][0]
        self.assertTrue(task["once"])
        self.assertEqual(a.call("POST", "/internal/solver", {"id": sub["id"], "startedAt": task["startedAt"], "results": results, "final": True}, key)[1], {"stored": True})
        sub = next(s for s in a.call("GET", "/api/admin/subnets")[1] if s["id"] == sub["id"])
        self.assertEqual((sub["calc_state"], sub["results"]["cycles"]), ("stopped", 3))
        self.assertEqual(a.call("GET", "/internal/solver", headers=key)[1]["subnets"], [])
        actions = [r["action"] for r in a.call("GET", "/api/admin/audit?entity=subnets")[1]["items"]]
        for action in ("создана", "расчёт начат", "вычисление текущих координат", "приняты координаты", "созданы точки подсети", "расчёт остановлен"):
            self.assertIn(action, actions)
        # Удаление подсети убирает её точки подключения, станции остаются
        self.assertEqual(a.call("DELETE", base)[0], 200)
        names = [m["name"] for m in a.call("GET", "/api/admin/mountpoints")[1]]
        self.assertNotIn("EKB_SUB2", names)
        self.assertIn("SUB1", names)
        for st in (first, second):
            self.assertEqual(a.call("DELETE", f"/api/admin/stations/{st['id']}")[0], 200)

    def test_10_bruteforce(self):
        # Счётчик неудач общий на адрес и уже видел неверные пароли из прежних тестов:
        # не позже пятой попытки вход закрывается, и верный пароль тоже не проходит
        c = Client(self.base)
        codes = [c.call("POST", "/api/login", {"login": "root", "password": f"wrong {i}"})[0] for i in range(5)]
        self.assertEqual(codes[-1], 429, codes)
        self.assertTrue(all(code in (401, 429) for code in codes), codes)
        self.assertEqual(c.call("POST", "/api/login", {"login": "root", "password": ADMIN_PASSWORD})[0], 429)


if __name__ == "__main__":
    unittest.main()
