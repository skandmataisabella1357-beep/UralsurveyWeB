-- Конструктор точек доступа: своё имя и видимость у точек, которые сервер заводит сам —
-- «ближайшая база» (near) и «виртуальная база» (vrs). Ключ: near:main — у основной сети,
-- near:<номер сети> и vrs:<номер сети> — у сети раздачи. Пустое имя — имя по умолчанию
-- (NEAR, ИМЯСЕТИ_NEAR, ИМЯСЕТИ_VRS). listed — показывать ли точку в таблице источников:
-- скрытая точка работает, но ровер не видит её в списке.
CREATE TABLE point_overrides (
    key        text PRIMARY KEY CHECK (key ~ '^(near:main|(near|vrs):[0-9]+)$'),
    name       text CHECK (name IS NULL OR name ~ '^[A-Za-z0-9_-]{1,32}$'),
    listed     boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);
