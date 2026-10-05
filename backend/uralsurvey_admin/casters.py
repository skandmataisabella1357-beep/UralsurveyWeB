"""Список действующих кастеров и их таблицы источников.

Файл со списком: одна строка — один кастер, «адрес:порт логин пароль [отбор]».
Отбор — часть имени точки подключения (по умолчанию MSM4), звёздочка — все точки.
Пустые строки и строки с решёткой пропускаются.
"""

from __future__ import annotations

import re
import socket


def parse_casters(text: str, default_filter: str = "MSM4") -> tuple[list[dict], list[str]]:
    casters, problems = [], []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = [p for p in re.split(r"[\s;]+", line) if p]
        m = re.fullmatch(r"(?:ntrip://|http://)?(.+):(\d+)/?", parts[0])
        if not m or not 1 <= int(m.group(2)) <= 65535 or len(parts) > 4:
            problems.append(f"строка {n}: ждём «адрес:порт логин пароль отбор»")
            continue
        flt = parts[3] if len(parts) > 3 else default_filter
        casters.append({"host": m.group(1), "port": int(m.group(2)), "username": parts[1] if len(parts) > 1 else "",
                        "password": parts[2] if len(parts) > 2 else "", "filter": "" if flt == "*" else flt})
    return casters, problems


def fetch_mounts(host: str, port: int, flt: str = "", timeout: float = 10.0) -> list[dict]:
    """Точки подключения кастера по его таблице источников. Логин для таблицы не нужен."""
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(f"GET / HTTP/1.0\r\nHost: {host}:{port}\r\nUser-Agent: NTRIP Uralsurvey/0.1\r\nAccept: */*\r\n\r\n".encode("ascii"))
        data = b""
        while b"ENDSOURCETABLE" not in data and len(data) < 1_000_000:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    mounts = []
    for line in data.decode("latin-1").splitlines():
        if not line.startswith("STR;"):
            continue
        f = line.split(";")
        name = f[1].strip()
        # Имя точки должно годиться и нам: сетевые точки вида [RTCM30] пропускаются
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name) or (flt and flt.lower() not in name.lower()):
            continue
        mounts.append({"name": name, "title": (f[2].strip() if len(f) > 2 else "") or name})
    if not mounts:
        raise OSError("кастер не прислал подходящих точек подключения")
    return mounts
