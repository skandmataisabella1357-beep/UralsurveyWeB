-- Слои: контуры и линии, загруженные администратором из файлов KML и DXF.
-- Слой можно показать на карте и назначить логину областью работы: вне контуров слоя
-- ровер с этим логином поправки не получает.

CREATE TABLE layers (
    id         serial PRIMARY KEY,
    name       text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
    -- Из какого файла и в какой системе координат он был: wgs84, msk66-1, msk66-2 …
    format     text NOT NULL DEFAULT 'kml' CHECK (format IN ('kml', 'dxf')),
    crs        text NOT NULL DEFAULT 'wgs84',
    -- Объекты уже в широте и долготе: [{ "kind": "polygon" | "line", "name": "...", "points": [[широта, долгота], ...] }]
    features   jsonb NOT NULL DEFAULT '[]',
    note       text NOT NULL DEFAULT '',
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Область работы логина: пусто — без ограничения
ALTER TABLE ntrip_logins ADD COLUMN area_layer_id integer REFERENCES layers ON DELETE SET NULL;
