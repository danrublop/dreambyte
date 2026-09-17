-- T23: persist the duration-scaled reserved cost on the video job so the stateless poll loop
-- commits the SAME amount it reserved. Without this, pollVideoStatus logged a flat
-- provider.costPerCallUsd while startVideo reserved estimateApiCostUsd(api,{duration}) — for
-- per-second models (LTX $0.06/s, Seedance $0.30/s) an 8s clip reserved ~8x what it committed.
-- Hand-authored (sparse drizzle snapshots — see 0018_video_jobs.sql). Applied once via the
-- journal, so the non-idempotent ADD (mirroring 0019) is safe.
ALTER TABLE `video_jobs` ADD `estimated_cost_cents` integer;
