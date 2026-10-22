import { StatsEngine } from './stats-engine.js';
import { DataAdapter } from './data-adapter.js';

/* ---------------- 指标库（已实测有数据的品种|地区组合） ---------------- */
const INDICATORS = [
  { group: '黑色 · 螺纹钢', items: [
    ['螺纹钢','全国'],['螺纹钢','上海'],['螺纹钢','北京'],['螺纹钢','广州'],
    ['螺纹钢','杭州'],['螺纹钢','武汉'],['螺纹钢','成都'],['螺纹钢','西安'],
    ['螺纹钢','沈阳'],['螺纹钢','南昌'],
  ]},
  { group: '黑色 · 品种钢', items: [
    ['钢坯','全国'],['角钢','全国'],['槽钢','全国'],['中厚板','全国'],
  ]},
  { group: '黑色 · 铁矿石', items: [
    ['61.5%PB粉','青岛港'],['61.5%PB粉','日照港'],['62.5%PB块','青岛港'],['62.5%PB块','日照港'],
  ]},
  { group: '能源 · 原油 / 煤', items: [
    ['原油','英国布伦特'],['动力煤','秦皇岛'],
  ]},
  { group: '化工 · 能化', items: [
    ['PTA','华东'],['乙二醇','华东'],['硫磺','镇江港'],['硫磺','西南'],
  ]},
];

const PRESETS = [
  ['螺纹钢|全国','原油|英国布伦特','螺纹钢 vs 原油'],
  ['螺纹钢|全国','61.5%PB粉|青岛港','螺纹钢 vs PB粉'],
  ['61.5%PB粉|青岛港','62.5%PB块|青岛港','PB粉 vs PB块'],
  ['螺纹钢|全国','螺纹钢|上海','全国 vs 上海'],
  ['PTA|华东','乙二醇|华东','PTA vs 乙二醇'],
  ['硫磺|镇江港','硫磺|西南','硫磺 港口 vs 西南'],
];

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
const codeOf = (breed, area) => `${breed}|${area}`;

/* ---------------- 图表实例管理 ---------------- */
const charts = {};
function chart(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id));
  return charts[id];
}
window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));

const C = {
  brand: '#bc0008', brand2: '#023985', gray: '#8a919f', line: '#e5e6eb',
  teal: '#14b8a6', purple: '#8b5cf6', orange: '#f59e0b',
};

/* ---------------- 初始化下拉框 ---------------- */
function fillSelect(el, defaultVal) {
  INDICATORS.forEach(g => {
    const og = document.createElement('optgroup');
    og.label = g.group;
    g.items.forEach(([b, a]) => {
      const code = codeOf(b, a);
      const o = document.createElement('option');
      o.value = code; o.textContent = code;
      og.appendChild(o);
    });
    el.appendChild(og);
  });
  if (defaultVal) el.value = defaultVal;
}

function initUI() {
  fillSelect($('selA'), '螺纹钢|全国');
  fillSelect($('selB'), '原油|英国布伦特');

  const pw = $('presets');
  PRESETS.forEach(([a, b, label]) => {
    const c = document.createElement('button');
    c.className = 'chip'; c.textContent = label;
    c.onclick = () => { $('selA').value = a; $('selB').value = b; run(); };
    pw.appendChild(c);
  });

  $('btnRun').onclick = run;
  $('btnReset').onclick = () => {
    $('selA').value = '螺纹钢|全国'; $('selB').value = '原油|英国布伦特';
    $('selLag').value = '1';
    $('results').style.display = 'none';
    setStatus('', '');
  };
}

/* ---------------- 状态提示 ---------------- */
function setStatus(type, text) {
  const s = $('status');
  if (!type) { s.className = 'status'; s.style.display = 'none'; return; }
  s.className = `status show ${type}`;
  $('statusText').innerHTML = text;
  const sp = s.querySelector('.spinner');
  if (sp) sp.style.display = type === 'loading' ? '' : 'none';
}

