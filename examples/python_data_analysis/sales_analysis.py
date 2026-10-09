"""
Python 数据分析完整示例：电商销售数据分析
================================================

这个脚本演示了一次真实数据分析任务的完整流程：

    1. 构造 / 载入数据        -> pandas DataFrame
    2. 数据质量检查 (EDA)      -> 缺失值、重复值、异常值
    3. 数据清洗与特征工程      -> 类型转换、派生列
    4. 多维度聚合分析          -> groupby / pivot_table
    5. 时间序列趋势分析        -> 按月重采样、环比增长
    6. 相关性分析              -> corr
    7. 输出结论与报表          -> CSV + Markdown 报告

运行方式:
    python sales_analysis.py

输出文件（与本脚本同目录）:
    - sales_raw.csv       原始（含脏数据）数据集
    - sales_clean.csv     清洗后的数据集
    - monthly_report.csv  月度汇总
    - report.md           分析报告
"""

from __future__ import annotations

import sys
from pathlib import Path

# Windows 控制台默认是 GBK，直接 print 中文/符号可能报 UnicodeEncodeError。
# 这里把标准输出切换成 UTF-8，并忽略无法编码的字符（仅影响本脚本进程）。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# 0. 全局配置
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
RANDOM_SEED = 42  # 固定随机种子，保证结果可复现

# 让 pandas 打印时对齐中文、显示更多列
pd.set_option("display.unicode.east_asian_width", True)
pd.set_option("display.width", 120)
pd.set_option("display.max_columns", 20)


# ---------------------------------------------------------------------------
# 1. 构造数据集
#    真实项目中这里通常是:  pd.read_csv("sales.csv")
#    为了示例可独立运行，我们用 numpy 随机生成一份带“脏数据”的销售明细。
# ---------------------------------------------------------------------------
def make_dataset(n_rows: int = 1200, seed: int = RANDOM_SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)

    regions = ["华东", "华北", "华南", "西南", "东北"]
    categories = ["手机数码", "家用电器", "服饰鞋包", "食品生鲜", "图书文娱"]
    channels = ["App", "小程序", "网页", "线下门店"]

    # 日期：2024 全年，让销量带一点“下半年走高”的季节性趋势
    dates = pd.to_datetime("2024-01-01") + pd.to_timedelta(
        rng.integers(0, 366, n_rows), unit="D"
    )
    month_factor = 1 + (dates.month.to_numpy() - 1) * 0.05  # 12月比1月高约 55%

    # 单价：按品类给出不同价位区间
    base_price = {"手机数码": 3200, "家用电器": 1800, "服饰鞋包": 260,
                  "食品生鲜": 60, "图书文娱": 45}

    df = pd.DataFrame(
        {
            "订单日期": dates,
            "区域": rng.choice(regions, n_rows, p=[0.30, 0.22, 0.24, 0.14, 0.10]),
            "品类": rng.choice(categories, n_rows, p=[0.22, 0.18, 0.25, 0.20, 0.15]),
            "渠道": rng.choice(channels, n_rows, p=[0.40, 0.25, 0.20, 0.15]),
            "数量": rng.integers(1, 6, n_rows),
        }
    )

    df["单价"] = [
        round(base_price[c] * rng.uniform(0.75, 1.25), 2) for c in df["品类"]
    ]
    df["销售额"] = (df["单价"] * df["数量"] * month_factor).round(2)

    # ---- 人为注入“脏数据”，用于演示清洗步骤 ----
    df.loc[rng.choice(n_rows, 25, replace=False), "区域"] = np.nan      # 缺失值
    df.loc[rng.choice(n_rows, 8, replace=False), "单价"] = np.nan       # 缺失值
    df.loc[rng.choice(n_rows, 5, replace=False), "销售额"] = -99.0      # 异常负值
    df = pd.concat([df, df.sample(6, random_state=seed)], ignore_index=True)  # 重复行
    return df


# ---------------------------------------------------------------------------
# 2. 数据质量检查（EDA 第一步）
# ---------------------------------------------------------------------------
def inspect(df: pd.DataFrame) -> None:
    print("=" * 78)
    print("【1】数据概览")
    print("=" * 78)
    print(f"行数: {len(df)}    列数: {df.shape[1]}")
    df.info()

    print("\n各列缺失值数量 / 占比:")
    missing = pd.DataFrame(
        {"缺失数": df.isna().sum(), "缺失率": (df.isna().mean() * 100).round(2)}
    )
    print(missing[missing["缺失数"] > 0])

    print(f"\n完全重复的行数: {df.duplicated().sum()}")
    print("\n数值列描述性统计:")
    print(df.describe().round(2))


