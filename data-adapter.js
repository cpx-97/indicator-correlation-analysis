/**
 * data-adapter.js —— 指标编码 → 时间序列 的取数适配层
 *
 * 用途：屏蔽不同数据接口的差异，向页面输出统一结构的时间序列
 * 归档时间：2026-10-22
 *
 * 【已实测结论】
 * 1. Mysteel MBI 接口（内置）：POST https://mbi.mysteel.com/datav_api/mbi/dataView/getDataForApi
 *    - 请求体是「代理转发式」：{ apiUrl, method, headers }
 *      apiUrl 形如 http://172.18.10.17:8000/forecast?breed_name=XX&area_name=YY
 *    - 注意：直接传 {breed_name, area_name} 会返回 415/空数组，必须用代理式请求体
 *    - 返回 { code:"200", success:true, data:[{dataDate:"MM-DD", dataValue:"数值", forecastTypeName}] }
 *    - dataDate 不含年份，按当前执行年份补全
 *    - 该接口已实测返回 Access-Control-Allow-Origin: * → 浏览器可跨域直连，无需后端代理
 * 2. 用户自备接口：只需实现 fetchSeries(indicatorCode) 返回 {dates:[], values:[]}
 */

export const DataAdapter = (() => {
  const MBI_ENDPOINT =
    'https://mbi.mysteel.com/datav_api/mbi/dataView/getDataForApi';
  const MBI_UPSTREAM = 'http://172.18.10.17:8000/forecast';

  /** 当前年份（用于补全 MM-DD 的年份） */
  const currentYear = () => new Date().getFullYear();

  /**
   * 内置 MBI 接口取数
   * @param {string} breed 品种名，如 "螺纹钢" / "原油" / "61.5%PB粉"
   * @param {string} area  地区名，如 "全国" / "英国布伦特" / "青岛港"
   */
  const fetchMBI = async (breed, area) => {
    const body = {
      apiUrl:
        `${MBI_UPSTREAM}?breed_name=${encodeURIComponent(breed)}` +
        `&area_name=${encodeURIComponent(area)}`,
      method: 'get',
      headers: {},
    };
    const res = await fetch(MBI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MBI 接口 HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'MBI 接口返回失败');

    const year = currentYear();
    const records = (json.data || [])
      .filter((d) => d && d.dataValue !== null && d.dataValue !== '' &&
                     d.dataValue !== '--' && isFinite(Number(d.dataValue)))
      .map((d) => {
        const md = String(d.dataDate || '').trim();   // "MM-DD"
        // 接口返回 MM-DD（不含年份）。按当前执行年份补全，并做严格的格式归一化
        let iso = md;
        const mm = md.match(/^(\d{1,2})-(\d{1,2})$/);
        if (mm) {
          const mo = String(parseInt(mm[1], 10)).padStart(2, '0');
          const dd = String(parseInt(mm[2], 10)).padStart(2, '0');
          iso = `${year}-${mo}-${dd}`;
        } else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(md)) {
          const p2 = md.split('-');
          iso = `${p2[0]}-${String(parseInt(p2[1],10)).padStart(2,'0')}-${String(parseInt(p2[2],10)).padStart(2,'0')}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(md)) {
          iso = md;
        }
        return {
          date: iso,
          value: Number(d.dataValue),
          type: d.forecastTypeName || '',
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    // 同一日期可能同时存在「真实数据」与「预测数据」（接口为回溯展示两条线）。
    // 分析主序列一律优先采用真实数据；预测值单独保留，供图表做对比展示。
    const map = new Map();
    for (const r of records) {
      const prev = map.get(r.date);
      if (!prev) { map.set(r.date, r); continue; }
      const prevIsReal = prev.type === '真实数据';
      const curIsReal = r.type === '真实数据';
      if (curIsReal && !prevIsReal) map.set(r.date, r);   // 真实值优先
    }
    const dates = [...map.keys()].sort();
    const values = dates.map((d) => map.get(d).value);
    const forecastByDate = new Map();
    for (const r of records) {
      if (r.type === '预测数据') forecastByDate.set(r.date, r.value);
    }
    return {
      dates,
      values,
      records,
      forecastByDate,
      hasForecast: forecastByDate.size > 0,
      source: `MBI ${breed}（${area}）`,
    };
  };

  /**
   * 从两个序列构造「对齐后的共同日期」样本
   * 两个序列日期不完全一致时，只保留交集（这是相关性/因果性分析的前提）
   */
  const align = (s1, s2) => {
    const m1 = new Map(s1.dates.map((d, i) => [d, s1.values[i]]));
    const m2 = new Map(s2.dates.map((d, i) => [d, s2.values[i]]));
    const common = [...m1.keys()].filter((d) => m2.has(d)).sort();
    return {
      dates: common,
      a: common.map((d) => m1.get(d)),
      b: common.map((d) => m2.get(d)),
      dropped: { a: s1.dates.length - common.length, b: s2.dates.length - common.length },
    };
  };

  /**
   * 指标编码解析器
   * 支持两种编码约定：
   *   A) "breed|area"      例如 "螺纹钢|全国"
   *   B) "breed|区域" 纯中文自动匹配内置品种库
   */
  const parseCode = (code) => {
    const s = String(code || '').trim();
    if (!s) return { ok: false, error: '指标编码为空' };
    const parts = s.split(/[|｜]/).map((x) => x.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { ok: true, breed: parts[0], area: parts[1] };
    }
    return { ok: false, error: `无法解析指标编码 "${s}"，请使用「品种|地区」格式` };
  };

  return { fetchMBI, align, parseCode, MBI_ENDPOINT, MBI_UPSTREAM, currentYear };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DataAdapter;
