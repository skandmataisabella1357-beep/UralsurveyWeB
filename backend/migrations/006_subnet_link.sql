-- Сеть 2: координаты подсети из суточных расчётов PPP-AR и её привязка к основной сети.

-- Суточный PPP-AR: каждые сутки считаются заново, ответы копятся и усредняются
ALTER TABLE subnets ADD COLUMN ppp_daily boolean NOT NULL DEFAULT false;
CREATE TABLE subnet_ppp_days (
    subnet_id  integer NOT NULL REFERENCES subnets ON DELETE CASCADE,
    day        date NOT NULL,
    code       text NOT NULL,
    -- ITRF2020 на эпоху суток и то же в ITRF2014
    x          numeric(13, 4) NOT NULL,
    y          numeric(13, 4) NOT NULL,
    z          numeric(13, 4) NOT NULL,
    x14        numeric(13, 4) NOT NULL,
    y14        numeric(13, 4) NOT NULL,
    z14        numeric(13, 4) NOT NULL,
    sd         real,
    fixed      boolean NOT NULL DEFAULT false,
    hours      real NOT NULL DEFAULT 0,
    products   text NOT NULL DEFAULT '',
    epoch      numeric(8, 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subnet_id, day, code)
);

-- Привязка к основной сети: семь параметров перехода от принятых координат подсети
-- к координатам станций из каталога и невязки по станциям
ALTER TABLE subnets ADD COLUMN link jsonb NOT NULL DEFAULT '{}';

-- Что раздаёт точка подсети: координаты подсети как есть (itrf) или пересчитанные
-- семью параметрами в систему основной сети (local)
ALTER TABLE mountpoints ADD COLUMN subnet_kind text NOT NULL DEFAULT 'itrf' CHECK (subnet_kind IN ('itrf', 'local'));