# ---------------------------------------------------------------------------
# 3. 数据清洗 + 特征工程
# ---------------------------------------------------------------------------
def clean(df: pd.DataFrame) -> pd.DataFrame:
    before = len(df)
    out = df.copy()

    # 3.1 删除完全重复的行
    out = out.drop_duplicates()
    dup_removed = before - len(out)

    # 3.2 处理异常值：销售额出现负值，说明录入错误 -> 用“单价 × 数量”重算
    bad = out["销售额"] <= 0
    out.loc[bad, "销售额"] = (out.loc[bad, "单价"] * out.loc[bad, "数量"]).round(2)

    # 3.3 缺失值处理
    #     类别列 -> 填充 "未知"（保留这部分数据，单独作为一个分组观察）
    out["区域"] = out["区域"].fillna("未知")
    #     数值列 -> 用同品类的中位数填充，比全局均值更合理
    out["单价"] = out["单价"].fillna(
        out.groupby("品类")["单价"].transform("median")
    )

    # 3.4 特征工程：派生新列
    out["年月"] = out["订单日期"].dt.to_period("M").astype(str)
    out["季度"] = out["订单日期"].dt.quarter.astype(str) + "季度"
    out["星期"] = out["订单日期"].dt.dayofweek.map(
        {0: "周一", 1: "周二", 2: "周三", 3: "周四", 4: "周五", 5: "周六", 6: "周日"}
    )
    out["是否周末"] = out["订单日期"].dt.dayofweek >= 5
    out["客单价区间"] = pd.cut(
        out["销售额"],
        bins=[0, 500, 2000, 8000, np.inf],
        labels=["<500", "500-2000", "2000-8000", ">8000"],
    )

    print("\n" + "=" * 78)
    print("【2】数据清洗")
    print("=" * 78)
    print(f"删除重复行     : {dup_removed} 行")
    print(f"修正负销售额   : {bad.sum()} 行")
    print(f"填充缺失区域   : {(df['区域'].isna()).sum()} 行 -> '未知'")
    print(f"填充缺失单价   : {(df['单价'].isna()).sum()} 行 -> 同品类中位数")
    print(f"清洗后剩余行数 : {len(out)}")
    print(f"清洗后仍缺失值 : {out.isna().sum().sum()}")
    return out.reset_index(drop=True)


