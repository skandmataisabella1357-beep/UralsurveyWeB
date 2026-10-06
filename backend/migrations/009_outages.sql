-- Журнал обрывов связи со станциями. Пишет служба приёма; журнал переживает перезапуск сервера.
CREATE TABLE station_outages (
    id         bigserial PRIMARY KEY,
    station    text NOT NULL,
    started_at timestamptz NOT NULL,
    -- Пусто — связи нет до сих пор
    ended_at   timestamptz,
    -- link — пропала связь со станцией; service — не работал сам сервер приёма
    kind       text NOT NULL DEFAULT 'link' CHECK (kind IN ('link', 'service')),
    reason     text NOT NULL DEFAULT '',
    -- Откуда шёл поток в момент обрыва: кастер-источник или база напрямую
    source     text NOT NULL DEFAULT ''
);
CREATE INDEX station_outages_station ON station_outages (station, started_at DESC);
CREATE INDEX station_outages_open ON station_outages (station) WHERE ended_at IS NULL;

-- Отметки служб: когда приём последний раз подавал признаки жизни и с какого времени ведётся журнал
CREATE TABLE service_marks (
    name text PRIMARY KEY,
    at   timestamptz NOT NULL
);
