-- Migration: Remove isDryRun and add isRealAccount
-- Date: 2026-02-01
-- Description: Removes isDryRun column and adds isRealAccount column to strategy table

-- Add isRealAccount column (defaults to false for safety)
ALTER TABLE strategy ADD COLUMN IF NOT EXISTS "isRealAccount" boolean DEFAULT false NOT NULL;

-- Remove isDryRun column
ALTER TABLE strategy DROP COLUMN IF EXISTS "isDryRun";

-- Update any existing strategies to ensure they have proper values
-- All existing strategies will have isRealAccount = false by default (safe mode)
-- Users must explicitly enable real account mode after migration

-- Note: This migration does not automatically enable real account mode for any strategy
-- to prevent accidental real money trading. Users must manually enable it via the UI or API.
