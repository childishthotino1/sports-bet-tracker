-- Removes the 🛒 tap-tracking tables from 2026-11-08 to 11-09 (add_promo_bot_link_taps.sql).
-- The buttons went back to the books' own links on 11-09, and the bot no longer
-- reads these tables. Run only after promo-bot v51 or later is deployed: older
-- versions still answer the old ?go= buttons from promo_bot_links.
drop table if exists promo_bot_link_taps;
drop table if exists promo_bot_links;
