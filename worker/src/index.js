/**
 * ライフスタジオ豊川 - Cloudflare Worker API
 * Cloudflare D1 (SQLite) から顧客・来店データを集計して返す
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300', // 5分キャッシュ
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/dashboard') {
        return await getDashboardData(env.DB);
      }
      if (path === '/api/customers') {
        const page = parseInt(url.searchParams.get('page') || '1');
        const q = url.searchParams.get('q') || '';
        const type = url.searchParams.get('type') || '';
        const repeater = url.searchParams.get('repeater') || '';
        return await getCustomers(env.DB, page, q, type, repeater);
      }
      if (path === '/api/visits') {
        const page = parseInt(url.searchParams.get('page') || '1');
        const year = url.searchParams.get('year') || '';
        const type = url.searchParams.get('type') || '';
        const status = url.searchParams.get('status') || '';
        return await getVisits(env.DB, page, year, type, status);
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  },
};

// ============================================================
// ダッシュボード集計データ
// ============================================================
async function getDashboardData(db) {
  const [
    kpi, byMonth, byDow, byHour, byType, byStatus,
    byPhotographer, visitDist, childAge, childGender,
    numChildren, birthMonth, byCity, byZip,
    repeatCustomers, typeTrend
  ] = await Promise.all([
    // KPI
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM customers) as total_customers,
        (SELECT COUNT(*) FROM visits) as total_visits,
        (SELECT COUNT(*) FROM customers WHERE is_repeater=1) as repeater_count,
        (SELECT COUNT(*) FROM visits WHERE status='確定') as confirmed_visits,
        (SELECT ROUND(AVG(total_visits),1) FROM customers) as avg_visits,
        (SELECT ROUND(AVG(num_children),1) FROM customers) as avg_children
    `).first(),

    // 月別来店数（確定のみ・直近24ヶ月）
    db.prepare(`
      SELECT visit_year||'-'||visit_month as ym, COUNT(*) as cnt
      FROM visits WHERE status='確定' AND visit_date >= date('now','-24 months')
      GROUP BY ym ORDER BY ym
    `).all(),

    // 曜日別
    db.prepare(`
      SELECT visit_dow, COUNT(*) as cnt FROM visits
      WHERE status='確定' AND visit_dow != ''
      GROUP BY visit_dow
    `).all(),

    // 時間帯別
    db.prepare(`
      SELECT SUBSTR(visit_time,1,2) as hour, COUNT(*) as cnt FROM visits
      WHERE status='確定' AND visit_time != ''
      GROUP BY hour ORDER BY hour
    `).all(),

    // 撮影種類（確定）
    db.prepare(`
      SELECT shoot_type, COUNT(*) as cnt FROM visits
      WHERE status='確定' AND shoot_type != ''
      GROUP BY shoot_type ORDER BY cnt DESC
    `).all(),

    // ステータス
    db.prepare(`
      SELECT status, COUNT(*) as cnt FROM visits
      WHERE status != '' GROUP BY status ORDER BY cnt DESC
    `).all(),

    // カメラマン Top20
    db.prepare(`
      SELECT photographer, COUNT(*) as cnt FROM visits
      WHERE status='確定' AND photographer != ''
      GROUP BY photographer ORDER BY cnt DESC LIMIT 20
    `).all(),

    // 来店回数分布
    db.prepare(`
      SELECT MIN(total_visits,10) as visits, COUNT(*) as cnt
      FROM customers GROUP BY MIN(total_visits,10) ORDER BY visits
    `).all(),

    // 子供年齢（0〜12歳）
    db.prepare(`
      SELECT age, COUNT(*) as cnt FROM (
        SELECT child1_age as age FROM customers WHERE child1_age IS NOT NULL AND child1_age >= 0 AND child1_age <= 12
        UNION ALL SELECT child2_age FROM customers WHERE child2_age IS NOT NULL AND child2_age >= 0 AND child2_age <= 12
        UNION ALL SELECT child3_age FROM customers WHERE child3_age IS NOT NULL AND child3_age >= 0 AND child3_age <= 12
      ) GROUP BY age ORDER BY age
    `).all(),

    // 子供の性別
    db.prepare(`
      SELECT gender, COUNT(*) as cnt FROM (
        SELECT child1_gender as gender FROM customers WHERE child1_gender IN ('男','女')
        UNION ALL SELECT child2_gender FROM customers WHERE child2_gender IN ('男','女')
        UNION ALL SELECT child3_gender FROM customers WHERE child3_gender IN ('男','女')
      ) GROUP BY gender
    `).all(),

    // 子供人数分布
    db.prepare(`
      SELECT num_children, COUNT(*) as cnt FROM customers
      GROUP BY num_children ORDER BY num_children
    `).all(),

    // 誕生月
    db.prepare(`
      SELECT CAST(SUBSTR(bday,6,2) AS INTEGER) as month, COUNT(*) as cnt FROM (
        SELECT child1_birthday as bday FROM customers WHERE child1_birthday != ''
        UNION ALL SELECT child2_birthday FROM customers WHERE child2_birthday != ''
        UNION ALL SELECT child3_birthday FROM customers WHERE child3_birthday != ''
      ) WHERE bday != '' AND SUBSTR(bday,6,2) BETWEEN '01' AND '12'
      GROUP BY month ORDER BY month
    `).all(),

    // 市区町村 Top20
    db.prepare(`
      SELECT city, COUNT(*) as cnt FROM customers
      WHERE city != '' GROUP BY city ORDER BY cnt DESC LIMIT 20
    `).all(),

    // 郵便番号 上3桁 Top20
    db.prepare(`
      SELECT SUBSTR(zip_code,1,3) as zip3, COUNT(*) as cnt FROM customers
      WHERE zip_code != '' GROUP BY zip3 ORDER BY cnt DESC LIMIT 20
    `).all(),

    // リピーター（3回以上）Top50
    db.prepare(`
      SELECT c.mother_name, c.total_visits, c.shoot_types,
             c.child1_name, c.child1_age, c.city
      FROM customers c WHERE c.total_visits >= 3
      ORDER BY c.total_visits DESC LIMIT 50
    `).all(),

    // 撮影種類×月トレンド（直近18ヶ月 Top5種類）
    db.prepare(`
      SELECT visit_year||'-'||visit_month as ym, shoot_type, COUNT(*) as cnt
      FROM visits WHERE status='確定'
        AND visit_date >= date('now','-18 months')
        AND shoot_type IN (
          SELECT shoot_type FROM visits WHERE status='確定'
          GROUP BY shoot_type ORDER BY COUNT(*) DESC LIMIT 5
        )
      GROUP BY ym, shoot_type ORDER BY ym
    `).all(),
  ]);

  const data = {
    kpi,
    by_month: Object.fromEntries(byMonth.results.map(r => [r.ym, r.cnt])),
    by_dow: Object.fromEntries(byDow.results.map(r => [r.visit_dow, r.cnt])),
    by_hour: Object.fromEntries(byHour.results.map(r => [r.hour, r.cnt])),
    by_type: byType.results,
    by_status: Object.fromEntries(byStatus.results.map(r => [r.status, r.cnt])),
    by_photographer: byPhotographer.results,
    visit_dist: Object.fromEntries(visitDist.results.map(r => [r.visits, r.cnt])),
    child_age: Object.fromEntries(childAge.results.map(r => [r.age, r.cnt])),
    child_gender: Object.fromEntries(childGender.results.map(r => [r.gender, r.cnt])),
    num_children: Object.fromEntries(numChildren.results.map(r => [r.num_children, r.cnt])),
    birth_month: Object.fromEntries(birthMonth.results.map(r => [r.month, r.cnt])),
    by_city: byCity.results,
    by_zip: byZip.results,
    repeat_customers: repeatCustomers.results,
    type_trend: typeTrend.results,
    generated: new Date().toISOString(),
  };

  return new Response(JSON.stringify(data), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ============================================================
// 顧客一覧（ページネーション・検索）
// ============================================================
async function getCustomers(db, page, q, type, repeater) {
  const limit = 50;
  const offset = (page - 1) * limit;
  let where = '1=1';
  const params = [];

  if (q) {
    where += ' AND (mother_name LIKE ? OR phone LIKE ? OR email LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (type) {
    where += ' AND shoot_types LIKE ?';
    params.push(`%${type}%`);
  }
  if (repeater === '1') { where += ' AND is_repeater=1'; }
  else if (repeater === '0') { where += ' AND is_repeater=0'; }

  const [rows, countRow] = await Promise.all([
    db.prepare(`SELECT * FROM customers WHERE ${where} ORDER BY e_seq DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) as total FROM customers WHERE ${where}`)
      .bind(...params).first(),
  ]);

  return new Response(JSON.stringify({
    customers: rows.results,
    total: countRow.total,
    page, limit,
  }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ============================================================
// 来店一覧（ページネーション・フィルター）
// ============================================================
async function getVisits(db, page, year, type, status) {
  const limit = 100;
  const offset = (page - 1) * limit;
  let where = '1=1';
  const params = [];

  if (year) { where += ' AND visit_year=?'; params.push(year); }
  if (type) { where += ' AND shoot_type=?'; params.push(type); }
  if (status) { where += ' AND status=?'; params.push(status); }

  const [rows, countRow] = await Promise.all([
    db.prepare(`SELECT * FROM visits WHERE ${where} ORDER BY visit_date DESC, visit_time DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) as total FROM visits WHERE ${where}`)
      .bind(...params).first(),
  ]);

  return new Response(JSON.stringify({
    visits: rows.results,
    total: countRow.total,
    page, limit,
  }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}
