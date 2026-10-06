"""Страница панели администратора. Собирается здесь, на Python: файла admin.html нет.

Браузеру уходит готовая страница; оживляет её сценарий server/web/admin.js (карта, окна,
обновление таблиц без перезагрузки) — эта часть работает в браузере и на Python быть не может.
К адресам стилей и сценариев дописывается отметка времени файла: после обновления сервера
браузер сам берёт новые версии, обновлять страницу с очисткой памяти не нужно.
"""

from __future__ import annotations

import pathlib
from html import escape

ROOT = pathlib.Path(__file__).resolve().parents[2]
FILES = {"/ui/": ROOT / "app" / "renderer", "/modules/coordsys/": ROOT / "modules" / "coordsys", "/modules/layers/": ROOT / "modules" / "layers",
         "/modules/transform/": ROOT / "modules" / "transform", "/modules/geoid/": ROOT / "modules" / "geoid", "/": ROOT / "server" / "web"}
POLICY = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'"


def el(tag: str, *children: str, **attrs) -> str:
    """Элемент страницы. cls — класс; подчёркивание в имени атрибута становится дефисом;
    True — атрибут без значения, False и None — атрибута нет."""
    parts = [tag]
    for name, value in attrs.items():
        if value is None or value is False:
            continue
        name = "class" if name == "cls" else name.replace("_", "-")
        parts.append(name if value is True else f'{name}="{escape(str(value), quote=True)}"')
    if tag in ("img", "input", "meta", "link"):
        return f"<{' '.join(parts)}>"
    return f"<{' '.join(parts)}>{''.join(children)}</{tag}>"


def asset(url: str) -> str:
    """Адрес файла с отметкой времени его изменения."""
    for prefix, folder in FILES.items():
        if url.startswith(prefix):
            try:
                return f"{url}?v={int((folder / url[len(prefix):]).stat().st_mtime)}"
            except OSError:
                return url
    return url


def button(text: str, kind: str = "quiet", small: bool = False, **attrs) -> str:
    attrs.setdefault("type", "button")
    return el("button", escape(text), cls=f"btn btn-{kind}{' btn-small' if small else ''}{' ' + attrs.pop('extra') if 'extra' in attrs else ''}", **attrs)


def field(label: str, **attrs) -> str:
    label_id = attrs.pop("label_id", None)
    return el("label", el("span", escape(label), id=label_id), el("input", **attrs), cls="field")


def error(element_id: str) -> str:
    return el("p", cls="form-error", id=element_id, role="alert", hidden=True)


def login() -> str:
    return el("section", el(
        "form",
        el("img", cls="empty-emblem", src="/ui/assets/uci-emblem.svg", alt=""),
        el("h2", "Панель администратора"),
        el("p", "Вход для администратора сети Uralsurvey.", cls="hint", id="login-hint"),
        el("div", field("Логин", name="login", type="text", autocomplete="username", autofocus=True),
           field("Пароль", name="password", type="password", autocomplete="current-password"), id="login-fields"),
        error("login-error"),
        el("div", el("a", "Страница состояния", cls="btn btn-quiet", href="/"), button("Войти", "primary", type="submit", id="login-submit"), cls="dialog-actions"),
        cls="dialog adm-login-card", id="login-form", novalidate=True), cls="adm-login", id="login", hidden=True)


