# 更新日志

[English](CHANGELOG.md) | 简体中文

## 0.1.2

### 修复

- `mini` / `low` 的汇总行与 `medium` 块现在跟随 pi 的 `outputPad` 设置, 与原生行对齐.
- `medium` 的耗时改用 pi 记录的工具耗时, 与 bash 的 `Took` 一致, reload 或恢复会话后也准确.
- 扩展不再把工具加进活跃集, `--tools` 与 `defaultTools` 的行为与 pi 原生一致.

### 变更

- 更新日志随包发布, 后续升级时可在 pi 里看到版本说明.

## 0.1.1

### 变更

- 更新 README
- 精简注释

## 0.1.0

首次发布.
