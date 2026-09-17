-- One-time cleanup: remove reference-document assets ('doc') that leaked into
-- the media library before docs were made reference-only. Newer doc rows are
-- kept for their file URIs but hidden from the gallery/timeline (see the
-- GalleryPanel filter + addAssetToTimeline guard); this clears the old
-- accumulated ones. Runs once (drizzle journal-tracked). Files on disk are left
-- in place — harmless, and reference URIs serve straight from disk, not the row.
DELETE FROM project_assets WHERE type = 'doc';
