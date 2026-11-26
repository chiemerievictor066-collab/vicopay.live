// VicoPay Admin: Creator Performance & Marketplace Operations.
// Read-only. Every number comes from your own PostgreSQL tables; nothing is simulated.
// Protected by the existing ADMIN_KEY (requireAdmin).
module.exports = function registerCreatorMarketAdmin({ app, db, requireAdmin }) {
  const safe = async (sql, params = []) => { try { return await db.all(sql, params); } catch (e) { console.error('[admin-creator-market]', e.message); return []; } };
  const one = async (sql, params = []) => (await safe(sql, params))[0] || {};
  const n = v => Number(v || 0);

  // ---------- Creator performance ----------
  app.get('/api/admin/creator-performance', requireAdmin, async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const sinceMs = Date.now() - days * 86400000;
    const sinceIso = new Date(sinceMs).toISOString();

    const [creators, live, gifts, pending, totals] = await Promise.all([
      safe(`SELECT h.host_id AS email, u.username, u.display_name AS "displayName",
                   h.gifts::bigint AS "giftsAll", h.gift_coins::bigint AS "coinsAll", h.loves::bigint AS loves,
                   h.viewers::bigint AS "viewersAll", h.withdrawn_stars::bigint AS "withdrawnStars"
            FROM host_stats h LEFT JOIN users u ON u.email = h.host_id
            ORDER BY h.gift_coins DESC LIMIT 100`),
      safe(`SELECT host_id AS email, COUNT(*)::int AS sessions,
                   COALESCE(SUM(GREATEST(COALESCE(ended_at, last_beat, started_at) - started_at, 0)),0)::bigint AS ms,
                   MAX(started_at)::bigint AS "lastLive"
            FROM live_sessions WHERE started_at > ? GROUP BY host_id`, [sinceMs]),
      safe(`SELECT host_id AS email, COUNT(*)::int AS gifts, COALESCE(SUM(coin),0)::bigint AS coins
            FROM gift_transactions WHERE created_at > ? GROUP BY host_id`, [sinceIso]),
      safe(`SELECT creator_id AS email, COUNT(*)::int AS requests, COALESCE(SUM(amount),0)::float AS amount
            FROM withdrawal_requests WHERE lower(COALESCE(status,'')) IN ('pending','processing','requested') GROUP BY creator_id`),
      one(`SELECT (SELECT COUNT(*) FROM host_stats)::int AS creators,
                  (SELECT COUNT(*) FROM live_sessions WHERE ended_at IS NULL AND COALESCE(last_beat, started_at) > ?)::int AS "liveNow"`, [Date.now() - 180000])
    ]);
    const L = Object.fromEntries(live.map(r => [r.email, r]));
    const G = Object.fromEntries(gifts.map(r => [r.email, r]));
    const P = Object.fromEntries(pending.map(r => [r.email, r]));
    const rows = creators.map(c => ({
      email: c.email, username: c.username || '', displayName: c.displayName || '',
      giftsAll: n(c.giftsAll), coinsAll: n(c.coinsAll), loves: n(c.loves), viewersAll: n(c.viewersAll), withdrawnStars: n(c.withdrawnStars),
      sessions: n(L[c.email]?.sessions), liveHours: +(n(L[c.email]?.ms) / 3600000).toFixed(2), lastLive: n(L[c.email]?.lastLive) || null,
      giftsPeriod: n(G[c.email]?.gifts), coinsPeriod: n(G[c.email]?.coins),
      pendingRequests: n(P[c.email]?.requests), pendingAmount: n(P[c.email]?.amount)
    }));
    res.json({
      success: true, generatedAt: Date.now(), days,
      totals: {
        creators: n(totals.creators), liveNow: n(totals.liveNow),
        coinsPeriod: rows.reduce((a, r) => a + r.coinsPeriod, 0), giftsPeriod: rows.reduce((a, r) => a + r.giftsPeriod, 0),
        sessionsPeriod: rows.reduce((a, r) => a + r.sessions, 0), liveHoursPeriod: +rows.reduce((a, r) => a + r.liveHours, 0).toFixed(2),
        pendingWithdrawalAmount: rows.reduce((a, r) => a + r.pendingAmount, 0)
      },
      rows
    });
  });

  // ---------- Marketplace & seller operations ----------
  app.get('/api/admin/marketplace-ops', requireAdmin, async (req, res) => {
    const since24 = Date.now() - 86400000;
    const [orderStatus, listingStatus, sellers, latestOrders, disputes, reports, wallet, sellerW, today] = await Promise.all([
      safe(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_ngn),0)::bigint AS ngn FROM market_orders GROUP BY status`),
      safe(`SELECT status, COUNT(*)::int AS count FROM market_listings GROUP BY status`),
      safe(`SELECT o.seller AS email, u.username, u.display_name AS "displayName",
                   COUNT(*)::int AS orders,
                   COUNT(*) FILTER (WHERE o.status='completed')::int AS completed,
                   COUNT(*) FILTER (WHERE o.status='disputed')::int AS disputed,
                   COALESCE(SUM(o.amount_ngn) FILTER (WHERE o.status='completed'),0)::bigint AS "salesNgn",
                   (SELECT COUNT(*) FROM market_listings l WHERE l.seller=o.seller AND l.status='active')::int AS "activeListings"
            FROM market_orders o LEFT JOIN users u ON u.email=o.seller
            GROUP BY o.seller, u.username, u.display_name ORDER BY "salesNgn" DESC LIMIT 50`),
      safe(`SELECT id, title, seller, buyer, amount_ngn AS "amountNgn", status, created_at AS "createdAt" FROM market_orders ORDER BY id DESC LIMIT 25`),
      safe(`SELECT id, title, seller, buyer, amount_ngn AS "amountNgn", dispute_reason AS reason, created_at AS "createdAt" FROM market_orders WHERE status='disputed' ORDER BY id DESC LIMIT 25`),
      safe(`SELECT r.id, r.listing_id AS "listingId", l.title, l.seller, r.reason, r.created_at AS "createdAt"
            FROM market_reports r LEFT JOIN market_listings l ON l.id=r.listing_id ORDER BY r.id DESC LIMIT 25`),
      safe(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(net),0)::bigint AS net, COALESCE(SUM(commission),0)::bigint AS commission FROM seller_wallet_entries GROUP BY status`),
      safe(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::bigint AS amount FROM seller_withdrawals GROUP BY status`),
      one(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(amount_ngn) FILTER (WHERE status IN ('paid','shipped','completed')),0)::bigint AS ngn FROM market_orders WHERE created_at > ?`, [since24])
    ]);
    res.json({ success: true, generatedAt: Date.now(), orderStatus, listingStatus, sellers, latestOrders, disputes, reports, wallet, sellerWithdrawals: sellerW, last24h: { orders: n(today.orders), ngn: n(today.ngn) } });
  });
};
