# km_arrange — このリポジトリ独自の編集

> ⚠️ このファイルは Matt Pocock 上流ではなく、**このリポジトリ独自の追加・変更**を記録する。
> `SKILL.md` 本文は上流 pristine のまま保ち、独自仕様はこのファイルに置く。本文と衝突する場合は **このファイルを優先**する。

## 質問は平文で。AskUserQuestion / structured-question ツールは使用禁止

グリル中の質問は、必ず**自分のメッセージ内に平文（散文）**で書く。**`AskUserQuestion`（structured-question）ツールは使用してはならない。**

**なぜ：** この環境のアプリ側バグで、**一度答えたはずの質問が何度も繰り返し再表示されて邪魔**になるから。平文で聞けばこの問題が起きない。この制約は grill が行われる**全経路**に適用される（直接の `/grilling`、`/grill-with-docs`、`triage` の grill 工程など）。
