CREATE TABLE `accounts` (
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	PRIMARY KEY(`provider`, `provider_account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`model_id` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`api_calls` integer DEFAULT 1 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_usage_project_idx` ON `agent_usage` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_usage_agent_idx` ON `agent_usage` (`agent_type`);--> statement-breakpoint
CREATE INDEX `agent_usage_month_idx` ON `agent_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`published_project_id` text,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`scene_id` text,
	`interaction_id` text,
	`data` text DEFAULT '{}',
	`user_agent` text,
	`country` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`published_project_id`) REFERENCES `published_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analytics_project_idx` ON `analytics_events` (`published_project_id`);--> statement-breakpoint
CREATE INDEX `analytics_event_type_idx` ON `analytics_events` (`published_project_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `analytics_session_idx` ON `analytics_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `analytics_created_idx` ON `analytics_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `api_spend` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`project_id` text,
	`api` text NOT NULL,
	`cost_usd` real NOT NULL,
	`description` text,
	`metadata` text DEFAULT '{}',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `spend_user_idx` ON `api_spend` (`user_id`);--> statement-breakpoint
CREATE INDEX `spend_user_created_idx` ON `api_spend` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `spend_api_created_idx` ON `api_spend` (`api`,`created_at`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`tags` text DEFAULT '[]',
	`description` text,
	`type` text DEFAULT 'canvas',
	`canvas_draw_fn` text,
	`svg_data` text,
	`default_width` integer DEFAULT 200,
	`default_height` integer DEFAULT 200,
	`bounds` text,
	`thumbnail_url` text,
	`is_built_in` integer DEFAULT true,
	`is_public` integer DEFAULT false,
	`user_id` text,
	`use_count` integer DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assets_category_idx` ON `assets` (`category`);--> statement-breakpoint
CREATE INDEX `assets_public_idx` ON `assets` (`is_public`);--> statement-breakpoint
CREATE TABLE `avatar_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text DEFAULT 'talkinghead' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`name` text DEFAULT 'Default Avatar' NOT NULL,
	`thumbnail_url` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `avatar_configs_project_idx` ON `avatar_configs` (`project_id`);--> statement-breakpoint
CREATE INDEX `avatar_configs_default_idx` ON `avatar_configs` (`project_id`,`is_default`);--> statement-breakpoint
CREATE TABLE `avatar_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scene_id` text,
	`avatar_config_id` text,
	`provider` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`text` text NOT NULL,
	`audio_url` text,
	`source_image_url` text,
	`video_url` text,
	`duration_seconds` real,
	`error_message` text,
	`cost_usd` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`avatar_config_id`) REFERENCES `avatar_configs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `avatar_videos_project_idx` ON `avatar_videos` (`project_id`);--> statement-breakpoint
CREATE INDEX `avatar_videos_scene_idx` ON `avatar_videos` (`scene_id`);--> statement-breakpoint
CREATE INDEX `avatar_videos_status_idx` ON `avatar_videos` (`status`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`is_pinned` integer DEFAULT false,
	`is_archived` integer DEFAULT false,
	`total_input_tokens` integer DEFAULT 0,
	`total_output_tokens` integer DEFAULT 0,
	`total_cost_usd` real DEFAULT 0,
	`last_message_at` integer DEFAULT (unixepoch()),
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conv_project_idx` ON `conversations` (`project_id`);--> statement-breakpoint
CREATE INDEX `conv_last_msg_idx` ON `conversations` (`project_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `generated_media` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`prompt` text,
	`model` text,
	`url` text,
	`status` text DEFAULT 'pending',
	`metadata` text DEFAULT '{}',
	`cost_usd` real,
	`external_job_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_hash_idx` ON `generated_media` (`prompt_hash`);--> statement-breakpoint
CREATE INDEX `media_user_idx` ON `generated_media` (`user_id`);--> statement-breakpoint
CREATE INDEX `media_status_idx` ON `generated_media` (`status`);--> statement-breakpoint
CREATE TABLE `generation_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`scene_id` text,
	`layer_id` text,
	`user_prompt` text NOT NULL,
	`system_prompt_hash` text,
	`system_prompt_snapshot` text,
	`injected_rules` text,
	`style_preset_id` text,
	`agent_type` text,
	`model_used` text,
	`thinking_mode` text,
	`scene_type` text,
	`generated_code_length` integer,
	`thinking_content` text,
	`generation_time_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`thinking_tokens` integer,
	`cost_usd` real,
	`user_action` text,
	`time_to_action_ms` integer,
	`edit_distance` integer,
	`user_rating` integer,
	`export_succeeded` integer,
	`export_error_message` text,
	`quality_score` real,
	`analysis_notes` text,
	`run_id` text,
	`run_trace` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`layer_id`) REFERENCES `layers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gen_log_project_idx` ON `generation_logs` (`project_id`);--> statement-breakpoint
CREATE INDEX `gen_log_model_idx` ON `generation_logs` (`model_used`);--> statement-breakpoint
CREATE INDEX `gen_log_preset_idx` ON `generation_logs` (`style_preset_id`);--> statement-breakpoint
CREATE INDEX `gen_log_action_idx` ON `generation_logs` (`user_action`);--> statement-breakpoint
CREATE INDEX `gen_log_created_idx` ON `generation_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `gen_log_run_id_idx` ON `generation_logs` (`run_id`);--> statement-breakpoint
CREATE TABLE `github_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`token_expires_at` integer,
	`last_pushed_sha` text,
	`last_pulled_sha` text,
	`linked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_links_project_idx` ON `github_links` (`project_id`);--> statement-breakpoint
CREATE INDEX `github_links_repo_idx` ON `github_links` (`repo_full_name`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interactions_scene_idx` ON `interactions` (`scene_id`);--> statement-breakpoint
CREATE TABLE `layers` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`parent_layer_id` text,
	`type` text NOT NULL,
	`label` text,
	`z_index` integer DEFAULT 0 NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`opacity` real DEFAULT 1 NOT NULL,
	`blend_mode` text DEFAULT 'normal',
	`start_at` real DEFAULT 0 NOT NULL,
	`duration` real,
	`generated_code` text,
	`elements` text DEFAULT '[]',
	`asset_placements` text DEFAULT '[]',
	`prompt` text,
	`model_used` text,
	`generated_at` integer,
	`layer_config` text,
	`media_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `generated_media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `layers_scene_idx` ON `layers` (`scene_id`);--> statement-breakpoint
CREATE INDEX `layers_type_idx` ON `layers` (`scene_id`,`type`);--> statement-breakpoint
CREATE INDEX `layers_zindex_idx` ON `layers` (`scene_id`,`z_index`);--> statement-breakpoint
CREATE TABLE `media_cache` (
	`hash` text PRIMARY KEY NOT NULL,
	`api` text NOT NULL,
	`file_path` text NOT NULL,
	`prompt` text,
	`model` text,
	`config` text,
	`content_hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_cache_content_hash_idx` ON `media_cache` (`content_hash`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`agent_type` text,
	`model_used` text,
	`thinking_content` text,
	`tool_calls` text DEFAULT '[]',
	`content_segments` text,
	`status` text DEFAULT 'complete' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`generation_log_id` text,
	`user_rating` integer,
	`duration_ms` integer,
	`api_calls` integer,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `msg_conv_idx` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `msg_project_idx` ON `messages` (`project_id`);--> statement-breakpoint
CREATE INDEX `msg_position_idx` ON `messages` (`conversation_id`,`position`);--> statement-breakpoint
CREATE INDEX `msg_created_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `permission_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`workspace_id` text,
	`project_id` text,
	`conversation_id` text,
	`decision` text NOT NULL,
	`api` text NOT NULL,
	`specifier` text DEFAULT 'null',
	`cost_cap_usd` real,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_by` text DEFAULT 'user-settings' NOT NULL,
	`notes` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `permission_rules_user_scope_idx` ON `permission_rules` (`user_id`,`scope`);--> statement-breakpoint
CREATE INDEX `permission_rules_project_idx` ON `permission_rules` (`project_id`);--> statement-breakpoint
CREATE INDEX `permission_rules_workspace_idx` ON `permission_rules` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `permission_rules_conversation_idx` ON `permission_rules` (`conversation_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `permission_sessions` (
	`api` text PRIMARY KEY NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`filename` text NOT NULL,
	`storage_path` text NOT NULL,
	`public_url` text NOT NULL,
	`type` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_seconds` real,
	`name` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`thumbnail_url` text,
	`extracted_colors` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`prompt` text,
	`provider` text,
	`model` text,
	`cost_cents` integer,
	`parent_asset_id` text,
	`reference_asset_ids` text,
	`enhance_tags` text,
	`content_hash` text,
	`source_url` text,
	`classification_timestamp` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_assets_project_idx` ON `project_assets` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_assets_type_idx` ON `project_assets` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `project_assets_source_idx` ON `project_assets` (`project_id`,`source`);--> statement-breakpoint
CREATE INDEX `project_assets_content_hash_idx` ON `project_assets` (`content_hash`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`workspace_id` text,
	`name` text NOT NULL,
	`description` text,
	`scene_graph_start_scene_id` text,
	`output_mode` text DEFAULT 'mp4',
	`storage_mode` text DEFAULT 'local',
	`global_style` text DEFAULT '{"presetId":null,"paletteOverride":null,"bgColorOverride":null,"fontOverride":null,"bodyFontOverride":null,"strokeColorOverride":null}',
	`storyboard_proposed` text DEFAULT 'null',
	`storyboard_edited` text DEFAULT 'null',
	`storyboard_applied` text DEFAULT 'null',
	`paused_agent_run` text DEFAULT 'null',
	`run_checkpoint` text DEFAULT 'null',
	`agent_config` text DEFAULT 'null',
	`mp4_settings` text DEFAULT '{"resolution":"1080p","fps":30,"format":"mp4","aspectRatio":"16:9"}',
	`interactive_settings` text DEFAULT '{"playerTheme":"dark","showProgressBar":true,"showSceneNav":false,"allowFullscreen":true,"brandColor":"#e84545","customDomain":null,"password":null}',
	`api_permissions` text DEFAULT '{}',
	`audio_settings` text DEFAULT '{"defaultTTSProvider":"auto","defaultSFXProvider":"auto","defaultMusicProvider":"auto","defaultVoiceId":null,"defaultVoiceName":null,"webSpeechVoice":null,"puterProvider":"openai","openaiTTSModel":"tts-1","openaiTTSVoice":"alloy","geminiTTSModel":"gemini-2.5-flash-preview-tts","geminiVoice":null,"edgeTTSUrl":null,"pocketTTSUrl":null,"voxcpmUrl":null,"globalMusicDucking":true,"globalMusicDuckLevel":0.2}',
	`audio_provider_enabled` text DEFAULT '{}',
	`media_gen_enabled` text DEFAULT '{}',
	`watermark` text DEFAULT 'null',
	`brand_kit` text DEFAULT 'null',
	`version` integer DEFAULT 1 NOT NULL,
	`thumbnail_url` text,
	`is_archived` integer DEFAULT false,
	`last_opened_at` integer DEFAULT (unixepoch()),
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `projects_user_idx` ON `projects` (`user_id`);--> statement-breakpoint
CREATE INDEX `projects_archived_idx` ON `projects` (`user_id`,`is_archived`);--> statement-breakpoint
CREATE INDEX `projects_updated_idx` ON `projects` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `projects_workspace_idx` ON `projects` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `published_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`user_id` text,
	`manifest` text,
	`version` integer DEFAULT 1 NOT NULL,
	`is_password_protected` integer DEFAULT false,
	`password_hash` text,
	`is_active` integer DEFAULT true,
	`view_count` integer DEFAULT 0,
	`custom_domain` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `published_project_idx` ON `published_projects` (`project_id`);--> statement-breakpoint
CREATE INDEX `published_active_idx` ON `published_projects` (`is_active`);--> statement-breakpoint
CREATE TABLE `scene_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_scene_id` text,
	`to_scene_id` text,
	`condition` text DEFAULT '{"type":"auto","interactionId":null,"variableName":null,"variableValue":null}',
	`position` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `edges_project_idx` ON `scene_edges` (`project_id`);--> statement-breakpoint
CREATE TABLE `scene_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`position` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nodes_project_idx` ON `scene_nodes` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_project_scene_unique_idx` ON `scene_nodes` (`project_id`,`scene_id`);--> statement-breakpoint
CREATE TABLE `scene_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`tags` text DEFAULT '[]',
	`layers` text DEFAULT '[]',
	`duration` real DEFAULT 8,
	`style_override` text DEFAULT '{}',
	`placeholders` text DEFAULT '[]',
	`thumbnail_url` text,
	`is_built_in` integer DEFAULT false,
	`is_public` integer DEFAULT false,
	`user_id` text,
	`use_count` integer DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `templates_category_idx` ON `scene_templates` (`category`);--> statement-breakpoint
CREATE INDEX `templates_public_idx` ON `scene_templates` (`is_public`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text,
	`position` integer NOT NULL,
	`duration` real DEFAULT 8 NOT NULL,
	`bg_color` text DEFAULT '#fffef9',
	`style_override` text DEFAULT '{}',
	`transition` text DEFAULT '{"type":"none","duration":0.5}',
	`audio_layer` text,
	`video_layer` text,
	`thumbnail_url` text,
	`grid_config` text,
	`camera_motion` text,
	`world_config` text,
	`scene_blob` text DEFAULT 'null',
	`avatar_config_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenes_project_idx` ON `scenes` (`project_id`);--> statement-breakpoint
CREATE INDEX `scenes_position_idx` ON `scenes` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`operation` text NOT NULL,
	`diff` text NOT NULL,
	`agent_message` text,
	`agent_type` text,
	`stack_index` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_project_idx` ON `snapshots` (`project_id`);--> statement-breakpoint
CREATE INDEX `snapshots_stack_idx` ON `snapshots` (`project_id`,`stack_index`);--> statement-breakpoint
CREATE TABLE `three_d_components` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`tags` text DEFAULT '[]',
	`description` text,
	`build_fn` text,
	`thumbnail_url` text,
	`animates` integer DEFAULT true,
	`is_built_in` integer DEFAULT true,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `timeline_clips` (
	`id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`start_time` real NOT NULL,
	`duration` real NOT NULL,
	`trim_start` real DEFAULT 0 NOT NULL,
	`trim_end` real,
	`speed` real DEFAULT 1 NOT NULL,
	`opacity` real DEFAULT 1 NOT NULL,
	`position` text DEFAULT '{"x":0,"y":0}' NOT NULL,
	`scale` text DEFAULT '{"x":1,"y":1}' NOT NULL,
	`rotation` real DEFAULT 0 NOT NULL,
	`filters` text DEFAULT '[]' NOT NULL,
	`keyframes` text DEFAULT '[]' NOT NULL,
	`transition` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `timeline_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `timeline_clips_track_idx` ON `timeline_clips` (`track_id`);--> statement-breakpoint
CREATE INDEX `timeline_clips_source_idx` ON `timeline_clips` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `timeline_clips_start_idx` ON `timeline_clips` (`track_id`,`start_time`);--> statement-breakpoint
CREATE TABLE `timeline_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `timeline_tracks_project_idx` ON `timeline_tracks` (`project_id`);--> statement-breakpoint
CREATE INDEX `timeline_tracks_position_idx` ON `timeline_tracks` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `user_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`source_run_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_memory_user_idx` ON `user_memory` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_memory_user_key_idx` ON `user_memory` (`user_id`,`category`,`key`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`email_verified` integer,
	`image` text,
	`avatar_url` text,
	`plan` text DEFAULT 'free',
	`default_storage_mode` text DEFAULT 'local',
	`preferences` text DEFAULT '{}',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`icon` text,
	`brand_kit` text DEFAULT 'null',
	`global_style` text DEFAULT 'null',
	`settings` text DEFAULT '{}',
	`is_default` integer DEFAULT false,
	`is_archived` integer DEFAULT false,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspaces_user_idx` ON `workspaces` (`user_id`);--> statement-breakpoint
CREATE INDEX `workspaces_default_idx` ON `workspaces` (`user_id`,`is_default`);