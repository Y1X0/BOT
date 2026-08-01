/**
 * Test bootstrap: provide the minimum env so config/env.ts validates without
 * a real Telegram token or database. Runs before any test module is imported.
 */
process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? '123456789:TEST_TOKEN_FOR_VITEST_ONLY_00000';
process.env.OWNER_IDS = process.env.OWNER_IDS ?? '111,222';
process.env.DATABASE_PROVIDER = 'sqlite';
process.env.DATABASE_URL = 'file:./data/test.db';
process.env.DEFAULT_LANGUAGE = 'ar';
process.env.DEFAULT_TIMEZONE = 'Asia/Riyadh';
