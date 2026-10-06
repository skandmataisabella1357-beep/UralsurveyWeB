-- Третий вид сети раздачи: координаты базы в ITRF2014 и сообщения пересчёта в потоке
-- (RTCM 1021 и 1025) — ровер сам получает местную систему координат.
ALTER TABLE networks DROP CONSTRAINT networks_kind_check;
ALTER TABLE networks ADD CONSTRAINT networks_kind_check CHECK (kind IN ('local', 'itrf', 'itrf_msk'));