/* ---------------- 主流程 ---------------- */
async function run() {
  const codeA = $('selA').value, codeB = $('selB').value;
  const lag = parseInt($('selLag').value, 10);

  if (codeA === codeB) {
    setStatus('err', '⚠️ 请选择两个<b>不同</b>的指标进行对比');
    return;
  }
  $('btnRun').disabled = true;
  setStatus('loading', `正在拉取数据：<b>${codeA}</b> 与 <b>${codeB}</b> …`);

  try {
    const [s1, s2] = await Promise.all([
      DataAdapter.fetchMBI(...codeA.split('|')),
      DataAdapter.fetchMBI(...codeB.split('|')),
    ]);

    if (!s1.values.length || !s2.values.length) {
      setStatus('err', `⚠️ 有指标未取到有效数据：${!s1.values.length ? codeA : codeB}`);
      $('btnRun').disabled = false;
      return;
    }

    const al = DataAdapter.align(s1, s2);
    if (al.dates.length < 6) {
      setStatus('err', `⚠️ 两条序列的共同日期仅 <b>${al.dates.length}</b> 期，不足以做统计推断（需 ≥6 期）`);
      $('btnRun').disabled = false;
      return;
    }

    const rep = StatsEngine.analyze(al.a, al.b, lag);
    renderVerdict(rep, codeA, codeB, s1, s2, al);
    renderCharts(rep, al, s1, s2, codeA, codeB);
    renderTables(rep, al, s1, s2, codeA, codeB, lag);

    $('results').style.display = '';
    setStatus('ok', `✅ 分析完成：共同样本 <b>${rep.n}</b> 期（${al.dates[0]} ~ ${al.dates[al.dates.length-1]}）`);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    setStatus('err', `❌ 分析失败：${e.message}`);
  } finally {
    $('btnRun').disabled = false;
  }
}

/* ---------------- 结论卡 ---------------- */
function renderVerdict(rep, codeA, codeB, s1, s2, al) {
  const c = rep.correlation, g = rep.causality;
  const dir = g.xToY.p < 0.05 ? 'A → B' : (g.yToX.p < 0.05 ? 'B → A' : '无显著方向');
  const hasCausality = g.xToY.p < 0.05 || g.yToX.p < 0.05;

  const sigClass = c.pearsonP < 0.05 ? 'good' : 'neutral';
  const causeText = hasCausality
    ? `检出显著因果：<b>${dir}</b>（${g.xToY.p < 0.05 ? `A→B p=${fmt(g.xToY.p,4)}` : `B→A p=${fmt(g.yToX.p,4)}`}）`
    : `未检出显著因果关系（双向 p 值均 &gt; 0.05）`;

  const peak = rep.lagged.reduce((m, d) => d.corr > m.corr ? d : m, rep.lagged[0]);
  const leadText = peak.lag > 0
    ? `A 领先 B 约 <b>${peak.lag}</b> 期时相关性最强（r=${fmt(peak.corr,3)}）`
    : (peak.lag < 0 ? `B 领先 A 约 <b>${-peak.lag}</b> 期时相关性最强（r=${fmt(peak.corr,3)}）`
                    : `两指标<b>同期</b>相关性最强（r=${fmt(peak.corr,3)}）`);

  const diffWarn = Math.abs(c.onDiff) < 0.3
    ? `两指标<b>一阶差分相关性仅 ${fmt(c.onDiff,3)}</b>，说明其联动主要来自<b>共同趋势</b>而非价差/增速的实时传导`
    : `一阶差分相关性 <b>${fmt(c.onDiff,3)}</b>，存在较明显的<b>短期传导</b>特征`;

  $('verdict').innerHTML = `
    <h2><span class="ic">📊</span>分析结论：${codeA} × ${codeB}</h2>
    <div class="vgrid">
      <div class="vitem"><div class="k">Pearson 相关系数 r</div>
        <div class="v ${sigClass}">${fmt(c.pearson, 4)}</div>
        <div class="d">${c.strength}相关 · ${c.significance}</div></div>
      <div class="vitem"><div class="k">Spearman 秩相关 ρ</div>
        <div class="v neutral">${fmt(c.spearman, 4)}</div>
        <div class="d">对非线性单调关系更稳健</div></div>
      <div class="vitem"><div class="k">Granger 因果判定</div>
        <div class="v ${hasCausality ? 'good' : 'neutral'}">${hasCausality ? dir : '无显著因果'}</div>
        <div class="d">${causeText.replace(/<b>|<\/b>/g, '')}</div></div>
      <div class="vitem"><div class="k">回归拟合优度 R²</div>
        <div class="v neutral">${fmt(rep.regression.r2, 4)}</div>
        <div class="d">斜率 ${fmt(rep.regression.slope, 4)}，每单位 X 变动 Y 变动 ${fmt(rep.regression.slope, 4)}</div></div>
    </div>
    <div class="vtext">
      <b>① 相关性：</b>两指标 Pearson r = <b>${fmt(c.pearson,4)}</b>（p = ${fmt(c.pearsonP,4)}，${c.significance}），
      Spearman ρ = <b>${fmt(c.spearman,4)}</b>，互信息 MI = ${fmt(c.mutualInfo,4)}。整体属于<b>${c.strength}</b>相关水平。<br>
      <b>② 因果性：</b>${causeText}。<br>
      <b>③ 领先滞后：</b>${leadText}。<br>
      <b>④ 传导性质：</b>${diffWarn}。<br>
      <b>⑤ 样本说明：</b>共同样本 <b>${rep.n}</b> 期，Granger 检验自由度 ${g.xToY.df2}，
      样本量偏小导致检验功效有限，结论请结合业务背景判断。
    </div>`;
}

