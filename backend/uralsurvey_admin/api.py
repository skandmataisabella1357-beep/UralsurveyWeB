"""Служба управления: HTTP-интерфейс панели администратора поверх базы.

Заменяет прежнюю службу управления на Node.js: отдаёт страницы, собирает состояние
приёма и раздачи, принимает от раздачи журнал сеансов и отдаёт службам справочник.
Наружу служба смотрит только через nginx: сама она слушает 127.0.0.1.
"""

from __future__ import annotations

import hmac
import os
import json
import mimetypes
import pathlib
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import security
from .page import admin_page
from .store import Problem, Store, dumps

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATIC = [
    ("/ui/", ROOT / "app" / "renderer"),
    ("/modules/coordsys/", ROOT / "modules" / "coordsys"),
    ("/modules/layers/", ROOT / "modules" / "layers"),
    ("/", ROOT / "server" / "web"),
]
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8"}
COOKIE = "ural_session"
MAX_BODY = 256 * 1024
LAYER_BODY = 900 * 1024
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


class Attempts:
    """Не больше нескольких неудачных входов в минуту с одного адреса."""

    def __init__(self, limit: int = 5):
        self.limit = limit
        self._items: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allowed(self, ip: str) -> bool:
        now = time.monotonic()
        with self._lock:
            items = [t for t in self._items.get(ip, []) if now - t < 60]
            self._items[ip] = items
            return len(items) < self.limit

    def failed(self, ip: str) -> None:
        with self._lock:
            self._items.setdefault(ip, []).append(time.monotonic())


