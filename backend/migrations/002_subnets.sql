-- Подсети: часть станций со своими координатами, согласованными между собой.
-- Координаты подсети считаются от опорной станции по живым потокам (RTK, статика)
-- и раздаются роверам через свои точки подключения.

CREATE TABLE subnets (
    id                   serial PRIMARY KEY,
    -- Короткое имя: с него начинаются имена точек подключения подсети (EKB -> EKB_REFT)
    name                 text NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9]{1,12}$'),
    title                text NOT NULL DEFAULT '',
    -- Контур на карте: [[широта, долгота], ...]; пустой — станции выбраны вручную
    contour              jsonb NOT NULL DEFAULT '[]',
    station_ids          integer[] NOT NULL DEFAULT '{}',
    -- Опорная станция и её координаты: система и эпоха подсети — как у этих координат
    reference_station_id integer REFERENCES stations ON DELETE SET NULL,
    ref_x                numeric(13, 4),
    ref_y                numeric(13, 4),
    ref_z                numeric(13, 4),
    frame                text NOT NULL DEFAULT 'ITRF2014',
    calc_state           text NOT NULL DEFAULT 'idle' CHECK (calc_state IN ('idle', 'running', 'stopped')),
    calc_started_at      timestamptz,
    -- Последний ответ службы расчёта: { stations: { КОД: {...} }, note, ... }
    results              jsonb NOT NULL DEFAULT '{}',
    results_at           timestamptz,
    -- Принятые администратором координаты: { КОД: { x, y, z, ... } }
    accepted             jsonb NOT NULL DEFAULT '{}',
    accepted_at          timestamptz,
    accepted_by          text NOT NULL DEFAULT '',
    note                 text NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Точка подключения подсети: поток станции с координатами базы из подсети
ALTER TABLE mountpoints ADD COLUMN subnet_id integer REFERENCES subnets ON DELETE CASCADE;
