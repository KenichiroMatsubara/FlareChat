# km_arrange — このリポジトリ独自の編集

> ⚠️ このファイルは Matt Pocock 上流ではなく、**このリポジトリ独自の追加・変更**を記録する。
> `SKILL.md` 本文は上流 pristine のまま保ち、独自仕様はすべてこのファイルに置く（更新容易性のため）。本文と衝突する場合は **このファイルを優先**する。

上流本文の PRD 作成・publish 手順に加えて、このリポジトリでは以下を**追加**する。

## 1. PRD は親 issue（`parent` ラベル＋ native sub-issue / ADR-0003）

publish した PRD は親 issue として扱う。`parent` ラベルを付与（未作成なら作成）し、後で `/to-issues` が分解する子 issue を **native GitHub sub-issue** として登録できるようにする（ADR-0003）。

```sh
gh label create "parent" --color 5319E7 --description "親イシュー — broken into child issues" 2>/dev/null || true
gh issue edit <prd-number> --add-label "parent"
```

**なぜ：** PRD を最初から親 issue にしておくと、`/to-issues` が子を分解したときに native sub-issue 関係が繋がり、進捗バーと自動クローズ（ADR-0003）がそのまま機能する。後付けで親子関係を張り直すのは手間が増え、抜けやすい。

## 2. 進捗バー・自動クローズ運用／手動クローズ禁止

子 issue が揃うと GitHub 上で「達成された子Issue / 全子Issue」の進捗バーが表示され、全子クローズ時に auto-close workflow が PRD を自動クローズする。**PRD を手でクローズしない。**

**なぜ：** PRD のクローズ条件は「全子が閉じたら」で workflow が自動判定する。手で閉じると、まだ子が残っているのに親が閉じる等、進捗バーと実態がズレる。

