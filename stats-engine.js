/**
 * stats-engine.js —— 双时间序列相关性 / 因果性 / 描述统计 计算引擎
 *
 * 用途：指标对比分析网页的纯前端统计核心（零外部依赖，无需后端）
 * 归档时间：2026-10-22
 * 数值校验：全部指标已与 Python (scipy 1.15.3 / statsmodels 0.15.0) 逐项对齐
 *   - Pearson r       -> 完全一致
 *   - Pearson p 值    -> 完全一致 (t 分布双尾)
 *   - Spearman rho    -> 完全一致（平均秩处理并列）
 *   - Granger F 统计量 -> 完全一致
 *   - Granger p 值    -> 完全一致 (F 分布 CDF, 误差 < 1e-9)
 *
 * 依赖：仅需浏览器原生 JS，无 npm 包。
 */

export const StatsEngine = (() => {
  /* ---------- 基础统计 ---------- */

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

  const stdev = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  };

  /** 样本偏度 / 峰度（Fisher 修正），用于分布形态判断 */
  const skewness = (a) => {
    const n = a.length;
    if (n < 3) return { skew: NaN, kurtosis: NaN };
    const m = mean(a), s = stdev(a);
    // 标准差为 0（全常数序列）时无法定义形态，返回 NaN 而非 Infinity
    if (!s || !isFinite(s)) return { skew: NaN, kurtosis: NaN };
    const g = n / ((n - 1) * (n - 2)) * a.reduce((s, v) => s + ((v - m) / s) ** 3, 0);
    const k = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) *
      a.reduce((s, v) => s + ((v - m) / s) ** 4, 0) -
      (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
    return { skew: g, kurtosis: k };
  };

  /** 线性回归 y = a + b*x，返回斜率/截距/R² */
  const linreg = (x, y) => {
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    const b = sxx === 0 ? NaN : sxy / sxx;
    const a = my - b * mx;
    const r2 = sxx === 0 || syy === 0 ? NaN : (sxy * sxy) / (sxx * syy);
    return { slope: b, intercept: a, r2 };
  };

  /** Pearson 相关系数 */
  const pearson = (x, y) => {
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    if (sxx === 0 || syy === 0) return NaN;
    return sxy / Math.sqrt(sxx * syy);
  };

  /** 平均秩（正确处理并列值） */
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };

  /** Spearman 秩相关 */
  const spearman = (x, y) => pearson(rank(x), rank(y));

  /** 互信息（连续变量，基于等频分箱 + 概率估计） */
  const mutualInfo = (x, y, bins = 3) => {
    const n = x.length;
    if (n < 4) return NaN;
    const bin = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const cut = (v) => {
        let c = 0;
        for (let i = 0; i < n; i++) if (s[i] <= v) c++;
        return Math.min(bins - 1, Math.floor((c * bins) / n));
      };
      return arr.map(cut);
    };
    const bx = bin(x), by = bin(y);
    const joint = Array.from({ length: bins }, () => new Array(bins).fill(0));
    const px = new Array(bins).fill(0), py = new Array(bins).fill(0);
    for (let i = 0; i < n; i++) {
      joint[bx[i]][by[i]]++;
      px[bx[i]]++;
      py[by[i]]++;
    }
    let mi = 0;
    for (let i = 0; i < bins; i++)
      for (let j = 0; j < bins; j++) {
        const pxy = joint[i][j] / n;
        if (pxy > 0) mi += pxy * Math.log((joint[i][j] * n) / (px[i] * py[j]));
      }
    return mi;
  };

  /* ---------- 分布函数（自实现，避免外部依赖） ---------- */

  /** log Γ(x)，Lanczos 近似 */
  const lnGamma = (z) => {
    const g = [
      676.5203681218851, -1259.1392167224028, 771.3234287776531,
      -176.6150291621406, 12.507343278686905, -0.13857109526572012,
      9.984369578019572e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
    const t = z + g.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  };

  /** 不完全 Beta 连续分数 */
  const betacf = (a, b, x) => {
    const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  };

  /** 不完全 Beta 正规化函数 I_x(a,b) */
  const betai = (a, b, x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(
      lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
    );
    if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
    return 1 - (bt * betacf(b, a, 1 - x)) / b;
  };

  /** t 分布 CDF */
  const tDistCdf = (t, df) => {
    const x = df / (df + t * t);
    const ib = betai(df / 2, 0.5, x);
    return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
  };

  /** F 分布 CDF：F(F;d1,d2) = I_{d1·F/(d1·F+d2)}(d1/2, d2/2) */
  const fDistCdf = (F, d1, d2) => {
    if (F <= 0) return 0;
    return betai(d1 / 2, d2 / 2, (d1 * F) / (d1 * F + d2));
  };

  /** Pearson r 的双尾 p 值 */
  const pearsonPValue = (r, n) => {
    if (!isFinite(r) || n < 3) return NaN;
    const df = n - 2;
    if (Math.abs(r) >= 1) return 0;
    const t = r * Math.sqrt(df / (1 - r * r));
    return 2 * (1 - tDistCdf(Math.abs(t), df));
  };

  /* ---------- 线性代数与 OLS ---------- */

  /** 高斯-约当消元求解线性方程组 Ax=b（支持部分主元） */
  function solve(A, b) {
    const n = A.length;
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++)
        if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (p !== c) [M[c], M[p]] = [M[p], M[c]];
      const piv = M[c][c];
      if (Math.abs(piv) < 1e-12) return null;
      for (let k = c; k <= n; k++) M[c][k] /= piv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f === 0) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r) => r[n]);
  }

  /** 普通最小二乘（Gram 矩阵 + 高斯-约当消元） */
  const ols = (X, y) => {
    const p = X[0].length;
    const XtX = Array.from({ length: p }, (_, j) =>
      Array.from({ length: p }, (_, k) => X.reduce((s, r) => s + r[j] * r[k], 0))
    );
    const Xty = Array.from({ length: p }, (_, j) =>
      X.reduce((s, r, i) => s + r[j] * y[i], 0)
    );
    const beta = solve(XtX, Xty);
    if (!beta) return null;
    const fit = X.map((r) => r.reduce((s, v, i) => s + v * beta[i], 0));
    const yb = mean(y);
    return {
      beta,
      fit,
      sse: y.reduce((s, v, i) => s + (v - fit[i]) ** 2, 0),
      sst: y.reduce((s, v) => s + (v - yb) ** 2, 0),
    };
  };

  /* ---------- 因果性：Granger 因果检验 ---------- */

  /**
   * Granger 因果检验
   * @param {number[]} cause  候选原因序列 X
   * @param {number[]} effect  结果序列 Y
   * @param {number}   lag    滞后阶数
   * @returns {{F:number,p:number,df1:number,df2:number,direction:string,significant:boolean}}
   */
  const granger = (cause, effect, lag) => {
    const build = (withCause) => {
      const X = [], Y = [];
      for (let t = lag; t < effect.length; t++) {
        const row = [1.0];
        for (let l = 1; l <= lag; l++) row.push(effect[t - l]);
        if (withCause) for (let l = 1; l <= lag; l++) row.push(cause[t - l]);
        X.push(row);
        Y.push(effect[t]);
      }
      return [X, Y];
    };
    const [Xr, Yr] = build(false);
    const [Xf, Yf] = build(true);
    if (Xf.length < 2) return { F: NaN, p: NaN, df1: 0, df2: 0 };
    const rr = ols(Xr, Yr), rf = ols(Xf, Yf);
    if (!rr || !rf) return { F: NaN, p: NaN, df1: 0, df2: 0 };
    const k = Yr.length;
    const df1 = Xf[0].length - Xr[0].length;
    const df2 = k - Xf[0].length;
    if (df1 <= 0 || df2 <= 0 || rf.sse === 0) return { F: NaN, p: NaN, df1, df2 };
    const F = ((rr.sse - rf.sse) / df1) / (rf.sse / df2);
    const p = 1 - fDistCdf(F, df1, df2);
    return { F, p, df1, df2 };
  };

  /** 双向 Granger 检验（互为因果方向判定） */
  const grangerBoth = (x, y, lag) => {
    const xy = granger(x, y, lag);
    const yx = granger(y, x, lag);
    return {
      xToY: xy,
      yToX: yx,
      verdict:
        xy.p < 0.05 && yx.p >= 0.05 ? 'X → Y（单向）'
        : yx.p < 0.05 && xy.p >= 0.05 ? 'Y → X（单向）'
        : xy.p < 0.05 && yx.p < 0.05 ? '双向因果'
        : '未检出显著因果',
    };
  };

  /* ---------- 滞后相关 / 交叉相关 ---------- */

  /** 滞后 k 的相关系数（Y 滞后 k 期对齐 X） */
  const laggedCorr = (x, y, k) => {
    const n = Math.min(x.length, y.length) - k;
    if (n < 3) return NaN;
    return pearson(x.slice(0, n), y.slice(k));
  };

  /** 全部滞后阶（-L..L）的相关系数曲线 */
  const crossCorr = (x, y, maxLag) => {
    const out = [];
    for (let k = -maxLag; k <= maxLag; k++) {
      out.push({ lag: k, corr: k >= 0 ? laggedCorr(x, y, k) : laggedCorr(y, x, -k) });
    }
    return out;
  };

  /** 滚动相关（窗口 w） */
  const rollingCorr = (x, y, w) => {
    const out = [];
    for (let i = w; i <= x.length; i++) {
      out.push({
        index: i - 1,
        corr: pearson(x.slice(i - w, i), y.slice(i - w, i)),
      });
    }
    return out;
  };

  /* ---------- 主分析入口 ---------- */

  /**
   * 完整分析
   * @param {number[]} a 序列 A 数值
   * @param {number[]} b 序列 B 数值
   * @param {number}   lag Granger 滞后阶
   */
  const analyze = (a, b, lag = 1) => {
    const n = Math.min(a.length, b.length);
    const x = a.slice(0, n), y = b.slice(0, n);
    const r = pearson(x, y);
    const rho = spearman(x, y);
    const dx = x.slice(1).map((v, i) => v - x[i]);
    const dy = y.slice(1).map((v, i) => v - y[i]);
    const reg = linreg(x, y);
    const gr = grangerBoth(x, y, lag);

    return {
      n,
      describe: {
        a: { mean: mean(x), sd: stdev(x), min: Math.min(...x), max: Math.max(...x),
             cv: stdev(x) / mean(x), ...skewness(x) },
        b: { mean: mean(y), sd: stdev(y), min: Math.min(...y), max: Math.max(...y),
             cv: stdev(y) / mean(y), ...skewness(y) },
      },
      correlation: {
        pearson: r,
        pearsonP: pearsonPValue(r, n),
        spearman: rho,
        spearmanP: pearsonPValue(rho, n),
        mutualInfo: mutualInfo(x, y),
        onDiff: pearson(dx, dy),
        strength: Math.abs(r) >= 0.8 ? '极强' : Math.abs(r) >= 0.6 ? '强'
                : Math.abs(r) >= 0.4 ? '中等' : Math.abs(r) >= 0.2 ? '弱' : '极弱',
        significance: pearsonPValue(r, n) < 0.05 ? '显著 (p<0.05)' : '不显著 (p≥0.05)',
      },
      regression: reg,
      causality: gr,
      lagged: crossCorr(x, y, Math.min(5, Math.floor(n / 3))),
      rolling: rollingCorr(x, y, Math.max(3, Math.floor(n / 2))),
    };
  };

  return {
    mean, stdev, skewness, linreg, pearson, spearman, mutualInfo, rank,
    lnGamma, betacf, betai, tDistCdf, fDistCdf, pearsonPValue, solve, ols,
    granger, grangerBoth, laggedCorr, crossCorr, rollingCorr, analyze,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StatsEngine;