class App:
    """Маршруты панели. Каждый обработчик получает запрос и возвращает (код, данные)."""

    def __init__(self, store: Store, ingest_url: str = "", caster_url: str = "", internal_key: str = ""):
        self.solver_url = os.environ.get("URAL_SOLVER", "")
        self.store = store
        self.ingest_url = ingest_url
        self.caster_url = caster_url
        self.internal_key = internal_key
        self.attempts = Attempts()
        self.started = time.time()
        r = self._route
        # Кто может вызывать: operator — и оператор, и администратор; admin — только администратор
        self.routes = [
            r("GET", r"/api/admin/state", self.state, "operator"),
            r("GET", r"/api/admin/counts", lambda q: (200, store.counts()), "operator"),
            # Администраторы
            r("GET", r"/api/admin/admins", lambda q: (200, store.list_admins()), "admin"),
            r("POST", r"/api/admin/admins", lambda q: (201, store.create_admin(q.who, q.body)), "admin"),
            r("PATCH", r"/api/admin/admins/(\d+)", lambda q: (200, store.update_admin(q.who, q.id, q.body)), "admin"),
            r("DELETE", r"/api/admin/admins/(\d+)", lambda q: (200, store.delete_admin(q.who, q.id) or {}), "admin"),
            # Станции
            r("GET", r"/api/admin/stations", lambda q: (200, store.list_stations()), "operator"),
            r("POST", r"/api/admin/stations", lambda q: (201, store.create_station(q.who, q.body)), "admin"),
            r("POST", r"/api/admin/stations/enabled", lambda q: (200, store.set_stations_enabled(q.who, bool(q.need("enabled")))), "admin"),
            r("GET", r"/api/admin/stations/(\d+)", lambda q: (200, store.get_station(q.id)), "operator"),
            r("PATCH", r"/api/admin/stations/(\d+)", lambda q: (200, store.update_station(q.who, q.id, q.body)), "admin"),
            r("DELETE", r"/api/admin/stations/(\d+)", lambda q: (200, store.delete_station(q.who, q.id) or {}), "admin"),
            # Точки подключения
            r("GET", r"/api/admin/mountpoints", lambda q: (200, store.list_mountpoints()), "operator"),
            r("POST", r"/api/admin/mountpoints", lambda q: (201, store.save_mountpoint(q.who, q.body)), "admin"),
            r("PATCH", r"/api/admin/mountpoints/(\d+)", lambda q: (200, store.save_mountpoint(q.who, q.body, q.id)), "admin"),
            r("DELETE", r"/api/admin/mountpoints/(\d+)", lambda q: (200, store.delete_mountpoint(q.who, q.id) or {}), "admin"),
            # Клиенты
            r("GET", r"/api/admin/layers", lambda q: (200, store.list_layers()), "operator"),
            r("POST", r"/api/admin/layers", lambda q: (201, store.save_layer(q.who, q.body)), "admin"),
            r("GET", r"/api/admin/layers/(\d+)", lambda q: (200, store.get_layer(q.id)), "operator"),
            r("DELETE", r"/api/admin/layers/(\d+)", lambda q: (200, store.delete_layer(q.who, q.id) or {}), "admin"),
            r("POST", r"/api/admin/layers/(\d+)/logins", lambda q: (200, store.set_layer_logins(q.who, q.id, q.body.get("login_ids"))), "admin"),

            r("GET", r"/api/admin/subnets", lambda q: (200, store.list_subnets()), "operator"),
            r("POST", r"/api/admin/subnets", lambda q: (201, store.save_subnet(q.who, q.body)), "admin"),
            r("PATCH", r"/api/admin/subnets/(\d+)", lambda q: (200, store.save_subnet(q.who, q.body, q.id)), "admin"),
            r("DELETE", r"/api/admin/subnets/(\d+)", lambda q: (200, store.delete_subnet(q.who, q.id) or {}), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/start", lambda q: (200, store.subnet_calc(q.who, q.id, True)), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/compute", lambda q: (200, store.subnet_calc(q.who, q.id, True, once=True)), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/ppp/start", lambda q: (200, store.subnet_ppp(q.who, q.id, True)), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/ppp/stop", lambda q: (200, store.subnet_ppp(q.who, q.id, False)), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/stop", lambda q: (200, store.subnet_calc(q.who, q.id, False)), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/accept", lambda q: (200, store.subnet_accept(q.who, q.id, q.body.get("stations"))), "admin"),
            r("GET", r"/api/admin/networks", lambda q: (200, store.list_networks()), "operator"),
            r("POST", r"/api/admin/networks", lambda q: (201, store.network_create(q.who, q.body)), "admin"),
            r("POST", r"/api/admin/networks/preview", lambda q: (200, store.network_preview(q.body)), "admin"),
            r("PATCH", r"/api/admin/networks/(\d+)", lambda q: (200, store.network_update(q.who, q.id, q.body)), "admin"),
            r("DELETE", r"/api/admin/networks/(\d+)", lambda q: (200, store.network_delete(q.who, q.id) or {}), "admin"),
            r("POST", r"/api/admin/networks/(\d+)/release", lambda q: (200, store.network_release(q.who, q.id)), "admin"),
            r("POST", r"/api/admin/networks/(\d+)/rollback", lambda q: (200, store.network_rollback(q.who, q.id, int(q.body.get("version") or 0))), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/ppp/daily", lambda q: (200, store.subnet_ppp_daily(q.who, q.id, bool(q.body.get("on")))), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/ppp/clear", lambda q: (200, store.subnet_ppp_clear(q.who, q.id)), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/ppp/accept", lambda q: (200, store.subnet_accept_ppp(q.who, q.id, q.body.get("stations"))), "admin"),
            r("POST", r"/api/admin/subnets/(\d+)/link", lambda q: (200, store.subnet_link(q.who, q.id, q.body.get("stations"), str(q.body.get("mode") or "shift"))), "admin"),

            r("GET", r"/api/admin/clients", lambda q: (200, store.list_clients(q.arg("search"))), "operator"),
            r("POST", r"/api/admin/clients", lambda q: (201, store.save_client(q.who, q.body)), "admin"),
            r("GET", r"/api/admin/clients/(\d+)", lambda q: (200, store.get_client(q.id)), "operator"),
            r("PATCH", r"/api/admin/clients/(\d+)", lambda q: (200, store.save_client(q.who, q.body, q.id)), "admin"),
            r("DELETE", r"/api/admin/clients/(\d+)", lambda q: (200, store.delete_client(q.who, q.id) or {}), "admin"),
            # Тарифы
            r("GET", r"/api/admin/tariffs", lambda q: (200, store.list_tariffs()), "operator"),
            r("POST", r"/api/admin/tariffs", lambda q: (201, store.save_tariff(q.who, q.body)), "admin"),
            r("PATCH", r"/api/admin/tariffs/(\d+)", lambda q: (200, store.save_tariff(q.who, q.body, q.id)), "admin"),
            r("DELETE", r"/api/admin/tariffs/(\d+)", lambda q: (200, store.delete_tariff(q.who, q.id) or {}), "admin"),
            # Подписки
            r("GET", r"/api/admin/subscriptions", lambda q: (200, store.list_subscriptions(q.int_arg("client_id"), q.arg("state") or None)), "operator"),
            r("GET", r"/api/admin/subscriptions\.csv", self.subscriptions_csv, "operator"),
            r("POST", r"/api/admin/subscriptions", lambda q: (201, store.save_subscription(q.who, q.body)), "admin"),
            r("POST", r"/api/admin/subscriptions/trial", lambda q: (201, store.trial_subscription(q.who, q.need("client_id"), q.need("tariff_id"))), "operator"),
            r("PATCH", r"/api/admin/subscriptions/(\d+)", lambda q: (200, store.save_subscription(q.who, q.body, q.id)), "admin"),
            r("POST", r"/api/admin/subscriptions/(\d+)/extend", lambda q: (200, store.extend_subscription(q.who, q.id, q.body.get("days"), q.body.get("paid"))), "admin"),
            r("POST", r"/api/admin/subscriptions/(\d+)/suspend", lambda q: (200, store.suspend_subscription(q.who, q.id, True, q.body.get("reason", ""))), "admin"),
            r("POST", r"/api/admin/subscriptions/(\d+)/resume", lambda q: (200, store.suspend_subscription(q.who, q.id, False)), "admin"),
            r("DELETE", r"/api/admin/subscriptions/(\d+)", lambda q: (200, store.delete_subscription(q.who, q.id) or {}), "admin"),
            # Логины NTRIP
            r("GET", r"/api/admin/logins", lambda q: (200, store.list_logins(q.int_arg("client_id"), q.arg("search"))), "operator"),
            r("POST", r"/api/admin/logins", lambda q: (201, store.create_login(q.who, q.body)), "admin"),
            r("PATCH", r"/api/admin/logins/(\d+)", lambda q: (200, store.update_login(q.who, q.id, q.body)), "admin"),
            r("POST", r"/api/admin/logins/(\d+)/reveal", lambda q: (200, store.reveal_login_password(q.who, q.id)), "admin"),
            r("POST", r"/api/admin/logins/(\d+)/regenerate", lambda q: (200, store.regenerate_login_password(q.who, q.id)), "admin"),
            r("DELETE", r"/api/admin/logins/(\d+)", lambda q: (200, store.delete_login(q.who, q.id) or {}), "admin"),
            # Журналы
            r("GET", r"/api/admin/sessions", lambda q: (200, store.list_sessions(
                q.arg("login"), q.arg("mountpoint"), q.arg("from"), q.arg("to"), q.arg("open") == "1", q.int_arg("limit") or 200, q.int_arg("offset") or 0)), "operator"),
            r("POST", r"/api/admin/sessions/close", self.close_session, "operator"),
            r("GET", r"/api/admin/outages", lambda q: (200, store.list_outages(q.int_arg("hours") or 24)), "operator"),
            r("GET", r"/api/admin/refusals", lambda q: (200, store.list_refusals(q.arg("login"), q.int_arg("limit") or 200, q.int_arg("offset") or 0)), "operator"),
            r("GET", r"/api/admin/audit", lambda q: (200, store.list_audit(q.arg("admin"), q.arg("entity"), q.int_arg("limit") or 200, q.int_arg("offset") or 0)), "admin"),
            # Настройки
            r("GET", r"/api/admin/settings", lambda q: (200, store.get_settings()), "operator"),
            r("PATCH", r"/api/admin/settings", lambda q: (200, store.set_settings(q.who, q.body)), "admin"),
        ]

    @staticmethod
    def _route(method, pattern, handler, role):
        return method, re.compile(pattern), handler, role

    # ---------- Состояние служб ----------

    @staticmethod
    def _fetch(url: str, timeout: float = 1.5, data: bytes | None = None):
        if not url:
            return None
        try:
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            return None

    def collect(self):
        ingest = self._fetch(f"{self.ingest_url}/state")
        caster = self._fetch(f"{self.caster_url}/state")
        services = {
            "ingest": {"up": True, "startedAt": ingest["startedAt"], "consumers": ingest["consumers"]} if ingest else {"up": False},
            "caster": {"up": True, **{k: caster.get(k) for k in ("startedAt", "ingestLink", "listening", "port", "sessions", "openAccess")}} if caster else {"up": False},
            "control": {"up": True, "startedAt": int(self.started * 1000)},
            "solver": self._fetch(f"{self.solver_url}/state") if self.solver_url else None,
        }
        return ingest, caster, services

    def state(self, q):
        ingest, caster, services = self.collect()
        feeds = {f["station"]: f for f in (caster or {}).get("feeds", [])}
        gates = {g["code"]: g for g in (ingest or {}).get("gates", [])}
        return 200, {
            "at": int(time.time() * 1000), "services": services,
            "stations": [{**s, "feed": feeds.get(s["id"]), "gate": gates.get(s["id"])} for s in (ingest or {}).get("stations", [])],
            "points": (caster or {}).get("points", []), "clients": (caster or {}).get("clients", []), "refusals": (caster or {}).get("refusals", []),
            "counts": self.store.counts(),
        }

    def public_state(self):
        ingest, caster, services = self.collect()
        feeds = {f["station"]: f for f in (caster or {}).get("feeds", [])}
        return {
            "at": int(time.time() * 1000), "services": services,
            "stations": [{"id": s["id"], "name": s["name"], "format": s["format"], "satTotal": s["satTotal"], "crcErrors": s["crcErrors"],
                          "link": {k: s["link"][k] for k in ("state", "bitsPerSec", "reconnects")},
                          "feed": {k: feeds[s["id"]][k] for k in ("bytes", "lastDataAgeMs")} if s["id"] in feeds else None}
                         for s in (ingest or {}).get("stations", [])],
        }

    def close_session(self, q):
        caster_id = str(q.need("id"))
        res = self._fetch(f"{self.caster_url}/kick", data=dumps({"id": caster_id, "reason": f"закрыт администратором {q.who['login']}"}))
        if res is None:
            raise Problem("Служба раздачи не отвечает: сеанс закрыть не удалось.", 503)
        if not res.get("closed"):
            raise Problem("Такого сеанса у службы раздачи уже нет.", 404)
        self.store.note(q.who, "закрыт сеанс", "sessions", caster_id, {"login": res.get("login", "")})
        return 200, {"closed": True}

    def subscriptions_csv(self, q):
        return 200, RawBody(self.store.export_subscriptions_csv().encode("utf-8"), "text/csv; charset=utf-8",
                            {"Content-Disposition": 'attachment; filename="subscriptions.csv"'})


class RawBody:
    def __init__(self, data: bytes, content_type: str, headers: dict | None = None):
        self.data, self.content_type, self.headers = data, content_type, headers or {}


class Query:
    """Запрос, разобранный для обработчика."""

    def __init__(self, who, match, params, body):
        self.who, self.params, self.body = who, params, body
        self.id = int(match.group(1)) if match.groups() else None

    def arg(self, name: str) -> str:
        return (self.params.get(name) or [""])[0]

    def int_arg(self, name: str):
        value = self.arg(name)
        if value == "":
            return None
        if not re.fullmatch(r"\d{1,9}", value):
            raise Problem(f"Параметр {name}: нужно число.")
        return int(value)

    def need(self, name: str):
        if not isinstance(self.body, dict) or self.body.get(name) in (None, ""):
            raise Problem(f"Не заполнено поле {name}.")
        return self.body[name]


def make_handler(app: App):
    store = app.store

    class Handler(BaseHTTPRequestHandler):
        server_version = "Uralsurvey"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # журнал запросов ведёт nginx
            pass

        # ----- Ответы -----

        def send_json(self, code: int, value, headers: dict | None = None):
            self.send_raw(code, dumps(value), "application/json; charset=utf-8", {"Cache-Control": "no-store", **(headers or {})})

        def send_raw(self, code: int, data: bytes, content_type: str, headers: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        # ----- Запрос -----

        def ip(self) -> str:
            # За nginx настоящий адрес приходит в заголовке; верим ему только от своей машины
            if self.client_address[0] in LOOPBACK and self.headers.get("X-Real-IP"):
                return self.headers["X-Real-IP"][:64]
            return self.client_address[0]

        def token(self) -> str | None:
            m = re.search(rf"(?:^|;\s*){COOKIE}=([0-9a-f]{{64}})", self.headers.get("Cookie", ""))
            return m.group(1) if m else None

        def body(self):
            length = int(self.headers.get("Content-Length") or 0)
            # Слой с контурами заметно больше обычного запроса; предел всё равно ниже, чем у nginx (1 МБ)
            if length > (LAYER_BODY if self.path.startswith("/api/admin/layers") else MAX_BODY):
                raise Problem("Слишком длинный запрос.", 413)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise Problem("Запрос не читается как JSON.") from None

        def handle_any(self):
            url = urllib.parse.urlsplit(self.path)
            path = url.path
            try:
                if path.startswith("/internal/"):
                    return self.internal(path)
                if path.startswith("/api/"):
                    return self.api(path, urllib.parse.parse_qs(url.query))
                return self.static(path)
            except Problem as exc:
                self.send_json(exc.status, {"error": str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:  # noqa: BLE001 — человеку нужен ответ, подробности идут в журнал службы
                print(f"управление: сбой на {self.command} {path}: {exc!r}", flush=True)
                self.send_json(500, {"error": "Внутренняя ошибка службы управления. Подробности — в журнале службы."})

        do_GET = do_POST = do_PATCH = do_DELETE = do_HEAD = handle_any

        # ----- Панель -----

        def api(self, path: str, params: dict):
            method = "GET" if self.command == "HEAD" else self.command
            if path == "/api/state" and method == "GET":
                return self.send_json(200, app.public_state())
            who = store.who(self.token())
            if path == "/api/me" and method == "GET":
                return self.send_json(200, {"signedIn": bool(who), "configured": store.has_admins(),
                                            "admin": {k: who[k] for k in ("login", "role", "full_name")} if who else None})
            if path == "/api/login" and method == "POST":
                ip = self.ip()
                if not store.has_admins():
                    raise Problem("Администратор ещё не заведён. Заведите его на сервере командой python -m uralsurvey_admin create-admin.", 409)
                if not app.attempts.allowed(ip):
                    raise Problem("Слишком много попыток входа. Подождите минуту.", 429)
                data = self.body()
                try:
                    token, admin = store.login(str(data.get("login", "")), str(data.get("password", "")), ip)
                except Problem:
                    app.attempts.failed(ip)
                    raise
                secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
                return self.send_json(200, {"signedIn": True, "admin": {k: admin[k] for k in ("login", "role", "full_name")}},
                                      {"Set-Cookie": f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={12 * 3600}{secure}"})
            if path == "/api/logout" and method == "POST":
                store.logout(self.token())
                return self.send_json(200, {"signedIn": False}, {"Set-Cookie": f"{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"})

            if not path.startswith("/api/admin/"):
                raise Problem("Нет такого адреса.", 404)
            if not who:
                raise Problem("Нужен вход администратора.", 401)
            who = {**who, "ip": self.ip()}
            known = False
            for route_method, pattern, handler, role in app.routes:
                match = pattern.fullmatch(path)
                if not match:
                    continue
                known = True
                if route_method != method:
                    continue
                if role == "admin" and who["role"] != "admin":
                    raise Problem("Это действие доступно только администратору.", 403)
                body = self.body() if method in ("POST", "PATCH") else {}
                code, value = handler(Query(who, match, params, body))
                if isinstance(value, RawBody):
                    return self.send_raw(code, value.data, value.content_type, value.headers)
                return self.send_json(code, value)
            raise Problem("Этот адрес не принимает такой запрос." if known else "Нет такого адреса.", 405 if known else 404)

        # ----- Службы приёма и раздачи -----

        def internal(self, path: str):
            key = self.headers.get("X-Ural-Key", "")
            if self.client_address[0] not in LOOPBACK or self.headers.get("X-Real-IP") or not app.internal_key \
                    or not hmac.compare_digest(key, app.internal_key):
                raise Problem("Нет такого адреса.", 404)
            if path == "/internal/directory" and self.command == "GET":
                return self.send_json(200, store.directory())
            if path == "/internal/events" and self.command == "POST":
                data = self.body()
                done = store.record_events(data.get("events", []))
                if isinstance(data.get("alive"), list):
                    store.close_stale_sessions(data["alive"])
                return self.send_json(200, {"recorded": done})
            if path == "/internal/outages" and self.command == "POST":
                return self.send_json(200, {"recorded": store.record_outages(self.body())})
            if path == "/internal/solver" and self.command == "GET":
                return self.send_json(200, {"subnets": store.solver_tasks(), "ppp": store.solver_ppp_tasks(), "pppDaily": store.solver_ppp_daily()})
            if path == "/internal/solver" and self.command == "POST":
                data = self.body()
                if data.get("kind") == "ppp-day":
                    return self.send_json(200, {"stored": store.solver_ppp_day(int(data.get("id", 0)), str(data.get("day", "")), data.get("results"))})
                if data.get("kind") == "ppp":
                    return self.send_json(200, {"stored": store.solver_ppp_results(int(data.get("id", 0)), str(data.get("startedAt", "")), data.get("results"), bool(data.get("final")))})
                return self.send_json(200, {"stored": store.solver_results(int(data.get("id", 0)), str(data.get("startedAt", "")), data.get("results"), bool(data.get("final")))})
            raise Problem("Нет такого адреса.", 404)

        # ----- Страницы -----

        def static(self, path: str):
            if self.command not in ("GET", "HEAD"):
                raise Problem("Этот адрес не принимает такой запрос.", 405)
            # Страница панели собирается на Python (page.py), файла для неё нет
            if path in ("/admin", "/admin/", "/admin.html"):
                return self.send_raw(200, admin_page(), "text/html; charset=utf-8", {"Cache-Control": "no-cache"})
            prefix, folder = next((p, d) for p, d in STATIC if path.startswith(p))
            rel = urllib.parse.unquote(path[len(prefix):]) or "index.html"
            if rel.endswith("/"):
                rel += "index.html"
            if "\x00" in rel:
                return self.send_raw(404, "Нет такой страницы".encode("utf-8"), "text/plain; charset=utf-8")
            target = (folder / rel).resolve()
            # Наружу отдаются только файлы из своих папок и только известных типов
            if folder.resolve() not in target.parents or target.suffix not in TYPES or not target.is_file():
                return self.send_raw(404, "Нет такой страницы".encode("utf-8"), "text/plain; charset=utf-8")
            self.send_raw(200, target.read_bytes(), TYPES.get(target.suffix) or mimetypes.guess_type(target.name)[0] or "application/octet-stream",
                          {"Cache-Control": "no-cache"})

    return Handler


def serve(store: Store, host: str = "127.0.0.1", port: int = 8110, ingest_url: str = "", caster_url: str = "", internal_key: str = ""):
    """Запускает службу. Возвращает сервер; работать он начинает после server.serve_forever()."""
    app = App(store, ingest_url, caster_url, internal_key or security.internal_key())
    server = ThreadingHTTPServer((host, port), make_handler(app))
    server.daemon_threads = True
    server.app = app
    return server
