ALTER TABLE `migrations` ADD `schedule` text;--> statement-breakpoint
ALTER TABLE `migrations` ADD `seed_failures` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_mappings` DROP COLUMN `last_verified_at`;--> statement-breakpoint
-- The schedule leaves `options` for its own column (schema.ts says why).
UPDATE `migrations` SET `schedule` = json_extract(`options`, '$.schedule'), `options` = json_remove(`options`, '$.schedule') WHERE json_extract(`options`, '$.schedule') IS NOT NULL;--> statement-breakpoint
-- `rate_limited` is monday's daily limit only now. A run Plaky's 429 stopped counted `rateLimited`; one monday's limit met logged it, also when both happened.
UPDATE `migration_runs` SET `status` = 'plaky_rate_limited' WHERE `status` = 'rate_limited' AND json_extract(`counts`, '$.rateLimited') = 1
  AND NOT EXISTS (SELECT 1 FROM `migration_logs` l WHERE l.`run_id` = `migration_runs`.`id` AND l.`code` IN ('monday.daily_limit', 'monday.daily_limit_hit'));
