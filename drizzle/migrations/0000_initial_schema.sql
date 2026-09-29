CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`updated_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_app_settings_org_key` ON `app_settings` (`organization_id`,`key`);--> statement-breakpoint
CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`head_user_id` text,
	`parent_department_id` text,
	`root_folder_id` text,
	`storage_quota_bytes` integer NOT NULL,
	`storage_used_bytes` integer DEFAULT 0 NOT NULL,
	`member_count` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`head_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_departments_org_code` ON `departments` (`organization_id`,`code`);--> statement-breakpoint
CREATE INDEX `ix_departments_org_active` ON `departments` (`organization_id`,`is_active`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_departments_head` ON `departments` (`head_user_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`email_domains` text DEFAULT '[]' NOT NULL,
	`settings` text NOT NULL,
	`storage_used_bytes` integer DEFAULT 0 NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_organizations_slug` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `user_auth_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text,
	`linked_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_user_auth_providers` ON `user_auth_providers` (`user_id`,`provider`);--> statement-breakpoint
CREATE INDEX `ix_user_auth_providers_account` ON `user_auth_providers` (`provider`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`email_domain` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`job_title` text,
	`phone` text,
	`password_hash` text,
	`password_updated_at` text,
	`must_change_password` integer DEFAULT false NOT NULL,
	`mfa` text DEFAULT '{"enabled":false}' NOT NULL,
	`preferences` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`is_super_admin` integer DEFAULT false NOT NULL,
	`department_id` text,
	`storage_quota_bytes` integer NOT NULL,
	`storage_used_bytes` integer DEFAULT 0 NOT NULL,
	`last_login_at` text,
	`last_active_at` text,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`invited_by` text,
	`invited_at` text,
	`activated_at` text,
	`deactivated_at` text,
	`deactivated_by` text,
	`deactivation_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deactivated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `ix_users_org_status_dept` ON `users` (`organization_id`,`status`,`department_id`);--> statement-breakpoint
CREATE INDEX `ix_users_locked` ON `users` (`locked_until`);--> statement-breakpoint
CREATE INDEX `ix_users_status` ON `users` (`status`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`key` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resource_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`access_level` text NOT NULL,
	`deny` integer DEFAULT false NOT NULL,
	`expires_at` text,
	`granted_by` text,
	`granted_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_resource_permissions_principal` ON `resource_permissions` (`principal_id`,`principal_type`);--> statement-breakpoint
CREATE INDEX `ix_resource_permissions_resource` ON `resource_permissions` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `ix_resource_permissions_deny` ON `resource_permissions` (`resource_type`,`resource_id`,`principal_id`) WHERE deny = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_resource_permissions` ON `resource_permissions` (`resource_type`,`resource_id`,`principal_type`,`principal_id`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission_key` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_role_permissions` ON `role_permissions` (`role_id`,`permission_key`);--> statement-breakpoint
CREATE INDEX `ix_role_permissions_permission` ON `role_permissions` (`permission_key`);--> statement-breakpoint
CREATE TABLE `role_scope_types` (
	`role_id` text NOT NULL,
	`scope_type` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_role_scope_types` ON `role_scope_types` (`role_id`,`scope_type`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`rank` integer NOT NULL,
	`max_confidentiality` text DEFAULT 'internal' NOT NULL,
	`company_wide_read` integer DEFAULT false NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_roles_org_key` ON `roles` (`organization_id`,`key`);--> statement-breakpoint
CREATE INDEX `ix_roles_org_rank` ON `roles` (`organization_id`,`rank`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`granted_by` text,
	`granted_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`revoked_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_user_roles_active` ON `user_roles` (`user_id`,`role_id`,`scope_type`,`scope_id`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `ix_user_roles_user` ON `user_roles` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `ix_user_roles_scope` ON `user_roles` (`scope_type`,`scope_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `ix_user_roles_expiry` ON `user_roles` (`expires_at`);--> statement-breakpoint
CREATE TABLE `experiment_collaborators` (
	`experiment_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_experiment_collaborators` ON `experiment_collaborators` (`experiment_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_experiment_collaborators_user` ON `experiment_collaborators` (`user_id`);--> statement-breakpoint
CREATE TABLE `experiment_samples` (
	`experiment_id` text NOT NULL,
	`sample_id` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_experiment_samples` ON `experiment_samples` (`experiment_id`,`sample_id`);--> statement-breakpoint
CREATE INDEX `ix_experiment_samples_sample` ON `experiment_samples` (`sample_id`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`department_id` text,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`objective` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`outcome_summary` text DEFAULT '' NOT NULL,
	`lead_user_id` text,
	`protocol_ref` text DEFAULT '' NOT NULL,
	`instrument_ref` text DEFAULT '' NOT NULL,
	`organism` text DEFAULT '' NOT NULL,
	`started_on` text,
	`completed_on` text,
	`folder_id` text,
	`confidentiality` text DEFAULT 'internal' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_experiments_org_code` ON `experiments` (`organization_id`,`code`);--> statement-breakpoint
CREATE INDEX `ix_experiments_project` ON `experiments` (`project_id`,`deleted_at`,`code`);--> statement-breakpoint
CREATE INDEX `ix_experiments_org_dept_status` ON `experiments` (`organization_id`,`department_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_experiments_lead` ON `experiments` (`lead_user_id`);--> statement-breakpoint
CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_at` text NOT NULL,
	`added_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_project_members` ON `project_members` (`project_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_project_members_user` ON `project_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`department_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`lead_user_id` text,
	`root_folder_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`confidentiality` text DEFAULT 'internal' NOT NULL,
	`start_date` text,
	`target_end_date` text,
	`completed_at` text,
	`storage_used_bytes` integer DEFAULT 0 NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_projects_org_code` ON `projects` (`organization_id`,`code`);--> statement-breakpoint
CREATE INDEX `ix_projects_org_dept_status` ON `projects` (`organization_id`,`department_id`,`status`);--> statement-breakpoint
CREATE TABLE `file_folder_ancestors` (
	`file_id` text NOT NULL,
	`ancestor_id` text NOT NULL,
	`depth` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ancestor_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_file_folder_ancestors` ON `file_folder_ancestors` (`file_id`,`ancestor_id`);--> statement-breakpoint
CREATE INDEX `ix_file_folder_ancestors_ancestor` ON `file_folder_ancestors` (`ancestor_id`);--> statement-breakpoint
CREATE TABLE `file_metadata` (
	`file_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_file_metadata` ON `file_metadata` (`file_id`,`key`);--> statement-breakpoint
CREATE INDEX `ix_file_metadata_lookup` ON `file_metadata` (`key`,`value`);--> statement-breakpoint
CREATE TABLE `file_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`file_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`storage_key` text NOT NULL,
	`storage_area` text NOT NULL,
	`relative_storage_path` text,
	`stored_filename` text,
	`original_filename` text NOT NULL,
	`file_size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`extension` text NOT NULL,
	`checksum_sha256` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`version_note` text DEFAULT '' NOT NULL,
	`restored_from_version_id` text,
	`processing_status` text DEFAULT 'pending' NOT NULL,
	`label` text DEFAULT 'draft' NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`is_approved` integer DEFAULT false NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`approved_revision_id` text,
	`approved_content_modified_at` text,
	`approval_superseded_at` text,
	`approval_superseded_reason` text,
	`preview_key` text,
	`preview_status` text DEFAULT 'none' NOT NULL,
	`storage_provider` text DEFAULT 'local' NOT NULL,
	`google_drive_file_id` text,
	`google_drive_parent_id` text,
	`google_drive_revision_id` text,
	`google_drive_md5` text,
	`google_drive_modified_time` text,
	`google_drive_web_view_link` text,
	`migration_status` text DEFAULT 'not_started' NOT NULL,
	`migrated_at` text,
	`migration_failure_reason` text,
	`sync_status` text DEFAULT 'not_required' NOT NULL,
	`last_synced_at` text,
	`local_copy_state` text DEFAULT 'present' NOT NULL,
	`local_copy_eligible_for_deletion_at` text,
	`archived_storage_key` text,
	`local_copy_archived_at` text,
	`local_copy_deleted_at` text,
	`is_google_native` integer DEFAULT false NOT NULL,
	`google_native_kind` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`restored_from_version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_file_versions_number` ON `file_versions` (`file_id`,`version_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_file_versions_storage_key` ON `file_versions` (`storage_key`);--> statement-breakpoint
CREATE INDEX `ix_file_versions_current` ON `file_versions` (`file_id`,`is_current`);--> statement-breakpoint
CREATE INDEX `ix_file_versions_checksum` ON `file_versions` (`checksum_sha256`);--> statement-breakpoint
CREATE INDEX `ix_file_versions_processing` ON `file_versions` (`organization_id`,`processing_status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_file_versions_drive_id` ON `file_versions` (`google_drive_file_id`) WHERE google_drive_file_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_file_versions_migration` ON `file_versions` (`storage_provider`,`migration_status`,`id`);--> statement-breakpoint
CREATE INDEX `ix_file_versions_sync` ON `file_versions` (`sync_status`,`last_synced_at`) WHERE sync_status IN ('pending', 'failed', 'conflict');--> statement-breakpoint
CREATE INDEX `ix_file_versions_approval_integrity` ON `file_versions` (`storage_provider`,`approval_superseded_at`,`id`) WHERE is_approved = 1;--> statement-breakpoint
CREATE INDEX `ix_file_versions_local_copy` ON `file_versions` (`local_copy_state`,`local_copy_eligible_for_deletion_at`) WHERE local_copy_state = 'present';--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`display_name` text NOT NULL,
	`display_name_lower` text NOT NULL,
	`original_filename` text NOT NULL,
	`extension` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`folder_id` text NOT NULL,
	`drive_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`department_id` text,
	`project_id` text,
	`experiment_id` text,
	`current_version_id` text,
	`approved_version_id` text,
	`version_count` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`checksum_sha256` text,
	`confidentiality` text DEFAULT 'internal' NOT NULL,
	`review_status` text DEFAULT 'draft' NOT NULL,
	`approval_status` text DEFAULT 'none' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`inherit_permissions` integer DEFAULT true NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`last_accessed_at` text,
	`created_by` text NOT NULL,
	`updated_by` text,
	`archived_at` text,
	`trashed_with_folder_id` text,
	`storage_provider` text DEFAULT 'local' NOT NULL,
	`has_google_native_content` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trashed_with_folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_files_folder` ON `files` (`folder_id`,`deleted_at`,`display_name`);--> statement-breakpoint
CREATE INDEX `ix_files_owner` ON `files` (`organization_id`,`owner_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_files_department` ON `files` (`organization_id`,`department_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_files_project` ON `files` (`organization_id`,`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_files_experiment` ON `files` (`experiment_id`);--> statement-breakpoint
CREATE INDEX `ix_files_review` ON `files` (`organization_id`,`review_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_files_approval` ON `files` (`organization_id`,`approval_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_files_checksum` ON `files` (`checksum_sha256`);--> statement-breakpoint
CREATE TABLE `folder_ancestors` (
	`folder_id` text NOT NULL,
	`ancestor_id` text NOT NULL,
	`depth` integer NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ancestor_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_folder_ancestors` ON `folder_ancestors` (`folder_id`,`ancestor_id`);--> statement-breakpoint
CREATE INDEX `ix_folder_ancestors_ancestor` ON `folder_ancestors` (`ancestor_id`);--> statement-breakpoint
CREATE INDEX `ix_folder_ancestors_ordered` ON `folder_ancestors` (`folder_id`,`depth`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`name_lower` text NOT NULL,
	`parent_folder_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`drive_type` text NOT NULL,
	`root_key` text,
	`owner_id` text NOT NULL,
	`department_id` text,
	`project_id` text,
	`inherit_permissions` integer DEFAULT true NOT NULL,
	`confidentiality` text DEFAULT 'internal' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text,
	`template_key` text,
	`is_system` integer DEFAULT false NOT NULL,
	`child_folder_count` integer DEFAULT 0 NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text,
	`archived_at` text,
	`trashed_with_folder_id` text,
	`storage_provider` text DEFAULT 'local' NOT NULL,
	`google_drive_folder_id` text,
	`google_drive_parent_folder_id` text,
	`drive_mapping_status` text DEFAULT 'none' NOT NULL,
	`drive_mapped_at` text,
	`sync_status` text DEFAULT 'not_required' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trashed_with_folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_folders_root_key` ON `folders` (`root_key`) WHERE root_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_folders_parent_name` ON `folders` (`parent_folder_id`,`name_lower`) WHERE deleted_at IS NULL AND parent_folder_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_folders_parent` ON `folders` (`organization_id`,`parent_folder_id`,`deleted_at`,`name`);--> statement-breakpoint
CREATE INDEX `ix_folders_drive_owner` ON `folders` (`organization_id`,`drive_type`,`owner_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_folders_department` ON `folders` (`organization_id`,`department_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_folders_project` ON `folders` (`organization_id`,`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_folders_status` ON `folders` (`organization_id`,`status`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_folders_drive_id` ON `folders` (`google_drive_folder_id`) WHERE google_drive_folder_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_folders_drive_mapping` ON `folders` (`organization_id`,`drive_mapping_status`);--> statement-breakpoint
CREATE TABLE `resource_tags` (
	`organization_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`tag` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_resource_tags` ON `resource_tags` (`resource_type`,`resource_id`,`tag`);--> statement-breakpoint
CREATE INDEX `ix_resource_tags_tag` ON `resource_tags` (`organization_id`,`tag`,`resource_type`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`file_id` text NOT NULL,
	`version_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`reviewer_name` text NOT NULL,
	`reviewer_email` text NOT NULL,
	`decision` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`decided_at` text NOT NULL,
	`ip` text DEFAULT 'unknown' NOT NULL,
	`user_agent` text DEFAULT 'unknown' NOT NULL,
	`request_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_approvals_review` ON `approvals` (`review_id`,`decided_at`);--> statement-breakpoint
CREATE INDEX `ix_approvals_reviewer` ON `approvals` (`reviewer_user_id`,`decided_at`);--> statement-breakpoint
CREATE INDEX `ix_approvals_version` ON `approvals` (`version_id`);--> statement-breakpoint
CREATE INDEX `ix_approvals_file` ON `approvals` (`file_id`,`decided_at`);--> statement-breakpoint
CREATE TABLE `comment_mentions` (
	`comment_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_comment_mentions` ON `comment_mentions` (`comment_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_comment_mentions_user` ON `comment_mentions` (`user_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`file_id` text NOT NULL,
	`version_id` text,
	`version_number` integer,
	`parent_comment_id` text,
	`author_user_id` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`is_review_comment` integer DEFAULT false NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`edited_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_comments_thread` ON `comments` (`file_id`,`parent_comment_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_comments_unresolved` ON `comments` (`file_id`,`resolved_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_comments_author` ON `comments` (`author_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_user_id` text,
	`actor_name` text DEFAULT '' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_label` text DEFAULT '' NOT NULL,
	`message` text NOT NULL,
	`read_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_notifications_unread` ON `notifications` (`user_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_notifications_user` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_notifications_entity` ON `notifications` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `review_reviewers` (
	`review_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_review_reviewers` ON `review_reviewers` (`review_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_review_reviewers_user` ON `review_reviewers` (`user_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`file_id` text NOT NULL,
	`version_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`file_name` text NOT NULL,
	`version_checksum` text NOT NULL,
	`version_revision_id` text,
	`version_content_modified_at` text,
	`requested_by` text NOT NULL,
	`requested_by_name` text NOT NULL,
	`request_note` text DEFAULT '' NOT NULL,
	`required_approvals` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` text,
	`closed_at` text,
	`department_id` text,
	`project_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_reviews_file` ON `reviews` (`file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_reviews_org_status` ON `reviews` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_reviews_requester` ON `reviews` (`requested_by`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_reviews_open_per_version` ON `reviews` (`version_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE `inventory_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`batch_number` text NOT NULL,
	`quantity` integer NOT NULL,
	`expiry_date` text,
	`supplier` text DEFAULT '' NOT NULL,
	`storage_location` text DEFAULT '' NOT NULL,
	`received_at` text NOT NULL,
	`received_by` text,
	`receipt_transaction_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_inventory_batches_quantity" CHECK(quantity >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_inventory_batches` ON `inventory_batches` (`item_id`,`batch_number`);--> statement-breakpoint
CREATE INDEX `ix_inventory_batches_fefo` ON `inventory_batches` (`item_id`,`expiry_date`);--> statement-breakpoint
CREATE INDEX `ix_inventory_batches_expiry` ON `inventory_batches` (`expiry_date`);--> statement-breakpoint
CREATE TABLE `inventory_item_documents` (
	`item_id` text NOT NULL,
	`file_id` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_inventory_item_documents` ON `inventory_item_documents` (`item_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`department_id` text,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`category` text NOT NULL,
	`unit` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`available_quantity` integer DEFAULT 0 NOT NULL,
	`minimum_stock` integer DEFAULT 0 NOT NULL,
	`stock_state` text DEFAULT 'out_of_stock' NOT NULL,
	`batch_number` text DEFAULT '' NOT NULL,
	`expiry_date` text,
	`storage_location` text DEFAULT '' NOT NULL,
	`supplier` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_inventory_items_quantity" CHECK(available_quantity >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_inventory_items_org_code` ON `inventory_items` (`organization_id`,`code`);--> statement-breakpoint
CREATE INDEX `ix_inventory_items_status_category` ON `inventory_items` (`organization_id`,`status`,`category`);--> statement-breakpoint
CREATE INDEX `ix_inventory_items_department` ON `inventory_items` (`organization_id`,`department_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_inventory_items_stock_state` ON `inventory_items` (`organization_id`,`stock_state`);--> statement-breakpoint
CREATE INDEX `ix_inventory_items_expiry` ON `inventory_items` (`organization_id`,`expiry_date`);--> statement-breakpoint
CREATE INDEX `ix_inventory_items_name` ON `inventory_items` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `stock_transaction_documents` (
	`transaction_id` text NOT NULL,
	`file_id` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `stock_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_stock_transaction_documents` ON `stock_transaction_documents` (`transaction_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `stock_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`item_id` text NOT NULL,
	`item_code` text NOT NULL,
	`item_name` text NOT NULL,
	`department_id` text,
	`action` text NOT NULL,
	`quantity` integer NOT NULL,
	`quantity_delta` integer NOT NULL,
	`previous_quantity` integer NOT NULL,
	`new_quantity` integer NOT NULL,
	`unit` text NOT NULL,
	`batch_number` text DEFAULT '' NOT NULL,
	`expiry_date` text,
	`supplier` text DEFAULT '' NOT NULL,
	`storage_location` text DEFAULT '' NOT NULL,
	`issued_to_type` text,
	`issued_to_user_id` text,
	`issued_to_department_id` text,
	`project_id` text,
	`experiment_id` text,
	`issued_to_label` text DEFAULT '' NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`performed_by` text,
	`performed_by_name` text DEFAULT '' NOT NULL,
	`performed_at` text NOT NULL,
	`request_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_to_department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`performed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_stock_transactions_quantity" CHECK(quantity >= 0),
	CONSTRAINT "ck_stock_transactions_new_quantity" CHECK(new_quantity >= 0)
);
--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_org` ON `stock_transactions` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_item` ON `stock_transactions` (`item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_action` ON `stock_transactions` (`organization_id`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_performer` ON `stock_transactions` (`performed_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_project` ON `stock_transactions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_experiment` ON `stock_transactions` (`experiment_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_issued_to` ON `stock_transactions` (`issued_to_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_stock_transactions_batch` ON `stock_transactions` (`organization_id`,`batch_number`);--> statement-breakpoint
CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_label` text DEFAULT '' NOT NULL,
	`department_id` text,
	`project_id` text,
	`detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_activities_entity` ON `activities` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_activities_org` ON `activities` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_activities_actor` ON `activities` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_activities_project` ON `activities` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `activity_folders` (
	`activity_id` text NOT NULL,
	`folder_id` text NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_activity_folders` ON `activity_folders` (`activity_id`,`folder_id`);--> statement-breakpoint
CREATE INDEX `ix_activity_folders_folder` ON `activity_folders` (`folder_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`actor_user_id` text,
	`actor_email` text,
	`actor_role_keys` text DEFAULT '[]' NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`entity_label` text,
	`previous_value` text,
	`new_value` text,
	`reason` text,
	`ip` text DEFAULT 'unknown' NOT NULL,
	`user_agent` text DEFAULT 'unknown' NOT NULL,
	`request_id` text,
	`outcome` text DEFAULT 'success' NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_audit_logs_org` ON `audit_logs` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_logs_actor` ON `audit_logs` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_logs_entity` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_logs_action` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_logs_request` ON `audit_logs` (`request_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_logs_outcome` ON `audit_logs` (`outcome`,`created_at`);--> statement-breakpoint
CREATE TABLE `login_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`outcome` text NOT NULL,
	`provider` text DEFAULT 'password' NOT NULL,
	`ip` text DEFAULT 'unknown' NOT NULL,
	`user_agent` text DEFAULT 'unknown' NOT NULL,
	`session_id` text,
	`detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_login_history_user` ON `login_history` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_login_history_email` ON `login_history` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_login_history_outcome` ON `login_history` (`outcome`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_login_history_ip` ON `login_history` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_login_history_retention` ON `login_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`requested_ip` text DEFAULT 'unknown' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_password_reset_tokens_hash` ON `password_reset_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_password_reset_tokens_user` ON `password_reset_tokens` (`user_id`,`used_at`);--> statement-breakpoint
CREATE INDEX `ix_password_reset_tokens_expiry` ON `password_reset_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `recent_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`last_action` text DEFAULT 'opened' NOT NULL,
	`last_accessed_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_recent_items` ON `recent_items` (`user_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ix_recent_items_user` ON `recent_items` (`user_id`,`last_accessed_at`);--> statement-breakpoint
CREATE TABLE `saved_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_lower` text NOT NULL,
	`criteria` text NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`last_run_at` text,
	`run_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_saved_searches_user_name` ON `saved_searches` (`user_id`,`name_lower`);--> statement-breakpoint
CREATE INDEX `ix_saved_searches_user` ON `saved_searches` (`user_id`,`is_pinned`,`updated_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`absolute_expires_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`rotated_from_id` text,
	`rotated_at` text,
	`ip` text DEFAULT 'unknown' NOT NULL,
	`user_agent` text DEFAULT 'unknown' NOT NULL,
	`device_label` text DEFAULT 'Unknown device' NOT NULL,
	`provider` text DEFAULT 'password' NOT NULL,
	`revoked_at` text,
	`revoked_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rotated_from_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_sessions_token_hash` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_sessions_user` ON `sessions` (`user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `ix_sessions_absolute_expiry` ON `sessions` (`absolute_expires_at`);--> statement-breakpoint
CREATE TABLE `stars` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_stars` ON `stars` (`user_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ix_stars_user` ON `stars` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `alert_states` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`severity` text NOT NULL,
	`last_sent_at` text NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`last_detail` text DEFAULT '' NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_alert_states_key` ON `alert_states` (`key`);--> statement-breakpoint
CREATE TABLE `d1_migration_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`collection` text NOT NULL,
	`source_id` text NOT NULL,
	`reason` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_d1_migration_failures_run` ON `d1_migration_failures` (`run_id`,`collection`);--> statement-breakpoint
CREATE INDEX `ix_d1_migration_failures_source` ON `d1_migration_failures` (`source_id`);--> statement-breakpoint
CREATE TABLE `d1_migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`collection` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`last_id` text,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`rows_skipped` integer DEFAULT 0 NOT NULL,
	`rows_failed` integer DEFAULT 0 NOT NULL,
	`source_count` integer,
	`target_count` integer,
	`started_at` text,
	`finished_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_d1_migration_runs` ON `d1_migration_runs` (`run_id`,`collection`);--> statement-breakpoint
CREATE INDEX `ix_d1_migration_runs_status` ON `d1_migration_runs` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `drive_sync_states` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`shared_drive_id` text NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`start_page_token` text,
	`token_expired_at` text,
	`last_poll_at` text,
	`last_successful_poll_at` text,
	`last_full_reconcile_at` text,
	`changes_applied` integer DEFAULT 0 NOT NULL,
	`conflicts_detected` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_drive_sync_states` ON `drive_sync_states` (`organization_id`,`shared_drive_id`);--> statement-breakpoint
CREATE TABLE `import_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`drive_file_id` text NOT NULL,
	`drive_parent_id` text,
	`source_path` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`mime_type` text DEFAULT '' NOT NULL,
	`declared_size` integer DEFAULT 0 NOT NULL,
	`drive_md5` text,
	`drive_created_time` text,
	`drive_modified_time` text,
	`is_google_native` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`target_folder_id` text,
	`result_file_id` text,
	`result_version_id` text,
	`checksum_sha256` text,
	`imported_bytes` integer DEFAULT 0 NOT NULL,
	`duplicate_of_file_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`imported_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_of_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_import_items_job_drive_file` ON `import_items` (`job_id`,`drive_file_id`);--> statement-breakpoint
CREATE INDEX `ix_import_items_job_status` ON `import_items` (`job_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `ix_import_items_org_drive_file` ON `import_items` (`organization_id`,`drive_file_id`);--> statement-breakpoint
CREATE INDEX `ix_import_items_result` ON `import_items` (`result_file_id`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`target_folder_id` text NOT NULL,
	`department_id` text,
	`project_id` text,
	`confidentiality` text DEFAULT 'internal' NOT NULL,
	`source_folder_ids` text DEFAULT '[]' NOT NULL,
	`connection_account_email` text,
	`connection_refresh_token_cipher` text,
	`connection_scope` text,
	`connected_at` text,
	`connected_by` text,
	`option_preserve_hierarchy` integer DEFAULT true NOT NULL,
	`option_preserve_dates` integer DEFAULT true NOT NULL,
	`option_skip_duplicates` integer DEFAULT true NOT NULL,
	`option_export_google_docs` integer DEFAULT true NOT NULL,
	`counters` text DEFAULT '{}' NOT NULL,
	`scan_started_at` text,
	`scan_completed_at` text,
	`import_started_at` text,
	`completed_at` text,
	`last_error` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`deleted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_import_jobs_org` ON `import_jobs` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_import_jobs_creator` ON `import_jobs` (`created_by`,`created_at`);--> statement-breakpoint
CREATE TABLE `storage_migration_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`version_id` text NOT NULL,
	`file_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`version_number` integer DEFAULT 1 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`claim_active` integer DEFAULT false NOT NULL,
	`claimed_at` text,
	`claimed_by` text,
	`idempotency_key` text NOT NULL,
	`google_drive_file_id` text,
	`google_drive_parent_id` text,
	`local_sha256` text,
	`local_md5` text,
	`remote_md5` text,
	`checksum_verified` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failure_code` text,
	`failure_detail` text,
	`started_at` text,
	`finished_at` text,
	`transfer_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `storage_migration_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_storage_migration_items_job_version` ON `storage_migration_items` (`job_id`,`version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_storage_migration_items_claim` ON `storage_migration_items` (`version_id`) WHERE claim_active = 1;--> statement-breakpoint
CREATE INDEX `ix_storage_migration_items_job_status` ON `storage_migration_items` (`job_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `ix_storage_migration_items_failures` ON `storage_migration_items` (`job_id`,`failure_code`);--> statement-breakpoint
CREATE INDEX `ix_storage_migration_items_version` ON `storage_migration_items` (`version_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_storage_migration_items_stale` ON `storage_migration_items` (`claimed_at`) WHERE claim_active = 1;--> statement-breakpoint
CREATE TABLE `storage_migration_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`selection` text DEFAULT '{}' NOT NULL,
	`counters` text DEFAULT '{}' NOT NULL,
	`throughput_samples` text DEFAULT '[]' NOT NULL,
	`failure_counts` text DEFAULT '{}' NOT NULL,
	`pause_requested` integer DEFAULT false NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`planned_at` text,
	`started_at` text,
	`finished_at` text,
	`last_error` text,
	`last_progress_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_storage_migration_jobs_org` ON `storage_migration_jobs` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_storage_migration_jobs_creator` ON `storage_migration_jobs` (`created_by`,`created_at`);--> statement-breakpoint
CREATE TABLE `storage_recovery_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`version_id` text,
	`folder_id` text,
	`job_id` text,
	`phase` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`idempotency_key` text NOT NULL,
	`observed_drive_file_id` text,
	`previous_state` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`detail` text,
	`resolved_at` text,
	`resolved_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `storage_migration_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_storage_recovery_items_open` ON `storage_recovery_items` (`idempotency_key`) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX `ix_storage_recovery_items_open` ON `storage_recovery_items` (`organization_id`,`last_attempt_at`) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX `ix_storage_recovery_items_org` ON `storage_recovery_items` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_storage_recovery_items_version` ON `storage_recovery_items` (`version_id`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`queue_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`idempotency_key` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`last_error` text,
	`scheduled_at` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_sync_jobs_idempotency` ON `sync_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ix_sync_jobs_status` ON `sync_jobs` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `ix_sync_jobs_kind` ON `sync_jobs` (`kind`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_sync_jobs_entity` ON `sync_jobs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ix_sync_jobs_failures` ON `sync_jobs` (`organization_id`,`finished_at`) WHERE status IN ('failed', 'dead_lettered');--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`target_file_id` text,
	`declared_filename` text NOT NULL,
	`display_name` text NOT NULL,
	`extension` text NOT NULL,
	`declared_size` integer NOT NULL,
	`declared_mime_type` text,
	`resolved_mime_type` text NOT NULL,
	`version_note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`chunk_size` integer DEFAULT 0 NOT NULL,
	`total_chunks` integer DEFAULT 0 NOT NULL,
	`received_chunks` text DEFAULT '[]' NOT NULL,
	`quarantine_key` text,
	`checksum_sha256` text,
	`result_file_id` text,
	`result_version_id` text,
	`failure_reason` text,
	`finalization_key` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_version_id`) REFERENCES `file_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_upload_sessions_user` ON `upload_sessions` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_upload_sessions_folder` ON `upload_sessions` (`folder_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_upload_sessions_org` ON `upload_sessions` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_upload_sessions_expiry` ON `upload_sessions` (`expires_at`);