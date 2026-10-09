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
        self.assertEqual(self.applied, ["001_init.sql", "002_subnets.sql", "003_subnet_once.sql", "004_subnet_ppp.sql", "005_layers.sql", "006_subnet_link.sql", "007_networks.sql", "008_send_catalog.sql", "009_outages.sql", "010_iono_day.sql", "011_network_kinds.sql", "012_network_port.sql", "013_session_fix.sql", "014_network_recipe.sql"])
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
                           ({"name": "EKB", "station_ids": [ids[0]], "reference_station_id": ids[1]}, "входить в расчётный модуль")]:
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
        self.assertEqual(a.call("GET", "/internal/solver", headers=key)[1], {"subnets": [], "ppp": [], "pppDaily": []})
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
        # Расчётный модуль сама ничего не раздаёт; сеть раздачи не выпустить, пока координаты не приняты
        make = lambda kind, name="n3": a.call("POST", "/api/admin/networks", {"name": name, "title": "Сеть три", "subnet_id": sub["id"], "kind": kind})
        self.assertEqual(make("itrf")[0], 400)
        oper = Client(self.base)
        if oper.call("POST", "/api/login", {"login": "oper", "password": "operator password"})[0] == 200:
            self.assertEqual(oper.call("POST", base + "/accept", {})[0], 403, "принимать координаты может только администратор")
        status, sub, _ = a.call("POST", base + "/accept", {})
        self.assertEqual(status, 200, sub)
        self.assertEqual(sub["accepted"]["SUB2"]["x"], round(XYZ["x"] + 30000.1234, 4))
        self.assertEqual((sub["accepted"]["SUB2"]["quality"], sub["accepted"]["SUB2"]["by"]), ("float", "root"))
        # Сеть «как основная» без привязки не выпустить; сеть ITRF — выпускается со своими точками
        status, res, _ = make("local")
        self.assertEqual(status, 400, res)
        self.assertIn("привязку", res["error"])
        status, net, _ = make("itrf")
        self.assertEqual(status, 201, net)
        self.assertEqual((net["name"], net["version"], net["subnet"], sorted(p["name"] for p in net["points"])), ("N3", 1, "EKB", ["N3_SUB1", "N3_SUB2"]))
        self.assertEqual(make("itrf")[0], 409, "имя сети занято")
        # Раздача получает точку сети с координатами выпуска, обычная точка станции — без них
        points = {p["name"]: p for p in a.call("GET", "/internal/directory", headers=key)[1]["mountpoints"]}
        self.assertEqual(points["N3_SUB2"]["position"], [round(XYZ["x"] + 30000.1234, 4), XYZ["y"], round(XYZ["z"] - 9000.5, 4)])
        self.assertEqual(points["N3_SUB2"]["station"], "SUB2")
        self.assertIsNone(points["SUB1"]["position"])
        # Без изменений в расчётном модуле новая версия не выпускается
        status, res, _ = a.call("POST", f"/api/admin/networks/{net['id']}/release", {})
        self.assertEqual(status, 400, res)
        self.assertIn("Изменений нет", res["error"])
        # Тариф даёт сеть целиком
        status, tariff, _ = a.call("POST", "/api/admin/tariffs", {"name": "Сеть три", "period_days": 30, "network_ids": [net["id"]]})
        self.assertEqual((status, tariff["network_ids"]), (201, [net["id"]]))
        self.assertEqual(a.call("DELETE", f"/api/admin/tariffs/{tariff['id']}")[0], 200)
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
        # Зоны покрытия: гарантированный фикс — по худшей ионосфере за сутки, объективный — по нынешней
        self.assertIsNone(sub["reach"])
        from uralsurvey_admin.store import reach
        hour_ago = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).isoformat()
        self.assertEqual(reach([[hour_ago, 3.0]], {"network": {"iono_ppm": 1.5}}), {"now_ppm": 1.5, "worst_ppm": 3.0, "hours": 5.0, "sure_km": 50.0, "real_km": 100.0})
        self.assertEqual(reach([], {"network": {"iono_ppm": 3.0}})["real_km"], 50.0)
        status, sub, _ = a.call("POST", base + "/compute", {})
        task = a.call("GET", "/internal/solver", headers=key)[1]["subnets"][0]
        self.assertEqual(a.call("POST", "/internal/solver", {"id": sub["id"], "startedAt": task["startedAt"], "results": {**results, "network": {"iono_ppm": 2.5}}, "final": True}, key)[1], {"stored": True})
        sub = next(s for s in a.call("GET", "/api/admin/subnets")[1] if s["id"] == sub["id"])
        self.assertEqual((sub["reach"]["sure_km"], sub["reach"]["real_km"], "iono_day" in sub), (60.0, 60.0, False))
        self.assertEqual(a.call("GET", "/internal/solver", headers=key)[1]["subnets"], [])
        actions = [r["action"] for r in a.call("GET", "/api/admin/audit?entity=subnets")[1]["items"]]
        for action in ("создана", "расчёт начат", "вычисление текущих координат", "приняты координаты", "расчёт остановлен"):
            self.assertIn(action, actions)
        self.assertIn("сеть выпущена", [r["action"] for r in a.call("GET", "/api/admin/audit?entity=networks")[1]["items"]])
        # Удаление расчётного модуля выпущенную сеть не трогает: она раздаёт прежние координаты
        self.assertEqual(a.call("DELETE", base)[0], 200)
        net = next(n for n in a.call("GET", "/api/admin/networks")[1] if n["id"] == net["id"])
        self.assertEqual((net["subnet"], len(net["points"])), (None, 2))
        self.assertEqual(a.call("POST", f"/api/admin/networks/{net['id']}/release", {})[0], 400, "без расчётного модуля новую версию выпустить не из чего")
        self.assertIn("N3_SUB2", [m["name"] for m in a.call("GET", "/api/admin/mountpoints")[1]])
        # Удаление сети убирает её точки подключения, станции остаются
        self.assertEqual(a.call("DELETE", f"/api/admin/networks/{net['id']}")[0], 200)
        names = [m["name"] for m in a.call("GET", "/api/admin/mountpoints")[1]]
        self.assertNotIn("N3_SUB2", names)
        self.assertIn("SUB1", names)
        for st in (first, second):
            self.assertEqual(a.call("DELETE", f"/api/admin/stations/{st['id']}")[0], 200)

    def test_09d_subnet_link(self):
        """Сеть 2: суточный PPP-AR копится и усредняется, привязка к основной сети, два вида точек."""
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        # Пять станций; в каталоге — координаты основной сети: общий сдвиг 4,4 м, у пятой — другой
        true = [[XYZ["x"] + dx, XYZ["y"] + dy, XYZ["z"] + dz] for dx, dy, dz in ((0, 0, 0), (60000, -20000, 5000), (-30000, 50000, -8000), (20000, 30000, -40000), (-50000, -40000, 30000))]
        shift = [-1.734, 3.764, -1.476]
        made = []
        for i, t in enumerate(true):
            off = shift if i < 4 else [0.5, 1.0, -0.6]
            body = {"code": f"LNK{i}", "source_mode": "listen", "source_port": 2160 + i, "x": round(t[0] + off[0], 4), "y": round(t[1] + off[1], 4), "z": round(t[2] + off[2], 4)}
            status, st, _ = a.call("POST", "/api/admin/stations", body)
            self.assertEqual(status, 201, st)
            made.append(st)
        status, sub, _ = a.call("POST", "/api/admin/subnets", {"name": "net2", "station_ids": [s["id"] for s in made]})
        self.assertEqual(status, 201, sub)
        base = f"/api/admin/subnets/{sub['id']}"
        day = lambda n, wobble, hours=23.9, products="WUM0MGXRAP": a.call("POST", "/internal/solver", {"kind": "ppp-day", "id": sub["id"], "day": f"2026-10-0{n}", "results": {
            "epoch": 2026.76, "stations": {f"LNK{i}": {"x": t[0], "y": t[1], "z": t[2], "x14": round(t[0] + wobble, 4), "y14": t[1], "z14": t[2], "sd": [0.002, 0.002, 0.003],
                                                       "fixed": True, "hours": hours, "products": products} for i, t in enumerate(true)}}}, key)[1]
        # Пока суточный расчёт не включён, сутки не принимаются и принимать нечего
        self.assertEqual(day(1, 0), {"stored": False})
        self.assertEqual(a.call("POST", base + "/ppp/accept", {})[0], 400)
        self.assertEqual(a.call("POST", base + "/ppp/daily", {"on": True})[1]["ppp_daily"], True)
        job = a.call("GET", "/internal/solver", headers=key)[1]["pppDaily"][0]
        self.assertEqual((job["name"], len(job["stations"]), job["have"]), ("NET2", 5, {}))
        for n, wobble in ((1, 0.004), (2, -0.004), (3, 0.002), (4, -0.002), (5, 0.9)):
            self.assertEqual(day(n, wobble), {"stored": True})
        self.assertEqual(day(6, 0.5, hours=3), {"stored": True})  # короткие сутки в среднее не идут
        self.assertEqual(day(1, 0.004), {"stored": True})  # повтор суток заменяет прежний
        got = next(s for s in a.call("GET", "/api/admin/subnets")[1] if s["id"] == sub["id"])
        mean = got["ppp_mean"]["stations"]["LNK1"]
        self.assertEqual(len(got["ppp_mean"]["days"]), 6)
        self.assertEqual((mean["n"], mean["dropped"], mean["x"]), (4, 1, round(true[1][0], 4)))
        self.assertTrue(0.003 < mean["spread"] < 0.005, mean)
        # Принятые координаты — среднее по суткам; дальше сами не меняются
        status, got, _ = a.call("POST", base + "/ppp/accept", {})
        self.assertEqual(status, 200, got)
        self.assertEqual((got["accepted"]["LNK1"]["quality"], got["accepted"]["LNK1"]["days"], got["accepted"]["LNK1"]["frame"]), ("ppp", 4, "ITRF2014"))
        # Сеть «как основная» без привязки не выпускается
        self.assertEqual(a.call("POST", "/api/admin/networks", {"name": "msk3", "subnet_id": sub["id"], "kind": "local"})[0], 400)
        # Привязка: выбивающаяся станция в расчёт не берётся, её невязка видна
        status, got, _ = a.call("POST", base + "/link", {})
        self.assertEqual(status, 200, got)
        link = got["link"]
        self.assertEqual(link["used"], ["LNK0", "LNK1", "LNK2", "LNK3"])
        self.assertLess(link["rms_plan"], 0.001)
        self.assertFalse(link["residuals"]["LNK4"]["used"])
        r = link["residuals"]["LNK4"]
        self.assertTrue(3.6 < (r["e"] ** 2 + r["n"] ** 2 + r["u"] ** 2) ** 0.5 < 3.7, r)
        self.assertEqual((link["mode"], link["params"]["rx"], link["params"]["tx"]), ("shift", 0.0, -1.734))
        self.assertEqual(a.call("POST", base + "/link", {"stations": ["LNK0", "LNK1"]})[0], 400)
        # Все семь параметров: станций нужно не меньше пяти, с отмеченными руками — считается
        self.assertEqual(a.call("POST", base + "/link", {"mode": "full"})[0], 400)
        status, got, _ = a.call("POST", base + "/link", {"mode": "full", "stations": [f"LNK{i}" for i in range(5)]})
        self.assertEqual((status, got["link"]["mode"], len(got["link"]["used"])), (200, "full", 5))
        self.assertEqual(a.call("POST", base + "/link", {})[1]["link"]["used"], ["LNK0", "LNK1", "LNK2", "LNK3"])
        # Станция основной сети по умолчанию раздаёт поток как пришёл; с отметкой — координаты из каталога
        self.assertEqual(a.call("POST", "/api/admin/mountpoints", {"name": "LNK0", "station_id": made[0]["id"]})[0], 201)
        plain = lambda: next(p["position"] for p in a.call("GET", "/internal/directory", headers=key)[1]["mountpoints"] if p["name"] == "LNK0")
        self.assertIsNone(plain())
        self.assertEqual(a.call("PATCH", f"/api/admin/stations/{made[0]['id']}", {"send_catalog": True})[0], 200)
        self.assertEqual(plain(), [made[0]["x"], made[0]["y"], made[0]["z"]])
        self.assertEqual(a.call("PATCH", f"/api/admin/stations/{made[0]['id']}", {"send_catalog": False})[0], 200)
        self.assertIsNone(plain())
        status, res, _ = a.call("POST", "/api/admin/stations", {"code": "NOXYZ", "source_mode": "listen", "source_port": 2170, "send_catalog": True})
        self.assertEqual(status, 400, res)
        self.assertIn("X, Y и Z", res["error"])
        # Из одной расчётного модуля — две сети: чистые координаты и пересчитанные в систему основной сети
        status, pure, _ = a.call("POST", "/api/admin/networks", {"name": "itrf3", "subnet_id": sub["id"], "kind": "itrf"})
        self.assertEqual(status, 201, pure)
        self.assertEqual(a.call("POST", "/api/admin/networks/preview", {"subnet_id": sub["id"], "kind": "local"})[1]["stations"], 5)
        status, net, _ = a.call("POST", "/api/admin/networks", {"name": "msk3", "subnet_id": sub["id"], "kind": "local"})
        self.assertEqual(status, 201, net)
        self.assertEqual((net["version"], net["release"]["mode"], len(net["points"])), (1, "shift", 5))
        where = lambda: {p["name"]: p["position"] for p in a.call("GET", "/internal/directory", headers=key)[1]["mountpoints"]}
        points = where()
        self.assertEqual(points["ITRF3_LNK2"], [round(v, 4) for v in true[2]])
        for got_v, want in zip(points["MSK3_LNK2"], (made[2]["x"], made[2]["y"], made[2]["z"])):
            self.assertAlmostEqual(got_v, float(want), delta=0.001)
        # У выбивающейся станции координаты согласованы с остальными, а не с каталогом
        self.assertGreater(abs(points["MSK3_LNK4"][0] - float(made[4]["x"])), 1.0)
        # Третий вид: координаты базы в ITRF2014, а привязка уходит роверу сообщениями пересчёта
        look = a.call("POST", "/api/admin/networks/preview", {"subnet_id": sub["id"], "kind": "itrf_msk"})[1]
        self.assertEqual((look["plan"]["kind"], look["plan"]["params"]["tx"], look["plan"]["transform"]["target"]), ("itrf_msk", -1.734, "msk66"))
        area = look["plan"]["transform"]["area"]
        self.assertTrue(55 < area["lat"] < 60 and area["dLon"] > 1, area)
        self.assertEqual(look["plan"]["recipe"], {"source": "subnet", "coords": "itrf2014", "transform": "msk66", "stations": None, "systems": ["G", "R", "E", "C"], "rate": 1, "near": True, "igd": "g2008", "vrs": None})
        status, both, _ = a.call("POST", "/api/admin/networks", {"name": "auto3", "subnet_id": sub["id"], "kind": "itrf_msk"})
        self.assertEqual(status, 201, both)
        got = {p["name"]: p for p in a.call("GET", "/internal/directory", headers=key)[1]["mountpoints"]}
        self.assertEqual(got["AUTO3_LNK2"]["position"], [round(v, 4) for v in true[2]])
        self.assertEqual((got["AUTO3_LNK2"]["transform"]["target"], got["AUTO3_LNK2"]["transform"]["link"]["tx"], got["AUTO3_LNK2"]["filter"]), ("msk66", -1.734, None))
        self.assertIsNone(got["ITRF3_LNK2"]["transform"])
        self.assertIsNone(got["MSK3_LNK2"]["transform"])
        # Свой порт раздачи: точки сети уходят на него; общий порт и занятые сервером не годятся
        for bad, text in ((2115, "приём станций"), (8110, "служебные"), (80, "от 1024")):
            status, res, _ = a.call("PATCH", f"/api/admin/networks/{both['id']}", {"port": bad})
            self.assertEqual(status, 400, res)
            self.assertIn(text, res["error"])
        status, both, _ = a.call("PATCH", f"/api/admin/networks/{both['id']}", {"port": 2102})
        self.assertEqual((status, both["port"]), (200, 2102))
        ports = {p["name"]: p["port"] for p in a.call("GET", "/internal/directory", headers=key)[1]["mountpoints"]}
        self.assertEqual((ports["AUTO3_LNK2"], ports["MSK3_LNK2"], ports["LNK0"]), (2102, None, None))
        # У каждой сети есть точка «ближайшая база» — на порту сети, со всеми её точками
        auto = {x["name"]: x for x in a.call("GET", "/internal/directory", headers=key)[1]["auto"]}
        self.assertEqual((auto["AUTO3_NEAR"]["port"], len(auto["AUTO3_NEAR"]["points"]), auto["MSK3_NEAR"]["port"]), (2102, 5, None))
        self.assertIn("AUTO3_LNK2", auto["AUTO3_NEAR"]["points"])
        self.assertIsNone(a.call("PATCH", f"/api/admin/networks/{both['id']}", {"port": 2101})[1]["port"], "общий порт — значит без своего")
        # Пересчёт привязки в расчётном модуле выпущенную сеть не меняет, пока не выпущена новая версия
        self.assertEqual(a.call("POST", base + "/link", {"mode": "shift", "stations": ["LNK0", "LNK1", "LNK4"]})[0], 200)
        self.assertEqual(where()["MSK3_LNK2"], points["MSK3_LNK2"])
        look = a.call("POST", "/api/admin/networks/preview", {"network_id": net["id"]})[1]
        self.assertTrue(1.0 < look["max_shift"] < 1.5 and not look["added"] and not look["gone"], look)
        status, net, _ = a.call("POST", f"/api/admin/networks/{net['id']}/release", {})
        self.assertEqual((status, net["version"]), (200, 2))
        # У сети с пересчётом в потоке координаты те же, но параметры другие — это тоже новая версия
        look = a.call("POST", "/api/admin/networks/preview", {"network_id": both["id"]})[1]
        self.assertEqual((look["max_shift"], look["params_changed"]), (0.0, True))
        status, both, _ = a.call("POST", f"/api/admin/networks/{both['id']}/release", {})
        self.assertEqual((status, both["version"]), (200, 2))
        self.assertEqual(a.call("POST", f"/api/admin/networks/{both['id']}/release", {})[0], 400)
        self.assertNotEqual(where()["MSK3_LNK2"], points["MSK3_LNK2"])
        # Возврат прежней версии: координаты как в первой, версия — третья
        status, net, _ = a.call("POST", f"/api/admin/networks/{net['id']}/rollback", {"version": 1})
        self.assertEqual((status, net["version"], net["release"]["restored"], [h["version"] for h in net["history"]]), (200, 3, 1, [3, 2, 1]))
        self.assertEqual(where()["MSK3_LNK2"], points["MSK3_LNK2"])
        self.assertEqual(a.call("POST", f"/api/admin/networks/{net['id']}/rollback", {"version": 9})[0], 400)
        got = next(s for s in a.call("GET", "/api/admin/subnets")[1] if s["id"] == sub["id"])
        self.assertEqual(sorted(n["name"] for n in got["networks"]), ["AUTO3", "ITRF3", "MSK3"])
        for n in (pure, net, both):
            self.assertEqual(a.call("DELETE", f"/api/admin/networks/{n['id']}")[0], 200)
        self.assertEqual(a.call("POST", base + "/ppp/clear", {})[1]["ppp_mean"]["days"], [])
        self.assertEqual(a.call("DELETE", base)[0], 200)
        for st in made:
            self.assertEqual(a.call("DELETE", f"/api/admin/stations/{st['id']}")[0], 200)

    def test_09g_network_blocks(self):
        """Сеть раздачи как конструктор: станции, координаты, пересчёт, спутники, частота, ближайшая база."""
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        true = [[XYZ["x"] + dx, XYZ["y"] + dy, XYZ["z"] + dz] for dx, dy, dz in ((0, 0, 0), (60000, -20000, 5000), (-30000, 50000, -8000))]
        made = []
        for i, t in enumerate(true):
            status, st, _ = a.call("POST", "/api/admin/stations", {"code": f"BLK{i}", "source_mode": "listen", "source_port": 2190 + i})
            self.assertEqual(status, 201, st)
            made.append(st)
        status, sub, _ = a.call("POST", "/api/admin/subnets", {"name": "blocks", "station_ids": [s["id"] for s in made]})
        self.assertEqual(status, 201, sub)
        base = f"/api/admin/subnets/{sub['id']}"
        # Координаты расчётного модуля — из разового PPP-AR, эпоха 2026,76; привязки нет
        self.assertEqual(a.call("POST", base + "/ppp/start", {})[0], 200)
        job = next(j for j in a.call("GET", "/internal/solver", headers=key)[1]["ppp"] if j["id"] == sub["id"])
        res = {"epoch": 2026.76, "stations": {f"BLK{i}": {"x": t[0], "y": t[1], "z": t[2], "x14": t[0], "y14": t[1], "z14": t[2], "sd": [0.002] * 3, "fixed": True, "hours": 6} for i, t in enumerate(true)}}
        self.assertEqual(a.call("POST", "/internal/solver", {"kind": "ppp", "id": sub["id"], "startedAt": job["startedAt"], "results": res, "final": True}, key)[1], {"stored": True})
        self.assertEqual(a.call("POST", base + "/ppp/accept", {})[0], 200)
        look = lambda recipe: a.call("POST", "/api/admin/networks/preview", {"subnet_id": sub["id"], "recipe": recipe})
        # Недопустимые сочетания блоков объясняются словами
        for recipe, text in (({"coords": "net1"}, "привязку"), ({"coords": "itrf2014", "transform": "msk66"}, "привязку"),
                             ({"coords": "gsk2011", "transform": "sk42"}, "второй раз"), ({"systems": ["R", "E"]}, "Без GPS"),
                             ({"rate": 3}, "Частота"), ({"stations": ["NOPE"]}, "проверьте блок")):
            status, got, _ = look(recipe)
            self.assertEqual(status, 400, (recipe, got))
            self.assertIn(text, got["error"])
        # ITRF2020 отличается от ITRF2014 на миллиметры; ГСК-2011 — на десятки сантиметров (плита уехала)
        make = lambda name, recipe: a.call("POST", "/api/admin/networks", {"name": name, "subnet_id": sub["id"], "recipe": recipe})
        status, n20, _ = make("b20", {"coords": "itrf2020", "stations": ["BLK0", "BLK1"], "systems": ["G", "R"], "rate": 2, "near": False})
        self.assertEqual(status, 201, n20)
        self.assertEqual((n20["kind"], sorted(p["name"] for p in n20["points"]), n20["recipe"]["rate"]), ("itrf", ["B20_BLK0", "B20_BLK1"], 2))
        moved = lambda n, code, i: sum((n["release"]["stations"][code][k] - true[i][j]) ** 2 for j, k in enumerate("xyz")) ** 0.5
        self.assertTrue(0.002 < moved(n20, "BLK0", 0) < 0.008, moved(n20, "BLK0", 0))
        status, ngsk, _ = make("bgsk", {"coords": "gsk2011"})
        self.assertEqual(status, 201, ngsk)
        self.assertTrue(0.35 < moved(ngsk, "BLK0", 0) < 0.5, moved(ngsk, "BLK0", 0))
        # Пересчёт в ГСК-2011 в потоке привязки не требует: параметры — движение плиты за эпоху
        status, nflow, _ = make("bflow", {"coords": "itrf2020", "transform": "gsk2011"})
        self.assertEqual(status, 201, nflow)
        self.assertEqual((nflow["kind"], nflow["release"]["transform"]["target"], nflow["release"]["transform"]["source"], nflow["release"]["transform"]["link"]["tx"]),
                         ("itrf_msk", "gsk2011", "ITRF2020", -0.0014))
        d = a.call("GET", "/internal/directory", headers=key)[1]
        points = {p["name"]: p for p in d["mountpoints"]}
        self.assertEqual((points["B20_BLK1"]["filter"], points["B20_BLK1"]["transform"], points["BGSK_BLK1"]["filter"]), ({"systems": ["G", "R"], "rate": 2}, None, None))
        self.assertEqual(points["BFLOW_BLK2"]["transform"]["epoch"], 2026.76)
        # Параметры ИГД: редакция стандарта проверяется; без пересчёта в МСК-66 или СК-42 она не нужна
        self.assertIn("Параметры ИГД", look({"coords": "itrf2014", "igd": "g1999"})[1]["error"])
        self.assertEqual(look({"coords": "itrf2020", "transform": "gsk2011", "igd": "g2001"})[1]["plan"]["recipe"]["igd"], "g2008")
        names = [x["name"] for x in d["auto"]]
        self.assertTrue("BGSK_NEAR" in names and "BFLOW_NEAR" in names and "B20_NEAR" not in names, names)
        # Смена блока — новая версия: станция добавлена, спутники все; без изменений версия не выпускается
        status, n20, _ = a.call("POST", f"/api/admin/networks/{n20['id']}/release", {"recipe": {"coords": "itrf2020", "systems": ["G", "R", "E", "C"], "rate": 2, "near": True}})
        self.assertEqual((status, n20["version"], len(n20["points"]), n20["recipe"]["stations"]), (200, 2, 3, None))
        self.assertEqual(a.call("POST", f"/api/admin/networks/{n20['id']}/release", {})[0], 400)
        preview = a.call("POST", "/api/admin/networks/preview", {"network_id": n20["id"], "recipe": {"coords": "itrf2020", "rate": 5}})[1]
        self.assertEqual((preview["params_changed"], preview["max_shift"], preview["plan"]["filter"]["rate"]), (True, 0.0, 5))
        # Возврат первой версии возвращает и её состав
        status, n20, _ = a.call("POST", f"/api/admin/networks/{n20['id']}/rollback", {"version": 1})
        self.assertEqual((status, n20["version"], n20["recipe"]["systems"], len(n20["points"])), (200, 3, ["G", "R"], 2))
        # Сеть прямо из основной сети, без расчётного модуля и расчётов: те же координаты, но свои станции и состав
        self.assertEqual(a.call("PATCH", f"/api/admin/stations/{made[0]['id']}", {"x": true[0][0], "y": true[0][1], "z": true[0][2], "send_catalog": True})[0], 200)
        self.assertEqual(a.call("POST", "/api/admin/mountpoints", {"name": "BLK0", "station_id": made[0]["id"], "rtcm_station_id": 18})[0], 201)
        status, nmain, _ = a.call("POST", "/api/admin/networks", {"name": "part", "recipe": {"source": "main", "coords": "itrf2020", "transform": "sk42", "stations": ["BLK0", "BLK2"], "systems": ["G", "R"]}})
        self.assertEqual(status, 201, nmain)
        self.assertEqual((nmain["subnet"], nmain["kind"], nmain["recipe"]["coords"], nmain["recipe"]["transform"], sorted(p["name"] for p in nmain["points"])),
                         (None, "local", "stream", "none", ["PART_BLK0", "PART_BLK2"]))
        d = a.call("GET", "/internal/directory", headers=key)[1]
        points = {p["name"]: p for p in d["mountpoints"]}
        # Координаты — как у обычной точки: из каталога, где включена подмена, иначе как шлёт база
        self.assertEqual((points["PART_BLK0"]["position"], points["PART_BLK0"]["stationId"], points["PART_BLK2"]["position"], points["PART_BLK2"]["stationId"]),
                         ([round(v, 4) for v in true[0]], 18, None, None))
        self.assertEqual((points["PART_BLK2"]["filter"], points["PART_BLK2"]["transform"]), ({"systems": ["G", "R"], "rate": 1}, None))
        self.assertIn("PART_NEAR", [x["name"] for x in d["auto"]])
        status, nmain, _ = a.call("POST", f"/api/admin/networks/{nmain['id']}/release", {"recipe": {"source": "main", "stations": ["BLK0", "BLK1", "BLK2"], "rate": 5}})
        self.assertEqual((status, nmain["version"], len(nmain["points"]), nmain["recipe"]["rate"]), (200, 2, 3, 5))
        # Источник готовой сети можно сменить: из основной сети — на расчётный модуль и обратно возвратом версии
        swap = {"source": "subnet", "coords": "itrf2014", "stations": ["BLK0", "BLK1", "BLK2"]}
        look2 = a.call("POST", "/api/admin/networks/preview", {"network_id": nmain["id"], "subnet_id": sub["id"], "recipe": swap})[1]
        self.assertEqual((look2["source_changed"], look2["params_changed"], look2["stations"]), (True, True, 3), look2)
        status, nmain, _ = a.call("POST", f"/api/admin/networks/{nmain['id']}/release", {"recipe": swap, "subnet_id": sub["id"]})
        self.assertEqual((status, nmain["version"], nmain["subnet"], nmain["subnet_id"], nmain["recipe"]["source"], sorted(p["name"] for p in nmain["points"])),
                         (200, 3, "BLOCKS", sub["id"], "subnet", ["PART_BLK0", "PART_BLK1", "PART_BLK2"]), nmain)
        self.assertEqual(round(nmain["release"]["stations"]["BLK1"]["x"], 4), round(true[1][0], 4))
        points = {p["name"]: p for p in a.call("GET", "/internal/directory", headers=key)[1]["mountpoints"]}
        self.assertEqual(points["PART_BLK1"]["position"], [round(v, 4) for v in true[1]])
        status, nmain, _ = a.call("POST", f"/api/admin/networks/{nmain['id']}/rollback", {"version": 2})
        self.assertEqual((status, nmain["version"], nmain["subnet"], nmain["subnet_id"], nmain["recipe"]["source"]), (200, 4, None, None, "main"), nmain)
        self.assertEqual(a.call("POST", "/api/admin/networks", {"name": "nosrc", "recipe": {"coords": "itrf2014"}})[0], 400, "без расчётного модуля и не из основной сети")
        self.assertEqual(a.call("DELETE", base)[0], 200)
        for n in (n20, ngsk, nflow, nmain):
            self.assertEqual(a.call("DELETE", f"/api/admin/networks/{n['id']}")[0], 200)
        for st in made:
            self.assertEqual(a.call("DELETE", f"/api/admin/stations/{st['id']}")[0], 200)

    def test_09h_vrs(self):
        """Виртуальные базы: включаются у сети сразу, без нового выпуска; служба VRS получает станции с координатами
        для расчёта и для объявления роверу; у раздачи появляется точка ИМЯ_VRS."""
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        true = [[XYZ["x"] + dx, XYZ["y"] + dy, XYZ["z"] + dz] for dx, dy, dz in ((0, 0, 0), (40000, -20000, 5000), (-30000, 30000, -8000))]
        made = []
        for i, t in enumerate(true):
            status, st, _ = a.call("POST", "/api/admin/stations", {"code": f"VR{i}", "source_mode": "listen", "source_port": 2180 + i})
            self.assertEqual(status, 201, st)
            made.append(st)
        status, sub, _ = a.call("POST", "/api/admin/subnets", {"name": "vrs", "station_ids": [s["id"] for s in made]})
        self.assertEqual(status, 201, sub)
        base = f"/api/admin/subnets/{sub['id']}"
        self.assertEqual(a.call("POST", base + "/ppp/start", {})[0], 200)
        job = next(j for j in a.call("GET", "/internal/solver", headers=key)[1]["ppp"] if j["id"] == sub["id"])
        res = {"epoch": 2026.76, "stations": {f"VR{i}": {"x": t[0], "y": t[1], "z": t[2], "x14": t[0], "y14": t[1], "z14": t[2], "sd": [0.002] * 3, "fixed": True, "hours": 6} for i, t in enumerate(true)}}
        self.assertEqual(a.call("POST", "/internal/solver", {"kind": "ppp", "id": sub["id"], "startedAt": job["startedAt"], "results": res, "final": True}, key)[1], {"stored": True})
        self.assertEqual(a.call("POST", base + "/ppp/accept", {})[0], 200)
        status, n, _ = a.call("POST", "/api/admin/networks", {"name": "vnet", "subnet_id": sub["id"], "port": 2105, "recipe": {"coords": "itrf2020"}})
        self.assertEqual((status, n["recipe"]["vrs"]), (201, None), n)
        self.assertEqual(a.call("GET", "/internal/vrs", headers=key)[1], {"networks": []})
        self.assertEqual(a.call("GET", "/internal/directory", headers=key)[1]["virtual"], [])
        # Включение — по умолчанию; версия сети не меняется
        url = f"/api/admin/networks/{n['id']}/vrs"
        status, n, _ = a.call("POST", url, {"options": True})
        self.assertEqual((status, n["version"], n["recipe"]["vrs"]["method"], n["recipe"]["vrs"]["aux"], n["release"]["vrs"]["antenna"]), (200, 1, "plane", 3, "ADVNULLANTENNA"), n)
        tasks = a.call("GET", "/internal/vrs", headers=key)[1]["networks"]
        self.assertEqual((len(tasks), tasks[0]["name"], [s["code"] for s in tasks[0]["stations"]], tasks[0]["options"]["maxKm"]), (1, "VNET_VRS", ["VR0", "VR1", "VR2"], 90))
        # Расчёт идёт в принятых координатах (ITRF2014), роверу объявляются координаты сети (ITRF2020): разница — миллиметры
        s0 = tasks[0]["stations"][0]
        self.assertEqual([round(v, 4) for v in s0["ecef"]], [round(v, 4) for v in true[0]])
        shift = sum((p - q) ** 2 for p, q in zip(s0["ecef"], s0["out"])) ** 0.5
        self.assertTrue(0.002 < shift < 0.008, shift)
        d = a.call("GET", "/internal/directory", headers=key)[1]
        self.assertEqual(d["virtual"], [{"name": "VNET_VRS", "port": 2105, "transform": None}])
        # Настройки: негодные объясняются словами, годные действуют сразу
        for options, text in (({"aux": 9}, "от 1 до 6"), ({"method": "magic"}, "Способ"), ({"systems": []}, "хотя бы одну"), ({"aux": 1, "minAux": 2}, "Минимум соседей"),
                              ({"antenna": "антенна"}, "латиница"), ({"mask": "низко"}, "нужно число")):
            status, got, _ = a.call("POST", url, {"options": options})
            self.assertEqual(status, 400, (options, got))
            self.assertIn(text, got["error"])
        status, n, _ = a.call("POST", url, {"options": {"method": "idw", "aux": 4, "systems": ["E", "G"], "mask": "12", "rate": 2, "gradPpm": "7,5", "strict": False}})
        o = n["recipe"]["vrs"]
        self.assertEqual((status, o["method"], o["aux"], o["systems"], o["mask"], o["rate"], o["gradPpm"], o["strict"], n["version"]), (200, "idw", 4, ["G", "E"], 12, 2, 7.5, False, 1))
        # Станция, выключенная в сети, в расчёт виртуальных баз не идёт
        point = next(p for p in n["points"] if p["station"] == "VR2")
        self.assertEqual(a.call("PATCH", f"/api/admin/mountpoints/{point['id']}", {"enabled": False})[0], 200)
        self.assertEqual([s["code"] for s in a.call("GET", "/internal/vrs", headers=key)[1]["networks"][0]["stations"]], ["VR0", "VR1"])
        # Новый выпуск сети настройки виртуальных баз сохраняет
        status, n, _ = a.call("POST", f"/api/admin/networks/{n['id']}/release", {"recipe": {**n["recipe"], "rate": 5}})
        self.assertEqual((status, n["version"], n["release"]["vrs"]["method"], n["recipe"]["rate"]), (200, 2, "idw", 5), n)
        # Переименование сети: вслед за ней меняются имена её точек и точки виртуальной базы
        for bad in ("a_b", "", "слишком", "ABCDEFGHIJKLM"):
            self.assertEqual(a.call("PATCH", f"/api/admin/networks/{n['id']}", {"name": bad})[0], 400, bad)
        status, n, _ = a.call("PATCH", f"/api/admin/networks/{n['id']}", {"name": "66gsk"})
        self.assertEqual((status, n["name"], n["version"], sorted(p["name"] for p in n["points"])), (200, "66GSK", 2, ["66GSK_VR0", "66GSK_VR1", "66GSK_VR2"]), n)
        self.assertEqual(a.call("GET", "/internal/vrs", headers=key)[1]["networks"][0]["name"], "66GSK_VRS")
        self.assertEqual(a.call("GET", "/internal/directory", headers=key)[1]["virtual"][0]["name"], "66GSK_VRS")
        self.assertEqual(a.call("PATCH", f"/api/admin/networks/{n['id']}", {"name": "66GSK"})[0], 200, "то же имя — ничего не меняется")
        status, n, _ = a.call("PATCH", f"/api/admin/networks/{n['id']}", {"name": "VNET", "title": "обратно"})
        self.assertEqual((status, n["name"], n["title"], n["release"]["vrs"]["method"]), (200, "VNET", "обратно", "idw"), n)
        # Состояние службы и список настроек для панели: служба в тесте не запущена
        status, got, _ = a.call("GET", "/api/admin/vrs")
        self.assertEqual((status, got["up"], got["options"][0]["key"]), (200, False, "systems"))
        # Логин с подпиской на сеть получает право и на её виртуальную базу; выключение убирает точку
        status, n, _ = a.call("POST", url, {"options": None})
        self.assertEqual((status, n["recipe"]["vrs"], n["release"]["vrs"]), (200, None, None))
        self.assertEqual(a.call("GET", "/internal/directory", headers=key)[1]["virtual"], [])
        self.assertEqual(a.call("GET", "/internal/vrs", headers=key)[1], {"networks": []})
        self.assertEqual(a.call("DELETE", f"/api/admin/networks/{n['id']}")[0], 200)
        self.assertEqual(a.call("DELETE", base)[0], 200)
        for st in made:
            self.assertEqual(a.call("DELETE", f"/api/admin/stations/{st['id']}")[0], 200)

    def test_09f_fix_stats(self):
        """Статистика фикса: раздача присылает её с сеансом, сводка считается по расстоянию до базы."""
        import time
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        now = time.time() * 1000
        events = []
        for i, fix in enumerate([{"ttf": 8.0, "fixed": 900, "float": 60, "other": 40, "lost": 1, "km": 4.2, "kmFix": 4.2, "age": 1.1, "ageMax": 3.0},
                                 {"ttf": 20.0, "fixed": 500, "float": 400, "other": 100, "lost": 0, "km": 7.9, "age": 1.5, "ageMax": 2.0},
                                 {"ttf": None, "fixed": 0, "float": 300, "other": 100, "lost": 0, "km": 41.0, "age": 2.0, "ageMax": 9.0, "bases": ["A", "B"]},
                                 {"ttf": 3.0, "fixed": 20, "float": 5, "other": 5, "lost": 0, "km": 2.0}]):
            events.append({"t": "open", "id": f"fix-{i}", "at": now - 3600e3, "login": "nobody", "point": "NEAR", "station": "", "address": "10.0.0.9"})
            events.append({"t": "close", "id": f"fix-{i}", "at": now - 1800e3, "login": "nobody", "bytes": 1000, "reason": "ровер отключился", "fix": fix, "station": "B" if i == 2 else "A"})
        self.assertEqual(a.call("POST", "/internal/events", {"events": events}, key)[1]["recorded"], 8)
        got = a.call("GET", "/api/admin/fix-stats?days=7")[1]
        near, far = got["bins"][0], got["bins"][3]
        # Короткий сеанс (полминуты) в счёт не идёт
        self.assertEqual((got["sessions"], near["sessions"], near["with_fix"], near["ttf_median"], near["ttf_worst"]), (3, 2, 2, 20.0, 20.0))
        self.assertEqual((near["fixed_share"], near["lost_per_hour"], near["age"]), (0.7, 2.57, 1.3))
        self.assertEqual((far["sessions"], far["with_fix"], far["ttf_median"], far["fixed_share"], far["lost_per_hour"]), (1, 0, None, 0.0, None))
        row = next(s for s in a.call("GET", "/api/admin/sessions?limit=50")[1]["items"] if s["caster_id"] == "fix-2")
        self.assertEqual((row["mountpoint"], row["station"], row["fix"]["bases"]), ("NEAR", "B", ["A", "B"]))

    def test_09e_outages(self):
        """Журнал обрывов: события от приёма, простой сервера отдельно, сводка по станциям."""
        import time
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        status, st, _ = a.call("POST", "/api/admin/stations", {"code": "OUT1", "source_mode": "listen", "source_port": 2180})
        self.assertEqual(status, 201, st)
        now = time.time() * 1000
        post = lambda events, alive=None: a.call("POST", "/internal/outages", {"events": events, "alive": alive}, key)[1]["recorded"]
        self.assertEqual(a.call("POST", "/internal/outages", {"events": []})[0], 404, "без ключа адрес закрыт")
        # Обрыв на минуту четверть часа назад и второй, который ещё длится
        self.assertEqual(post([{"t": "down", "station": "OUT1", "at": now - 900e3, "reason": "ждём данные", "source": "напрямую"},
                               {"t": "up", "station": "OUT1", "at": now - 840e3, "reason": "соединение закрыто"},
                               {"t": "down", "station": "OUT1", "at": now - 30e3, "reason": "нет ответа", "source": "напрямую"},
                               {"t": "down", "station": "OUT1", "at": now - 20e3, "reason": "повтор"}, {"t": "down", "station": "плохой код", "at": now}], alive=now - 10e3), 4)
        got = next(s for s in a.call("GET", "/api/admin/outages?hours=24")[1]["stations"] if s["code"] == "OUT1")
        self.assertEqual((got["count"], got["open"], got["source"], len(got["items"])), (2, True, "напрямую", 2))
        self.assertEqual((got["items"][0]["reason"], round(got["items"][0]["seconds"])), ("соединение закрыто", 60))
        self.assertTrue(85 <= got["down_s"] <= 95 and got["longest_s"] == 60.0, got)
        # Перезапуск приёма: открытый обрыв станции остаётся её обрывом; у станций на связи — простой сервера
        self.assertEqual(post([{"t": "up", "station": "OUT1", "at": now - 9e3}], alive=now - 9e3), 1)
        self.assertEqual(post([{"t": "start", "at": now + 60e3}, {"t": "up", "station": "OUT1", "at": now + 62e3}], alive=now + 62e3), 2)
        got = next(s for s in a.call("GET", "/api/admin/outages?hours=24")[1]["stations"] if s["code"] == "OUT1")
        self.assertEqual((got["count"], got["open"], [i["kind"] for i in got["items"]]), (2, False, ["link", "link", "service"]))
        self.assertEqual(a.call("DELETE", f"/api/admin/stations/{st['id']}")[0], 200)

    def test_09i_access(self):
        """Доступы: перенос логинов из прежней программы, список с состояниями и правка срока одним действием."""
        a = self.admin
        key = {"X-Ural-Key": "internal-test-key"}
        today = dt.date.today()
        items = [
            {"login": "nrs_live", "password": "ab", "ends_on": (today + dt.timedelta(days=200)).isoformat(), "max_sessions": 512, "org": "Геострой", "phone": "+7 900", "last_seen": "2026-10-01"},
            {"login": "nrs_old", "password": "nrs_old", "ends_on": "2024-03-01", "max_sessions": 2},
            {"login": "NRS_Live", "password": "whatever", "ends_on": "2030-01-01"},
            {"login": "bad login", "password": "x", "ends_on": "2030-01-01"},
            {"login": "nrs_space", "password": "a b", "ends_on": "2030-01-01"},
        ]
        status, res, _ = a.call("POST", "/api/admin/access/import", {"items": items})
        self.assertEqual(status, 200, res)
        self.assertEqual((res["created"], res["skipped"], [x["login"] for x in res["invalid"]]), (2, ["NRS_Live"], ["bad login", "nrs_space"]))
        self.assertNotIn("password", json.dumps(res))
        # Повторный перенос ничего не задваивает
        self.assertEqual(a.call("POST", "/api/admin/access/import", {"items": items})[1]["created"], 0)

        got = a.call("GET", "/api/admin/access")[1]
        rows = {r["login"]: r for r in got["items"]}
        live, old = rows["nrs_live"], rows["nrs_old"]
        self.assertEqual((live["state"], live["max_sessions"], live["client"], live["phone"], live["weak"], live["days_left"]), ("active", 100, "Геострой", "+7 900", "short", 200))
        self.assertEqual((old["state"], old["weak"], old["client"], old["ends_on"]), ("expired", "same", "nrs_old", "2024-03-01"))
        self.assertTrue(live["last_seen_at"].startswith("2026-10-01"))
        self.assertNotIn("password", json.dumps(got))
        self.assertEqual(got["counts"]["weak"], sum(1 for r in got["items"] if r["weak"]))

        # Раздача: прежний короткий пароль работает, истёкший логин точек не получает
        users = Client(self.base).call("GET", "/internal/directory", headers=key)[1]["users"]
        self.assertEqual(users["nrs_live"]["password"], "ab")
        self.assertEqual((users["nrs_old"]["mountpoints"], users["nrs_old"]["expires"]), ([], "2000-01-01"))

        # Продление истёкшего считается от сегодняшнего дня и сразу открывает доступ
        status, row, _ = a.call("POST", f"/api/admin/access/{old['id']}", {"add_days": 30, "max_sessions": 4, "phone": "+7 911", "client": "ИП Старый"})
        self.assertEqual(status, 200, row)
        self.assertEqual((row["state"], row["days_left"], row["max_sessions"], row["phone"], row["client"]), ("expiring" if got["expiring_days"] >= 30 else "active", 30, 4, "+7 911", "ИП Старый"))
        self.assertNotEqual(Client(self.base).call("GET", "/internal/directory", headers=key)[1]["users"]["nrs_old"]["expires"], "2000-01-01")
        # Срок датой, приостановка с причиной, выключение логина
        row = a.call("POST", f"/api/admin/access/{old['id']}", {"ends_on": "2031-05-05"})[1]
        self.assertEqual((row["ends_on"], row["state"]), ("2031-05-05", "active"))
        self.assertEqual(a.call("POST", f"/api/admin/access/{old['id']}", {"suspended": True})[0], 400, "без причины не приостанавливается")
        row = a.call("POST", f"/api/admin/access/{old['id']}", {"suspended": True, "reason": "долг"})[1]
        self.assertEqual((row["state"], row["suspend_reason"]), ("suspended", "долг"))
        self.assertEqual(a.call("POST", f"/api/admin/access/{old['id']}", {"suspended": False})[1]["state"], "active")
        self.assertEqual(a.call("POST", f"/api/admin/access/{old['id']}", {"active": False})[1]["state"], "off")
        self.assertEqual(a.call("POST", "/api/admin/access/999999", {"active": False})[0], 404)
        # Одно действие над несколькими логинами: служебному срок не ставится, остальные продлеваются
        staff = a.call("POST", "/api/admin/logins", {"login": "bulk-staff", "staff": True, "password": "staff-pass"})[1]
        a.call("POST", f"/api/admin/access/{old['id']}", {"active": True})
        before = {r["id"]: r for r in a.call("GET", "/api/admin/access")[1]["items"]}
        status, res, _ = a.call("POST", "/api/admin/access/bulk", {"ids": [live["id"], old["id"], staff["id"], live["id"], 999999], "add_days": 10})
        self.assertEqual(status, 200, res)
        self.assertEqual((res["done"], sorted(x["login"] for x in res["failed"])), (2, ["bulk-staff", "№999999"]))
        after = {r["id"]: r for r in a.call("GET", "/api/admin/access")[1]["items"]}
        self.assertEqual([after[i]["days_left"] - before[i]["days_left"] for i in (live["id"], old["id"])], [10, 10])
        res = a.call("POST", "/api/admin/access/bulk", {"ids": [live["id"], old["id"]], "active": False, "max_sessions": 3})[1]
        self.assertEqual((res["done"], res["failed"]), (2, []))
        after = {r["id"]: r for r in a.call("GET", "/api/admin/access")[1]["items"]}
        self.assertEqual([(after[i]["state"], after[i]["max_sessions"]) for i in (live["id"], old["id"])], [("off", 3), ("off", 3)])
        self.assertEqual(a.call("POST", "/api/admin/access/bulk", {"ids": [live["id"]]})[0], 400, "без действия")
        self.assertEqual(a.call("POST", "/api/admin/access/bulk", {"ids": [], "active": True})[0], 400)

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
