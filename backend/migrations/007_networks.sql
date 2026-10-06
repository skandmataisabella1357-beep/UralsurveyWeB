-- Сети раздачи. Подсеть только считает; раздаёт отдельная сеть, выпущенная из подсети:
-- снимок согласованных координат на момент выпуска и свои точки подключения.
-- Пересчёт или удаление подсети выпущенную сеть не меняют.

-- Подсеть больше не раздаёт сама: её прежние точки убираются
DELETE FROM mountpoints WHERE subnet_id IS NOT NULL;
ALTER TABLE mountpoints DROP COLUMN subnet_kind;
ALTER TABLE mountpoints DROP COLUMN subnet_id;

CREATE TABLE networks (
    id         serial PRIMARY KEY,
    -- Короткое имя: с него начинаются имена точек подключения сети (N3 -> N3_EKB2)
    name       text NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9]{1,12}$'),
    title      text NOT NULL DEFAULT '',
    -- Из какой подсети выпускается; подсеть можно удалить, сеть останется
    subnet_id  integer REFERENCES subnets ON DELETE SET NULL,
    -- Что раздаёт: local — координаты подсети, пересчитанные привязкой в систему основной сети;
    -- itrf — координаты подсети как есть
    kind       text NOT NULL CHECK (kind IN ('local', 'itrf')),
    version    integer NOT NULL DEFAULT 0,
    -- Действующий выпуск: { stations: { КОД: {x, y, z, src} }, params, mode, subnet, at, by }
    release    jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- История выпусков: к любому можно вернуться
CREATE TABLE network_releases (
    network_id integer NOT NULL REFERENCES networks ON DELETE CASCADE,
    version    integer NOT NULL,
    release    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network_id, version)
);

ALTER TABLE mountpoints ADD COLUMN network_id integer REFERENCES networks ON DELETE CASCADE;

-- Тариф даёт сеть целиком: все её точки, в том числе добавленные позже
CREATE TABLE tariff_networks (
    tariff_id  integer NOT NULL REFERENCES tariffs ON DELETE CASCADE,
    network_id integer NOT NULL REFERENCES networks ON DELETE CASCADE,
    PRIMARY KEY (tariff_id, network_id)
);
