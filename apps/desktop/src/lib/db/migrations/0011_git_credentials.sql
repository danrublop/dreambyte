-- P5-remote-storage of NLE-FOUNDATION.
-- Encrypted Personal Access Tokens per (project, remote). The token blob
-- is wrapped by Electron's safeStorage (OS-keychain key) before insert
-- and unwrapped only in the main process during push/pull. Renderer
-- never sees the plaintext.
--> statement-breakpoint
CREATE TABLE `git_credentials` (
  `project_id` text NOT NULL,
  `remote_name` text NOT NULL,
  `encrypted_token` blob NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`project_id`, `remote_name`),
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade
);
