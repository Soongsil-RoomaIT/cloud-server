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
-- One row per completed one-hour indoor model run. The producer writes both
-- metrics together so a dashboard never reads half of a prediction.
CREATE TABLE IF NOT EXISTS prediction (
  generated_at timestamptz PRIMARY KEY,
  model_version text,
  control_enabled boolean NOT NULL DEFAULT false,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'array' AND jsonb_array_length(metrics) > 0)
);
-- The recommendation payload uses the same field names as the dashboard.
CREATE TABLE IF NOT EXISTS recommendation (
  id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (payload ?& ARRAY['id','metric','status','current','proposed','createdAt']
    AND payload->>'id' = id AND payload->>'status' IN ('PROPOSED','APPLIED','REJECTED','REVERTED'))
);
-- Small room state is saved atomically. JSON includes devices, commands,
-- decisions, notifications, settings, recovery deduplication and edge status.
CREATE TABLE IF NOT EXISTS room_state (
  id text PRIMARY KEY CHECK (id = 'room-1'),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