/* ---------------- 图表 ---------------- */
function renderCharts(rep, al, s1, s2, codeA, codeB) {
  const dates = al.dates.map(d => d.length === 5 ? d : d);
  const a = al.a, b = al.b;
  const realCount = s1.records.filter(r => r.type === '真实数据').length;
  const splitIdx = Math.max(0, realCount - (s1.dates.length - al.dates.length));

  /* 图1：双序列走势（实线=真实数据主序列，虚线=模型预测序列） */
  const mk = (data, name, color, extra = {}) => ({
    name, type: 'line', data, smooth: true, symbol: 'circle', symbolSize: 6,
    lineStyle: { width: 2.2, color, ...(extra.lineStyle || {}) },
    itemStyle: { color },
    ...(extra.rest || {}),
  });
  // 预测序列：只在该日期存在预测值时才有值，否则用 null 断开
  const fcast = (s) => al.dates.map(d => (s.forecastByDate.has(d) ? s.forecastByDate.get(d) : null));
  chart('chart1').setOption({
    color: [C.brand, C.brand2],
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    legend: { top: 0, data: [codeA, codeB, `${codeA} · 模型预测`, `${codeB} · 模型预测`],
      textStyle: { fontSize: 11 } },
    grid: { left: 58, right: 58, top: 46, bottom: 34 },
    xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 11 } },
    yAxis: [
      { type: 'value', name: codeA, scale: true, nameTextStyle: { fontSize: 11, color: C.brand },
        splitLine: { lineStyle: { color: C.line } }, axisLabel: { fontSize: 11 } },
      { type: 'value', name: codeB, scale: true, nameTextStyle: { fontSize: 11, color: C.brand2 },
        splitLine: { show: false }, axisLabel: { fontSize: 11 } },
    ],
    series: [
      { ...mk(a, codeA, C.brand), yAxisIndex: 0 },
      { ...mk(b, codeB, C.brand2), yAxisIndex: 1 },
      { ...mk(fcast(s1), `${codeA} · 模型预测`, C.brand, {
          lineStyle: { width: 1.6, type: 'dashed', opacity: .7 }, rest: { symbolSize: 4 } }),
        yAxisIndex: 0 },
      { ...mk(fcast(s2), `${codeB} · 模型预测`, C.brand2, {
          lineStyle: { width: 1.6, type: 'dashed', opacity: .7 }, rest: { symbolSize: 4 } }),
        yAxisIndex: 1 },
    ],
  });

  /* 图2：散点 + 回归线 */
  const pts = a.map((v, i) => [v, b[i]]);
  const xs = a, ys = b;
  const xm = xs.reduce((s, v) => s + v, 0) / xs.length;
  const ym = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - xm) * (ys[i] - ym); sxx += (xs[i] - xm) ** 2; }
  const slope = sxx ? sxy / sxx : 0, icpt = ym - slope * xm;
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  chart('chart2').setOption({
    tooltip: { trigger: 'item', formatter: p => p.seriesType === 'scatter'
      ? `${codeA}: ${fmt(p.value[0])}<br>${codeB}: ${fmt(p.value[1])}` : '' },
    grid: { left: 58, right: 24, top: 34, bottom: 40 },
    xAxis: { type: 'value', name: codeA, scale: true, nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { color: C.line } } },
    yAxis: { type: 'value', name: codeB, scale: true, nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { color: C.line } } },
    series: [
      { type: 'scatter', data: pts, symbolSize: 11,
        itemStyle: { color: C.brand, opacity: .78, borderColor: '#fff', borderWidth: 1 },
        name: '样本点' },
      { type: 'line', data: [[xMin, icpt + slope * xMin], [xMax, icpt + slope * xMax]],
        showSymbol: false, lineStyle: { color: C.brand2, width: 2, type: 'dashed' },
        name: '回归拟合' },
    ],
  });

  /* 图3：滞后相关 */
  chart('chart3').setOption({
    tooltip: { trigger: 'axis', formatter: p => `滞后 ${p[0].value} 期<br>相关系数 r = ${fmt(p[0].value, 4)}` },
    grid: { left: 58, right: 24, top: 30, bottom: 46 },
    xAxis: { type: 'category', name: '滞后阶数（>0 表示 A 领先 B）',
      nameLocation: 'middle', nameGap: 30, nameTextStyle: { fontSize: 11 },
      data: rep.lagged.map(d => d.lag), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', name: 'Pearson r', nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { color: C.line } } },
    series: [{
      type: 'bar', data: rep.lagged.map(d => ({
        value: +d.corr.toFixed(4),
        itemStyle: { color: d.lag === 0 ? C.brand : (d.corr >= 0 ? C.brand2 : C.teal) },
      })),
      label: { show: true, position: 'top', fontSize: 10, formatter: p => fmt(p.value, 3) },
    }],
  });

  /* 图4：滚动相关 */
  chart('chart4').setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 58, right: 24, top: 30, bottom: 40 },
    xAxis: { type: 'category', data: rep.rolling.map(d => d.date), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', name: '滚动 r', min: -1, max: 1, nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { color: C.line } } },
    series: [{
      type: 'line', data: rep.rolling.map(d => +d.corr.toFixed(4)), smooth: true,
      symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.2, color: C.purple },
      itemStyle: { color: C.purple },
      markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }],
        lineStyle: { color: C.gray, type: 'dashed' }, label: { show: false } },
    }],
  });

  /* 图5：Granger 因果 */
  const gc = [
    { name: 'A → B', value: rep.causality.xToY.p, F: rep.causality.xToY.F },
    { name: 'B → A', value: rep.causality.yToX.p, F: rep.causality.yToX.F },
  ];
  chart('chart5').setOption({
    tooltip: { trigger: 'item', formatter: p => `${p.name}<br>F = ${fmt(p.data.F, 4)}<br>p = ${fmt(p.data.value, 4)}` },
    grid: { left: 58, right: 24, top: 30, bottom: 40 },
    xAxis: { type: 'category', data: gc.map(d => d.name), axisLabel: { fontSize: 12 } },
    yAxis: { type: 'value', name: 'p 值', max: 1, nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { color: C.line } } },
    series: [{
      type: 'bar', barWidth: '42%',
      data: gc.map(d => ({
        value: +d.value.toFixed(4),
        itemStyle: { color: d.value < 0.05 ? C.brand : C.gray },
      })),
      label: { show: true, position: 'top', fontSize: 11, formatter: p => `p=${fmt(p.value,4)}` },
      markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0.05 }],
        lineStyle: { color: C.orange, type: 'dashed' }, label: { formatter: '显著水平 0.05', fontSize: 10 } },
    }],
  });

  /* 图6：描述统计 */
  const dA = rep.describe.a, dB = rep.describe.b;
  const metrics = [
    { k: '均值', a: dA.mean, b: dB.mean },
    { k: '标准差', a: dA.sd, b: dB.sd },
    { k: '最小值', a: dA.min, b: dB.min },
    { k: '最大值', a: dA.max, b: dB.max },
  ];
  chart('chart6').setOption({
    tooltip: { trigger: 'axis' },
    legend: { top: 0, data: [codeA, codeB] },
    grid: { left: 58, right: 24, top: 40, bottom: 40 },
    xAxis: { type: 'category', data: metrics.map(m => m.k), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', type: 'log', name: '数值（对数轴）', nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { color: C.line } } },
    series: [
      { name: codeA, type: 'bar', data: metrics.map(m => +m.a.toFixed(4)), itemStyle: { color: C.brand }, barWidth: '32%' },
      { name: codeB, type: 'bar', data: metrics.map(m => +m.b.toFixed(4)), itemStyle: { color: C.brand2 }, barWidth: '32%' },
    ],
  });
}

