// Vico Pay Live — admin analytics API. Reads real PostgreSQL records only.
// Uses the project's db wrapper and existing x-admin-key protection.
module.exports = function registerAnalytics({ app, db, requireAdmin }) {
  app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
    const since = Date.now() - days * 86400000;
    const errors = [];
    const safe = async (label, sql, params = []) => {
      try { return await db.get(sql, params) || {}; }
      catch (e) { errors.push(label + ': ' + e.message); return {}; }
    };
    const safeAll = async (label, sql, params = []) => {
      try { return await db.all(sql, params); }
      catch (e) { errors.push(label + ': ' + e.message); return []; }
    };
    try {
      const [usersTotal, orders, listings, ads, adPaid, video, live, gifts, support, videoTotals, topProducts, revenueDaily, ordersDaily] = await Promise.all([
        safe('users', 'SELECT COUNT(*)::bigint AS n FROM users'),
        safe('orders', `SELECT COUNT(*) FILTER (WHERE status IN ('paid','shipped','completed'))::bigint AS paid,
          COALESCE(SUM(amount_ngn) FILTER (WHERE status IN ('paid','shipped','completed')),0)::numeric AS revenue
          FROM market_orders WHERE COALESCE(paid_at, created_at) >= ?`, [since]),
        safe('listings', `SELECT COUNT(*)::bigint AS n FROM market_listings WHERE status = 'active'`),
        safe('ads', `SELECT COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE lower(ad_type) LIKE '%company%' OR lower(ad_type) LIKE '%business%')::bigint AS company,
          COUNT(*) FILTER (WHERE lower(ad_type) LIKE '%national%')::bigint AS national
          FROM ad_campaigns`),
        safe('ad payments', `SELECT COALESCE(SUM(amount_paid),0)::numeric AS amount FROM ad_flow WHERE paid = 1 AND COALESCE(paid_at,0) >= ?`, [since]),
        safe('video views', `SELECT COALESCE(SUM(views),0)::bigint AS views FROM videos WHERE created_at >= ?`, [since]),
        safe('live sessions', `SELECT COALESCE(SUM(GREATEST(0, LEAST(COALESCE(ended_at,last_beat,started_at), ?) - GREATEST(started_at, ?))),0)::numeric / 3600000 AS hours
          FROM live_sessions WHERE started_at < ? AND COALESCE(ended_at,last_beat,started_at) > ?`, [Date.now(), since, Date.now(), since]),
        safe('gifts', `SELECT COUNT(*)::bigint AS n, COALESCE(SUM(coin),0)::numeric AS coins FROM gift_transactions WHERE
          CASE WHEN created_at ~ '^[0-9]+$' THEN created_at::bigint ELSE (EXTRACT(EPOCH FROM created_at::timestamptz)*1000)::bigint END >= ?`, [since]),
        safe('support', `SELECT COUNT(*) FILTER (WHERE lower(status) NOT IN ('resolved','closed'))::bigint AS open,
          COUNT(*) FILTER (WHERE lower(status) IN ('resolved','closed'))::bigint AS resolved FROM support_tickets`),
        safe('video totals', `SELECT COUNT(*) FILTER (WHERE status IN ('ready','active'))::bigint AS total,
          COALESCE(SUM(shares),0)::bigint AS shares FROM videos WHERE created_at >= ?`, [since]),
        safeAll('top products', `SELECT l.title, COUNT(o.id)::bigint AS orders, COALESCE(SUM(o.amount_ngn),0)::numeric AS revenue
          FROM market_orders o JOIN market_listings l ON l.id=o.listing_id
          WHERE o.status IN ('paid','shipped','completed') AND COALESCE(o.paid_at,o.created_at) >= ?
          GROUP BY l.id,l.title ORDER BY revenue DESC LIMIT 8`, [since]),
        safeAll('daily revenue', `SELECT to_char(to_timestamp(COALESCE(paid_at,created_at)/1000.0),'YYYY-MM-DD') AS day,
          COALESCE(SUM(amount_ngn),0)::numeric AS value FROM market_orders
          WHERE status IN ('paid','shipped','completed') AND COALESCE(paid_at,created_at) >= ?
          GROUP BY 1 ORDER BY 1`, [since]),
        safeAll('daily orders', `SELECT to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD') AS day, COUNT(*)::bigint AS value
          FROM market_orders WHERE created_at >= ? GROUP BY 1 ORDER BY 1`, [since])
      ]);
      const n = (v) => Number(v || 0);
      const revenueMap = new Map(revenueDaily.map(x => [x.day, n(x.value)]));
      const ordersMap = new Map(ordersDaily.map(x => [x.day, n(x.value)]));
      const labels = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        labels.push(d.toISOString().slice(0,10));
      }
      res.json({ success: true, generatedAt: new Date().toISOString(), periodDays: days,
        metrics: {
          usersTotal: n(usersTotal.n), ordersPaid: n(orders.paid), orderRevenueNgn: n(orders.revenue),
          listingsActive: n(listings.n), adCampaigns: n(ads.total), companyAds: n(ads.company), nationalAds: n(ads.national),
          paidAdPaymentsNgn: n(adPaid.amount), videoViews: n(video.views), liveHours: Math.round(n(live.hours)*100)/100,
          giftsCount: n(gifts.n), giftCoins: n(gifts.coins), supportOpen: n(support.open), supportResolved: n(support.resolved),
          videosTotal: n(videoTotals.total), videoShares: n(videoTotals.shares)
        },
        charts: { revenue: labels.map(day => ({ day, amount: revenueMap.get(day) || 0 })),
          orders: labels.map(day => ({ day, count: ordersMap.get(day) || 0 })),
          topProducts: topProducts.map(x => ({ title: x.title, orders: n(x.orders), revenue: n(x.revenue) })) },
        dataWarnings: errors
      });
    } catch (e) {
      console.error('ADMIN ANALYTICS ERROR:', e);
      res.status(500).json({ success: false, message: 'Unable to read analytics from PostgreSQL.' });
    }
  });
};
