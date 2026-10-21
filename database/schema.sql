-- A single room. All timestamps are UTC; no credentials belong in this file.
CREATE TABLE IF NOT EXISTS sensor_readings (
  measured_at timestamptz PRIMARY KEY,
  temperature double precision NOT NULL,
  humidity double precision NOT NULL CHECK (humidity BETWEEN 0 AND 100),
  co2 double precision NOT NULL CHECK (co2 >= 0),
  pm25 double precision NOT NULL CHECK (pm25 >= 0),
  pm10 double precision NOT NULL CHECK (pm10 >= 0)
);
-- Small room state is saved atomically. JSON includes devices, commands,
-- decisions, notifications, settings, recovery deduplication and edge status.
CREATE TABLE IF NOT EXISTS room_state (
  id text PRIMARY KEY CHECK (id = 'room-1'),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