# ---------------------------------------------------------------------------
# 4. 多维度聚合分析
# ---------------------------------------------------------------------------
def aggregate(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    print("\n" + "=" * 78)
    print("【3】维度分析")
    print("=" * 78)

    result = {}

    # 4.1 按区域汇总
    by_region = (
        df.groupby("区域")
        .agg(订单数=("销售额", "size"),
             总销售额=("销售额", "sum"),
             平均客单价=("销售额", "mean"),
             销量=("数量", "sum"))
        .round(2)
        .sort_values("总销售额", ascending=False)
    )
    by_region["销售额占比%"] = (by_region["总销售额"] / by_region["总销售额"].sum() * 100).round(2)
    print("\n按区域:\n", by_region)
    result["按区域"] = by_region

    # 4.2 品类 × 渠道 透视表（销售额）
    pivot = df.pivot_table(
        index="品类", columns="渠道", values="销售额", aggfunc="sum", fill_value=0
    ).round(0)
    print("\n品类 × 渠道 销售额透视表:\n", pivot)
    result["品类x渠道"] = pivot

    # 4.3 各品类销售额最高的渠道（idxmax 用法）
    top_channel = df.groupby(["品类", "渠道"])["销售额"].sum().reset_index()
    best = top_channel.loc[top_channel.groupby("品类")["销售额"].idxmax()]
    print("\n各品类最畅销渠道:\n", best.to_string(index=False))
    result["品类最佳渠道"] = best

    return result


# ---------------------------------------------------------------------------
# 5. 时间序列趋势
# ---------------------------------------------------------------------------
def trend(df: pd.DataFrame) -> pd.DataFrame:
    print("\n" + "=" * 78)
    print("【4】时间趋势")
    print("=" * 78)

    monthly = (
        df.set_index("订单日期")
        .resample("ME")          # 按月末重采样
        .agg(订单数=("销售额", "size"), 销售额=("销售额", "sum"))
        .round(2)
    )
    # 环比增长率（MoM）
    monthly["环比增长%"] = (monthly["销售额"].pct_change() * 100).round(2)
    # 3 个月移动平均，用来观察趋势、抹平波动
    monthly["3月移动平均"] = monthly["销售额"].rolling(3).mean().round(2)
    print(monthly.to_string())

    peak = monthly["销售额"].idxmax()
    print(f"\n销售峰值月份: {peak:%Y-%m}  ({monthly.loc[peak, '销售额']:,.0f} 元)")
    print(f"全年销售额   : {monthly['销售额'].sum():,.0f} 元")
    return monthly


# ---------------------------------------------------------------------------
# 6. 相关性分析
# ---------------------------------------------------------------------------
def correlation(df: pd.DataFrame) -> pd.DataFrame:
    print("\n" + "=" * 78)
    print("【5】相关性分析（数值列，Pearson 系数）")
    print("=" * 78)
    corr = df[["数量", "单价", "销售额"]].corr().round(3)
    print(corr)
    print("\n提示: 销售额由 单价 × 数量 决定, 因此与两者都强正相关;")
    print("      数量与单价接近 0 说明两者相互独立, 不存在“买得多就便宜”的规律。")
    return corr


# ---------------------------------------------------------------------------
# 7. 其他常用技巧演示
# ---------------------------------------------------------------------------
def extras(df: pd.DataFrame) -> None:
    print("\n" + "=" * 78)
    print("【6】常用技巧")
    print("=" * 78)

    # 条件筛选 + 排序
    big_orders = df[df["销售额"] > 5000].nlargest(5, "销售额")[
        ["订单日期", "区域", "品类", "销售额"]
    ]
    print("\n销售额 Top5 订单:\n", big_orders.to_string(index=False))

    # 周末 vs 工作日
    weekend = (
        df.groupby("是否周末")["销售额"]
        .agg(["size", "mean", "sum"])
        .round(2)
        .rename(index={False: "工作日", True: "周末"})
    )
    print("\n周末 / 工作日对比:\n", weekend)

    # 客单价分箱后的分布
    dist = df["客单价区间"].value_counts().sort_index()
    print("\n客单价区间分布:\n", dist.to_string())

    # 占比计算 + 累计占比（帕累托分析）
    cat = df.groupby("品类")["销售额"].sum().sort_values(ascending=False)
    pareto = pd.DataFrame({"销售额": cat.round(0)})
    pareto["占比%"] = (cat / cat.sum() * 100).round(2)
    pareto["累计占比%"] = pareto["占比%"].cumsum().round(2)
    print("\n品类帕累托分析:\n", pareto)


# ---------------------------------------------------------------------------
# 8. 导出报表
# ---------------------------------------------------------------------------
def export(df: pd.DataFrame, monthly: pd.DataFrame, agg: dict[str, pd.DataFrame]) -> Path:
    df.to_csv(HERE / "sales_clean.csv", index=False, encoding="utf-8-sig")
    monthly.to_csv(HERE / "monthly_report.csv", encoding="utf-8-sig")
    agg["按区域"].to_csv(HERE / "by_region.csv", encoding="utf-8-sig")

    top_region = agg["按区域"].index[0]
    top_row = agg["按区域"].iloc[0]
    peak = monthly["销售额"].idxmax()

    report = f"""# 电商销售数据分析报告

- 数据区间：{df['订单日期'].min():%Y-%m-%d} ~ {df['订单日期'].max():%Y-%m-%d}
- 有效订单数：{len(df):,} 笔
- 总销售额：{df['销售额'].sum():,.0f} 元
- 平均客单价：{df['销售额'].mean():,.2f} 元

## 核心结论

1. **区域**：{top_region} 贡献最高，销售额 {top_row['总销售额']:,.0f} 元，
   占比 {top_row['销售额占比%']}%。
2. **时间**：销售峰值出现在 {peak:%Y-%m}，全年呈下半年走高趋势
   （12 月较 1 月有明显增长）。
3. **品类**：{agg['品类x渠道'].sum(axis=1).idxmax()} 是销售额最高的品类。
4. **关联性**：销售额与数量、单价均强正相关；数量与单价几乎不相关。

## 建议

- 对高贡献区域加大投放，对“未知”区域补齐数据采集。
- 在旺季（Q4）前提前备货并锁定物流运力。
- 针对低客单价区间设计搭售组合，提升客单价。
"""
    path = HERE / "report.md"
    path.write_text(report, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
def main() -> None:
    raw = make_dataset()
    raw.to_csv(HERE / "sales_raw.csv", index=False, encoding="utf-8-sig")
    inspect(raw)

    df = clean(raw)
    agg = aggregate(df)
    monthly = trend(df)
    correlation(df)
    extras(df)

    report = export(df, monthly, agg)
    print("\n" + "=" * 78)
    print(f"完成！报告已生成: {report}")
    print("=" * 78)


if __name__ == "__main__":
    main()
