-- AlterTable
ALTER TABLE "ShopSettings" ALTER COLUMN "enabledChannels" SET DEFAULT ARRAY['fb_marketplace', 'poshmark', 'vinted']::TEXT[];