def workspace() -> str:
    """Экран панели — как окно приложения: карта на весь экран, слева каталог сети,
    справа свойства выбранной станции, сверху полоса с разделами."""
    # Общий переливчатый градиент для контуров знаков станций
    stops = [("0", "#a890ff"), ("0.3", "#f09ccc"), ("0.55", "#ffc48e"), ("0.78", "#86e2c0"), ("1", "#84c8ff")]
    gradient = el("svg", el("defs", el("linearGradient", *(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops), id="holo-stroke", x1="0", y1="0", x2="1", y2="1")),
                  width="0", height="0", style="position:absolute", aria_hidden="true")
    # Полоска обводки контура расчётного модуля и шкала цвета векторов — единственное, что лежит поверх карты
    draw = el("div", el("span", id="draw-count"), button("Убрать последнюю", small=True, data_draw="undo"), button("Готово", "primary", small=True, data_draw="done"),
              cls="adm-draw glass", id="draw-bar", hidden=True)
    legend = el("div", el("span", id="map-legend-name"), el("span", "1 м"), el("i"), el("span", "5 мм"), cls="adm-legend", id="map-legend", hidden=True)
    map_wrap = el("section", el("div", id="map"), el("div", cls="map-tint"), el("canvas", id="graticule", aria_hidden="true"), draw, legend, cls="map-wrap", aria_label="Карта станций")
    topbar = el(
        "header",
        el("div", el("img", cls="brand-mark", src="/ui/assets/uci-mark.svg", alt=""), el("span", "Uralsurvey", cls="brand-name"), cls="brand"),
        el("p", cls="summary", id="summary"), el("span", cls="adm-who", id="who"),
        button("", small=True, id="theme-btn"), button("Выйти", small=True, id="logout-btn"), cls="topbar glass")
    rail = el("nav", el("div", el("span", "Сеть", cls="rail-title"), el("span", cls="rail-count fig", id="rail-count"), cls="rail-head"),
              el("div", cls="scroll", id="rail"),
              el("div", el("img", src="/ui/assets/uci-mark.svg", alt=""), el("p", el("b", "УЦИ"), "Уральский центр изысканий"), cls="rail-foot"),
              cls="rail glass", aria_label="Каталог сети")
    inspector = el("aside", el("div", cls="scroll", id="detail"), cls="inspector glass", id="detail-box", aria_label="Выбранная станция", hidden=True)
    # Разделы без карты (клиенты, логины, журналы, настройки) открываются панелью поверх неё
    overview = el("div", el("div", el("div", cls="srv-services", id="services"), el("div", cls="adm-figures", id="figures"), cls="adm-view"), id="overview", hidden=True)
    tools = el("span", el("input", cls="adm-search", id="list-search", type="search", placeholder="Поиск", hidden=True), el("span", cls="fig", id="list-count"),
               el("a", "Выгрузить CSV", cls="btn btn-quiet btn-small", id="list-export", hidden=True), button("Добавить", "primary", small=True, id="list-add", hidden=True),
               cls="adm-list-tools")
    table = el("div", el("table", el("thead", id="list-head"), el("tbody", id="list-body"), cls="messages srv-table adm-rows"), cls="adm-scroll")
    listing = el("section", el("h2", el("span", id="list-title"), tools, cls="ins-title adm-list-head"), el("p", cls="hint", id="list-hint", hidden=True), el("div", id="list-summary", hidden=True), table,
                 cls="srv-panel glass", id="list-box", hidden=True)
    # Журнал обрывов связи: полосы времени по станциям и список
    outages = el("section", cls="srv-panel glass", id="out-box", hidden=True)
    main = el("main", overview, el("section", id="sub-box", hidden=True), listing, outages, cls="adm-float", id="main", hidden=True)
    # Разделы — одной вертикальной лентой значков у левого края
    ribbon = el("nav", cls="adm-ribbon glass", id="nav", aria_label="Разделы")
    # Всплывающая подсказка у значков ленты: что это и что сейчас показано
    tip = el("div", cls="adm-tip glass", id="tip", hidden=True)
    return el("div", gradient, map_wrap, topbar, ribbon, rail, inspector, main, tip, id="app", hidden=True)


