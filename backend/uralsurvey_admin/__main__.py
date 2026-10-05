"""Запуск службы управления и служебные команды.

    python -m uralsurvey_admin serve          — служба управления (панель и база)
    python -m uralsurvey_admin migrate        — применить схему базы
    python -m uralsurvey_admin create-admin ЛОГИН [--operator]
                                              — завести администратора; пароль вводится с клавиатуры
    python -m uralsurvey_admin cleanup        — удалить записи журналов старше сроков из настроек

Настройки — в переменных окружения: URAL_DSN (база, по умолчанию dbname=uralsurvey),
URAL_HOST и URAL_PORT (адрес страницы), URAL_INGEST и URAL_CASTER (адреса состояния служб),
URAL_DATA (папка с ключами).
"""

from __future__ import annotations

import getpass
import os
import sys
import threading
import time

from . import security
from .api import serve
from .db import Database
from .store import Problem, Store


def make_store() -> Store:
    return Store(Database(), security.Vault())


def cmd_serve() -> int:
    store = make_store()
    applied = store.db.migrate()
    if applied:
        print(f"управление: применена схема базы — {', '.join(applied)}", flush=True)
    host = os.environ.get("URAL_HOST", "127.0.0.1")
    port = int(os.environ.get("URAL_PORT", "8110"))
    server = serve(store, host, port, os.environ.get("URAL_INGEST", "http://127.0.0.1:7102"), os.environ.get("URAL_CASTER", "http://127.0.0.1:7103"))

    def housekeeping():
        # Раз в час убираем из журналов записи старше сроков хранения
        while True:
            time.sleep(3600)
            try:
                store.cleanup()
            except Exception as exc:  # noqa: BLE001
                print(f"управление: уборка журналов не удалась: {exc!r}", flush=True)

    threading.Thread(target=housekeeping, daemon=True).start()
    print(f"управление: панель на http://{host}:{port}/admin.html, база {store.db.dsn}", flush=True)
    if not store.has_admins():
        print("управление: администратор ещё не заведён — python -m uralsurvey_admin create-admin ЛОГИН", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def cmd_create_admin(args: list[str]) -> int:
    names = [a for a in args if not a.startswith("--")]
    if len(names) != 1:
        print("Укажите логин: python -m uralsurvey_admin create-admin ЛОГИН [--operator]")
        return 2
    if not sys.stdin.isatty():
        print("Пароль вводится с клавиатуры: запустите команду в терминале (по ssh — с ключом -t).")
        return 2
    store = make_store()
    store.db.migrate()
    first = getpass.getpass(f"Пароль для {names[0]} (не короче {security.MIN_ADMIN_PASSWORD} знаков): ")
    if first != getpass.getpass("Ещё раз: "):
        print("Пароли не совпали. Ничего не изменено.")
        return 1
    try:
        admin = store.create_admin({"login": "консоль сервера"}, {"login": names[0], "password": first, "role": "operator" if "--operator" in args else "admin"})
    except Problem as exc:
        print(f"Не получилось: {exc}")
        return 1
    print(f"Заведён {'оператор' if admin['role'] == 'operator' else 'администратор'} {admin['login']}.")
    return 0


def main(argv: list[str]) -> int:
    command = argv[0] if argv else "serve"
    if command == "serve":
        return cmd_serve()
    if command == "migrate":
        applied = make_store().db.migrate()
        print("Схема базы уже на месте." if not applied else f"Применено: {', '.join(applied)}")
        return 0
    if command == "create-admin":
        return cmd_create_admin(argv[1:])
    if command == "import-stations":
        # Завести станции списком из файла JSON; существующие не трогаются
        if len(argv) != 2:
            print("Укажите файл: python -m uralsurvey_admin import-stations ФАЙЛ.json")
            return 2
        import json

        store = make_store()
        store.db.migrate()
        with open(argv[1], encoding="utf-8") as f:
            items = json.load(f)
        try:
            print(store.import_stations({"login": "консоль сервера"}, items))
        except Problem as exc:
            print(f"Не получилось: {exc}")
            return 1
        return 0
    if command == "remove-testnet":
        print(f"Убрано станций тестовой сети: {make_store().remove_testnet({'login': 'консоль сервера'})}")
        return 0
    if command == "import-casters":
        # Станции с действующих кастеров по списку: строка «адрес:порт логин пароль [отбор]»
        if len(argv) != 2:
            print("Укажите файл: python -m uralsurvey_admin import-casters casters.txt")
            return 2
        from .casters import fetch_mounts, parse_casters

        store = make_store()
        store.db.migrate()
        with open(argv[1], encoding="utf-8-sig") as f:
            casters, problems = parse_casters(f.read())
        for text in problems:
            print(f"Пропущено: {text}")
        for c in casters:
            try:
                mounts = fetch_mounts(c["host"], c["port"], c["filter"])
                res = store.import_caster({"login": "консоль сервера"}, c["host"], c["port"], c["username"], c["password"], mounts)
            except (OSError, Problem) as exc:
                print(f"{c['host']}:{c['port']} — не получилось: {exc}")
                continue
            print(f"{c['host']}:{c['port']} — добавлено {len(res['added'])}: {', '.join(res['added']) or '—'}; "
                  f"уже были {len(res['skipped'])}: {', '.join(res['skipped']) or '—'}")
        return 0
    if command == "cleanup":
        print(make_store().cleanup())
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
