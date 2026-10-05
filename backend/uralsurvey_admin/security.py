"""Пароли, токены и шифрование.

- Пароли администраторов хранятся хешем (scrypt), восстановить их нельзя.
- Пароли NTRIP и пароли источников хранятся зашифрованными ключом сервера: раздача
  обязана сравнивать их с тем, что ровер прислал открыто, а клиент — видеть свой пароль.
  Ключ лежит в файле рядом с настройками, отдельно от базы и её копий.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import pathlib
import secrets

from cryptography.fernet import Fernet, InvalidToken

MIN_ADMIN_PASSWORD = 10
# Знаки пароля NTRIP: без похожих (0 и O, 1 и l, I), чтобы его было легко набрать на контроллере
NTRIP_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def data_dir() -> pathlib.Path:
    if os.environ.get("URAL_DATA"):
        return pathlib.Path(os.environ["URAL_DATA"])
    if os.environ.get("URAL_CONFIG"):
        return pathlib.Path(os.environ["URAL_CONFIG"]).parent
    return pathlib.Path(__file__).resolve().parent.parent / "data"


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    """Возвращает (хеш, соль) в шестнадцатеричном виде."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return digest.hex(), salt.hex()


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    try:
        digest, _ = hash_password(password, bytes.fromhex(salt))
    except ValueError:
        return False
    return hmac.compare_digest(digest, password_hash)


def new_token() -> tuple[str, str]:
    """Токен сеанса панели и его хеш: в базу попадает только хеш."""
    token = secrets.token_hex(32)
    return token, token_hash(token)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii", "ignore")).hexdigest()


def generate_ntrip_password(length: int = 10) -> str:
    return "".join(secrets.choice(NTRIP_ALPHABET) for _ in range(length))


class Vault:
    """Шифрование значений ключом сервера. Ключ создаётся при первом запуске."""

    def __init__(self, key_file: pathlib.Path | None = None):
        self.key_file = key_file or data_dir() / "secret.key"
        if self.key_file.exists():
            key = self.key_file.read_bytes().strip()
        else:
            key = Fernet.generate_key()
            self.key_file.parent.mkdir(parents=True, exist_ok=True)
            # Файл сразу создаётся закрытым для остальных пользователей
            fd = os.open(self.key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(key)
        self._fernet = Fernet(key)

    def encrypt(self, text: str) -> str:
        return self._fernet.encrypt(text.encode("utf-8")).decode("ascii") if text else ""

    def decrypt(self, value: str) -> str:
        if not value:
            return ""
        try:
            return self._fernet.decrypt(value.encode("ascii")).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("значение зашифровано другим ключом сервера") from exc


def internal_key(path: pathlib.Path | None = None) -> str:
    """Общий ключ для обращений служб приёма и раздачи к справочнику. Создаётся при первом запуске."""
    path = path or data_dir() / "internal.key"
    if path.exists():
        return path.read_text(encoding="ascii").strip()
    key = secrets.token_hex(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as f:
        f.write(key)
    return key