def dialogs() -> str:
    """Все окна панели: форма записи, расчётного модуля, настройка."""
    form = el("dialog", el(
        "form", el("h2", id="form-title"), el("div", id="form-fields"), el("p", cls="hint", id="form-note", hidden=True), error("form-error"),
        el("div", button("Удалить", extra="btn-danger", id="form-delete", hidden=True), el("span", cls="adm-grow"), button("Отмена", id="form-cancel"),
           button("Сохранить", "primary", type="submit", id="form-save"), cls="dialog-actions"),
        id="form", method="dialog", novalidate=True), cls="dialog adm-dialog", id="form-dialog")
    subnet = el("dialog", el("button", "×", cls="icon-btn adm-close", type="button", data_do="close", title="Закрыть"),
                el("h2", el("span", id="sub-head"), el("span", cls="adm-chips", id="sub-jumps")), el("div", id="sub-body"),
                cls="dialog adm-dialog adm-panel", id="sub-dialog")
    setting = el("dialog", el(
        "form", el("h2", id="set-title"), field("", label_id="set-hint", id="set-value", type="number"), error("set-error"),
        el("div", button("Отмена", id="set-cancel"), button("Сохранить", "primary", type="submit"), cls="dialog-actions"),
        id="set-form", novalidate=True), cls="dialog adm-dialog", id="set-dialog")
    # Ход расчёта расчётного модуля: этап, полоса готовности, строки по векторам
    run = el("dialog", el("button", "×", cls="icon-btn adm-close", type="button", data_run="close", title="Закрыть"), el("h2", id="run-head"),
             el("p", cls="hint", id="run-stage"), el("div", el("i", id="run-bar"), cls="adm-progress"), el("ol", cls="log adm-run-log", id="run-log"),
             el("div", button("Закрыть", "primary", data_run="close"), cls="dialog-actions"), cls="dialog adm-dialog", id="run-dialog")
    # Загрузка слоя из файла KML или DXF и область работы логинов по слою
    layer = el("dialog", el(
        "form", el("h2", "Новый слой"), el("input", type="file", id="layer-file", accept=".kml,.dxf", hidden=True),
        field("Имя слоя", id="layer-name", type="text", maxlength="80", autocomplete="off"),
        el("label", el("span", "Система координат чертежа"), el("select", id="layer-crs"), cls="field", id="layer-crs-box"),
        el("label", el("span", "Оси чертежа"), el("select", el("option", "X — восток, Y — север (как в AutoCAD)", value="en"), el("option", "X — север, Y — восток (как в каталоге)", value="ne"), id="layer-axes"), cls="field", id="layer-axes-box"),
        el("p", cls="hint", id="layer-summary"), error("layer-error"),
        el("div", button("Отмена", id="layer-cancel"), button("Загрузить", "primary", type="submit"), cls="dialog-actions"),
        id="layer-form", novalidate=True), cls="dialog adm-dialog", id="layer-dialog")
    area = el("dialog", el(
        "form", el("h2", id="area-title"), el("p", "Отмеченные логины получают поправки только внутри контуров этого слоя. Ровер должен сообщать своё положение: без него сеанс закрывается через полминуты.", cls="hint"),
        el("div", cls="adm-sub-stations", id="area-list"), error("area-error"),
        el("div", button("Отмена", id="area-cancel"), button("Сохранить", "primary", type="submit"), cls="dialog-actions"),
        id="area-form", novalidate=True), cls="dialog adm-dialog", id="area-dialog")
    return "".join([form, subnet, setting, run, layer, area])


def admin_page() -> bytes:
    styles = ["/ui/vendor/leaflet/leaflet.css", "/ui/styles.css", "/server.css", "/admin.css"]
    scripts = ["/ui/vendor/leaflet/leaflet.js", "/ui/format.js", "/modules/coordsys/coordsys.js", "/modules/transform/transform.js", "/modules/geoid/geoid.js", "/modules/layers/parse.js", "/ui/map.js", "/admin.js"]
    head = el(
        "head", el("meta", charset="utf-8"), el("meta", name="viewport", content="width=device-width, initial-scale=1"),
        el("meta", http_equiv="Content-Security-Policy", content=POLICY), el("title", "Uralsurvey — панель администратора"),
        *(el("link", rel="stylesheet", href=asset(url)) for url in styles), el("script", src=asset("/ui/theme.js")))
    body = el("body", login(), workspace(), dialogs(), el("div", cls="toast", id="toast", role="status", hidden=True),
              *(el("script", src=asset(url)) for url in scripts), cls="adm")
    return ("<!doctype html>\n" + el("html", head, body, lang="ru")).encode("utf-8")
