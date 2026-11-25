CREATE TABLE `board_locks` (
	`plaky_space_id` integer NOT NULL,
	`plaky_board_id` integer NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`plaky_space_id`, `plaky_board_id`)
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`monday_account_id` text NOT NULL,
	`monday_user_id` text NOT NULL,
	`monday_time_zone` text,
	`plaky_user_id` integer NOT NULL,
	`plaky_workspace_label` text,
	`validated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entity_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`monday_id` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`occurrence` integer DEFAULT 0 NOT NULL,
	`plaky_id` integer,
	`plaky_parent_id` integer,
	`match_key` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_verified_at` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `em_unique` ON `entity_mappings` (`migration_id`,`entity_type`,`scope`,`monday_id`,`occurrence`);--> statement-breakpoint
CREATE INDEX `em_plaky` ON `entity_mappings` (`entity_type`,`plaky_id`);--> statement-breakpoint
CREATE INDEX `em_status` ON `entity_mappings` (`migration_id`,`status`);--> statement-breakpoint
CREATE TABLE `ir_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_board_id` integer NOT NULL,
	`monday_item_id` text NOT NULL,
	`parent_monday_item_id` text,
	`title` text NOT NULL,
	`group_title` text,
	`state` text DEFAULT 'active' NOT NULL,
	`position` integer NOT NULL,
	`plaky_fields` text NOT NULL,
	`subscriber_ids` text DEFAULT '[]' NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`not_carried` text DEFAULT '[]' NOT NULL,
	`uncleared` text DEFAULT '[]' NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`migration_board_id`) REFERENCES `migration_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ir_board_item` ON `ir_items` (`migration_board_id`,`monday_item_id`);--> statement-breakpoint
CREATE TABLE `migration_boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`monday_board_id` text NOT NULL,
	`monday_board_name` text NOT NULL,
	`hierarchy_type` text DEFAULT 'classic' NOT NULL,
	`items_count` integer DEFAULT 0 NOT NULL,
	`subitems_of` text,
	`plaky_board_id` integer,
	`field_map` text DEFAULT '{}' NOT NULL,
	`skip_columns` text DEFAULT '[]' NOT NULL,
	`label_map` text DEFAULT '{}' NOT NULL,
	`monday_id_field_key` text,
	`parent_title_field_key` text,
	`parent_id_field_key` text,
	`seed_group_id` integer,
	`applied` integer DEFAULT false NOT NULL,
	`by_hand` text DEFAULT '[]' NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mb_migration_monday` ON `migration_boards` (`migration_id`,`monday_board_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mb_migration_plaky` ON `migration_boards` (`migration_id`,`plaky_board_id`);--> statement-breakpoint
CREATE TABLE `migration_columns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_board_id` integer NOT NULL,
	`monday_column_id` text NOT NULL,
	`title` text NOT NULL,
	`monday_type` text NOT NULL,
	`field_name` text NOT NULL,
	`plaky_type` text,
	`reason` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`label_collisions` text DEFAULT '[]' NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`migration_board_id`) REFERENCES `migration_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mc_board_column` ON `migration_columns` (`migration_board_id`,`monday_column_id`);--> statement-breakpoint
CREATE TABLE `migration_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`migration_board_id` integer,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`level` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`migration_board_id`) REFERENCES `migration_boards`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `logs_run_id` ON `migration_logs` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `migration_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`planned_writes` integer,
	`counts` text,
	`receipt` text,
	`started_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_migration` ON `migration_runs` (`migration_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `migrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`plaky_space_id` integer,
	`options` text NOT NULL,
	`people` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `people_resolutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`monday_kind` text NOT NULL,
	`monday_id` text NOT NULL,
	`name` text,
	`email` text,
	`monday_state` text,
	`placeholder_title` text,
	`members` text DEFAULT '[]' NOT NULL,
	`plaky_user_id` integer,
	`plaky_team_id` integer,
	`problem` text,
	`resolved_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_unique` ON `people_resolutions` (`migration_id`,`monday_kind`,`monday_id`);--> statement-breakpoint
CREATE TABLE `raw_payloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`source` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`api_version` text,
	`payload` text NOT NULL,
	`sha256` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rp_dedupe` ON `raw_payloads` (`migration_id`,`source`,`entity_type`,`entity_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `rp_lookup` ON `raw_payloads` (`migration_id`,`entity_type`,`entity_id`);