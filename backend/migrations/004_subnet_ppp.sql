-- Абсолютные координаты станций подсети методом PPP-AR: каждая станция считается сама по себе,
-- по точным продуктам спутников. Результат хранится рядом с результатом сетевого расчёта.
ALTER TABLE subnets ADD COLUMN ppp_state text NOT NULL DEFAULT 'idle' CHECK (ppp_state IN ('idle', 'running', 'stopped'));
ALTER TABLE subnets ADD COLUMN ppp_started_at timestamptz;
ALTER TABLE subnets ADD COLUMN ppp_results jsonb NOT NULL DEFAULT '{}';
ALTER TABLE subnets ADD COLUMN ppp_results_at timestamptz;