/* ---------------- 表格 ---------------- */
function renderTables(rep, al, s1, s2, codeA, codeB, lag) {
  const t1 = s1.records.reduce((m, r) => (m[r.date] = r, m), {});
  const t2 = s2.records.reduce((m, r) => (m[r.date] = r, m), {});
  const c = rep.correlation, g = rep.causality;

  const rows = al.dates.map((d, i) => {
    const ra = t1[d], rb = t2[d];
    const tag = (r) => r && r.type === '预测数据'
      ? '<span class="nsig" style="font-size:11px">预测</span>' : '<span class="nsig" style="font-size:11px">真实</span>';
    return `<tr>
      <td>${d}</td>
      <td class="num">${fmt(al.a[i])} ${tag(ra)}</td>
      <td class="num">${fmt(al.b[i])} ${tag(rb)}</td>
      <td class="num">${fmt(al.a[i] - al.b[i])}</td>
    </tr>`;
  }).join('');

  $('tblDetail').innerHTML = `
    <thead><tr><th>日期</th><th style="text-align:right">${codeA}</th>
      <th style="text-align:right">${codeB}</th><th style="text-align:right">差值(A−B)</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr style="background:#fafbfc;font-weight:600">
      <td>统计量</td>
      <td class="num">均值 ${fmt(rep.describe.a.mean)}<br>标准差 ${fmt(rep.describe.a.sd)}<br>变异系数 ${fmt(rep.describe.a.cv,4)}</td>
      <td class="num">均值 ${fmt(rep.describe.b.mean)}<br>标准差 ${fmt(rep.describe.b.sd)}<br>变异系数 ${fmt(rep.describe.b.cv,4)}</td>
      <td class="num">R² ${fmt(rep.regression.r2,4)}<br>r ${fmt(c.pearson,4)}<br>ρ ${fmt(c.spearman,4)}</td>
    </tr></tfoot>`;

  const gRow = (name, d) => `<tr>
    <td>${name}</td><td class="num">${fmt(d.F, 4)}</td><td class="num">${d.df1}</td><td class="num">${d.df2}</td>
    <td class="num ${d.p < 0.05 ? 'sig' : 'nsig'}">${fmt(d.p, 4)}</td>
    <td>${d.p < 0.05 ? '<span class="sig">显著（拒绝原假设）</span>' : '<span class="nsig">不显著</span>'}</td>
  </tr>`;
  $('tblGranger').innerHTML = `
    <thead><tr><th>方向</th><th style="text-align:right">F 统计量</th><th style="text-align:right">分子自由度</th>
      <th style="text-align:right">分母自由度</th><th style="text-align:right">p 值</th><th>结论</th></tr></thead>
    <tbody>${gRow(`${codeA} → ${codeB}`, g.xToY)}${gRow(`${codeB} → ${codeA}`, g.yToX)}</tbody>
    <tfoot><tr style="background:#fafbfc">
      <td colspan="6" style="font-size:12px;color:#5a6270">
        滞后阶数 ${lag}；p &lt; 0.05 判定为在 5% 显著性水平下存在 Granger 因果关系。
        样本 ${rep.n} 期，自由度 ${g.xToY.df2}，样本偏小，检验功效有限。
      </td></tr></tfoot>`;
}

/* ---------------- 启动 ---------------- */
initUI();
window.__run = run;   // 供自动化测试调用
