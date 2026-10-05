-- Схема базы сервера Uralsurvey: всё, чем управляет администратор.
-- Путь потока (приём и раздача) от базы не зависит: службы берут из неё только
-- справочник станций, точек и логинов и складывают в неё журнал сеансов.

-- Администраторы и операторы панели
CREATE TABLE admins (
    id            serial PRIMARY KEY,
    login         text NOT NULL UNIQUE CHECK (login ~ '^[A-Za-z0-9_.-]{2,32}$'),
    password_hash text NOT NULL,
    salt          text NOT NULL,
    role          text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
    full_name     text NOT NULL DEFAULT '',
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

-- Сеансы панели: в базе лежит только хеш токена
CREATE TABLE admin_sessions (
    token_hash text PRIMARY KEY,
    admin_id   integer NOT NULL REFERENCES admins ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    ip         text NOT NULL DEFAULT ''
);

-- Базовые станции. Координаты — геоцентрические X, Y, Z в метрах до 0,1 мм.
CREATE TABLE stations (
    id                   serial PRIMARY KEY,
    code                 text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{1,32}$'),
    name                 text NOT NULL DEFAULT '',
    enabled              boolean NOT NULL DEFAULT true,
    -- Откуда берётся поток: listen — база сама шлёт на свой порт; ntrip — с кастера;
    -- tcp — сервер читает порт приёмника; sim — имитатор для проверки
    source_mode          text NOT NULL DEFAULT 'listen' CHECK (source_mode IN ('listen', 'ntrip', 'tcp', 'sim')),
    source_host          text NOT NULL DEFAULT '',
    source_port          integer CHECK (source_port BETWEEN 1 AND 65535),
    source_mountpoint    text NOT NULL DEFAULT '',
    source_username      text NOT NULL DEFAULT '',
    source_password_enc  text NOT NULL DEFAULT '',
    allow_addresses      text[] NOT NULL DEFAULT '{}',
    station_password_enc text NOT NULL DEFAULT '',
    x                    numeric(14, 4),
    y                    numeric(14, 4),
    z                    numeric(14, 4),
    antenna_height       numeric(8, 4),
    antenna_type         text NOT NULL DEFAULT '',
    receiver_type        text NOT NULL DEFAULT '',
    note                 text NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CHECK ((x IS NULL AND y IS NULL AND z IS NULL) OR (x IS NOT NULL AND y IS NOT NULL AND z IS NOT NULL))
);

-- История координат станции: прежние значения не теряются
CREATE TABLE station_coords (
    id             serial PRIMARY KEY,
    station_id     integer NOT NULL REFERENCES stations ON DELETE CASCADE,
    x              numeric(14, 4) NOT NULL,
    y              numeric(14, 4) NOT NULL,
    z              numeric(14, 4) NOT NULL,
    antenna_height numeric(8, 4),
    valid_from     timestamptz NOT NULL DEFAULT now(),
    author         text NOT NULL DEFAULT '',
    note           text NOT NULL DEFAULT ''
);
CREATE INDEX station_coords_station ON station_coords (station_id, valid_from DESC);

-- Точки подключения: какую администратор завёл, такая и есть
CREATE TABLE mountpoints (
    id              serial PRIMARY KEY,
    name            text NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9_-]{1,32}$'),
    station_id      integer NOT NULL REFERENCES stations ON DELETE CASCADE,
    rtcm_station_id integer CHECK (rtcm_station_id BETWEEN 0 AND 4095),
    listed          boolean NOT NULL DEFAULT true,
    enabled         boolean NOT NULL DEFAULT true,
    -- all — все логины с подпиской; tariff — только тарифы, где точка названа; staff — служебные логины
    access          text NOT NULL DEFAULT 'all' CHECK (access IN ('all', 'tariff', 'staff')),
    note            text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Клиенты: организации и частные лица
CREATE TABLE clients (
    id            serial PRIMARY KEY,
    name          text NOT NULL CHECK (length(btrim(name)) > 0),
    inn           text NOT NULL DEFAULT '',
    contact       text NOT NULL DEFAULT '',
    phone         text NOT NULL DEFAULT '',
    email         text NOT NULL DEFAULT '',
    contract_no   text NOT NULL DEFAULT '',
    contract_date date,
    note          text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Тарифы
CREATE TABLE tariffs (
    id              serial PRIMARY KEY,
    name            text NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
    period_days     integer NOT NULL CHECK (period_days > 0),
    all_mountpoints boolean NOT NULL DEFAULT true,
    max_sessions    integer NOT NULL DEFAULT 1 CHECK (max_sessions BETWEEN 1 AND 100),
    price           numeric(12, 2),
    note            text NOT NULL DEFAULT ''
);

CREATE TABLE tariff_mountpoints (
    tariff_id     integer NOT NULL REFERENCES tariffs ON DELETE CASCADE,
    mountpoint_id integer NOT NULL REFERENCES mountpoints ON DELETE CASCADE,
    PRIMARY KEY (tariff_id, mountpoint_id)
);

-- Подписки клиента. Состояние вычисляется по датам и отметкам, отдельно не хранится.
CREATE TABLE subscriptions (
    id             serial PRIMARY KEY,
    client_id      integer NOT NULL REFERENCES clients ON DELETE CASCADE,
    tariff_id      integer NOT NULL REFERENCES tariffs ON DELETE RESTRICT,
    starts_on      date NOT NULL,
    ends_on        date NOT NULL,
    logins_limit   integer NOT NULL DEFAULT 1 CHECK (logins_limit BETWEEN 1 AND 1000),
    paid           boolean NOT NULL DEFAULT false,
    trial          boolean NOT NULL DEFAULT false,
    suspended      boolean NOT NULL DEFAULT false,
    suspend_reason text NOT NULL DEFAULT '',
    note           text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_on >= starts_on)
);
CREATE INDEX subscriptions_client ON subscriptions (client_id, ends_on DESC);

-- Логины NTRIP: по одному на ровер. Пароль хранится зашифрованным ключом сервера,
-- потому что клиент должен видеть его в кабинете, а протокол передаёт его открыто.
CREATE TABLE ntrip_logins (
    id           serial PRIMARY KEY,
    client_id    integer REFERENCES clients ON DELETE CASCADE,
    login        text NOT NULL UNIQUE CHECK (login ~ '^[A-Za-z0-9_.@-]{2,32}$'),
    password_enc text NOT NULL,
    device       text NOT NULL DEFAULT '',
    max_sessions integer NOT NULL DEFAULT 1 CHECK (max_sessions BETWEEN 1 AND 100),
    on_limit     text NOT NULL DEFAULT 'evict' CHECK (on_limit IN ('evict', 'refuse')),
    staff        boolean NOT NULL DEFAULT false,
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    last_refusal text NOT NULL DEFAULT '',
    -- Обычный логин принадлежит клиенту, служебный — оператору сети
    CHECK (staff OR client_id IS NOT NULL)
);
CREATE INDEX ntrip_logins_client ON ntrip_logins (client_id);

-- Журнал сеансов роверов
CREATE TABLE sessions (
    id            bigserial PRIMARY KEY,
    caster_id     text NOT NULL DEFAULT '',
    login         text NOT NULL DEFAULT '',
    mountpoint    text NOT NULL DEFAULT '',
    station       text NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL,
    ended_at      timestamptz,
    end_reason    text NOT NULL DEFAULT '',
    bytes         bigint NOT NULL DEFAULT 0,
    address       text NOT NULL DEFAULT '',
    agent         text NOT NULL DEFAULT '',
    ntrip_version integer,
    first_lat     double precision,
    first_lon     double precision,
    last_lat      double precision,
    last_lon      double precision,
    last_kind     text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX sessions_caster ON sessions (caster_id) WHERE caster_id <> '';
CREATE INDEX sessions_started ON sessions (started_at DESC);
CREATE INDEX sessions_login ON sessions (login, started_at DESC);
CREATE INDEX sessions_open ON sessions (started_at) WHERE ended_at IS NULL;

-- Отказы в подключении
CREATE TABLE refusals (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    login      text NOT NULL DEFAULT '',
    mountpoint text NOT NULL DEFAULT '',
    code       integer,
    reason     text NOT NULL DEFAULT '',
    address    text NOT NULL DEFAULT ''
);
CREATE INDEX refusals_at ON refusals (at DESC);
CREATE INDEX refusals_login ON refusals (login, at DESC);

-- Журнал действий администраторов: только дополняется
CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    admin_login text NOT NULL DEFAULT '',
    action      text NOT NULL,
    entity      text NOT NULL DEFAULT '',
    entity_id   text NOT NULL DEFAULT '',
    details     jsonb NOT NULL DEFAULT '{}',
    ip          text NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

CREATE FUNCTION audit_log_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'журнал действий нельзя править или удалять';
END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();

-- Настройки сервера, которые меняются из панели
CREATE TABLE settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
    ('trial_days', '3'),
    ('expiring_days', '7'),
    ('max_sessions_default', '1'),
    ('station_lost_seconds', '30'),
    ('nearest_max_km', '100'),
    ('session_keep_days', '365'),
    ('refusal_keep_days', '90');
