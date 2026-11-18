-- A single room. All timestamps are UTC; no credentials belong in this file.
CREATE TABLE IF NOT EXISTS sensor_readings (
  measured_at timestamptz PRIMARY KEY,
  temperature double precision,
  humidity double precision CHECK (humidity BETWEEN 0 AND 100),
  co2 double precision CHECK (co2 >= 0),
  pm25 double precision CHECK (pm25 >= 0),
  pm10 double precision CHECK (pm10 >= 0)
);
-- Upgrade existing installations as well as new ones.
ALTER TABLE sensor_readings
  ALTER COLUMN temperature DROP NOT NULL,
  ALTER COLUMN humidity DROP NOT NULL,
  ALTER COLUMN co2 DROP NOT NULL,
  ALTER COLUMN pm25 DROP NOT NULL,
  ALTER COLUMN pm10 DROP NOT NULL;
-- Small room state is saved atomically. JSON includes devices, commands,
-- decisions, notifications, settings, recovery deduplication and edge status.
CREATE TABLE IF NOT EXISTS room_state (
  id text PRIMARY KEY CHECK (id = 'room-1'),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
