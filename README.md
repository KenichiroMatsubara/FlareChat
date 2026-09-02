# FlareChat

スケジュールと連絡先のためのCloudflareネイティブな自動化プラットフォームです。Automationはトリガーで起動し、Promptで判断し、Accountが許可したツールで動き、組み込みChannel経由でContactに届きます。Gmailの案内を予定へ変換してCalendar・メール・LINEへ配信する従来の動作は、その一構成になりました。

## 構成

- Hono + Cloudflare Workers
- D1（Control DB + Organization DB）
- Cloudflare Cron / Queues
- R2
- React + Viteの専用管理GUI

## ローカル起動

```bash
npm install
npm run db:local
npm run dev
```

GUIは `http://localhost:5173`、APIは `http://localhost:8787` で起動します。

ローカルの Control D1 は軽量なローカル DB ブラウザで確認できます。先にマイグレーションを適用してから起動してください。起動するとブラウザも自動で開きます。

```bash
npm run db:local
npm run db:studio
```

本来の Drizzle Studio を使う場合は `npm run db:drizzle` です。こちらは `local.drizzle.studio` の大きな UI を読み込むため、初回表示に時間がかかることがあります。

ローカルD1状態にある Control D1 と Organization D1 は、左側の `Databases` 一覧から選択して閲覧します。DBを選ぶまでテーブル一覧は表示されません。任意の SQLite ファイルを複数開く場合は、カンマ区切りの `DB_STUDIO_PATHS` を指定してください（従来の単一指定 `DB_STUDIO_PATH` も利用できます）。ローカル DB ブラウザを自動起動したくない場合は `DB_BROWSER_NO_OPEN=1` を指定してください。

```bash
DB_STUDIO_PATHS=/path/to/control.sqlite,/path/to/organization.sqlite npm run db:studio
```

Google OAuthやLINE Messaging APIの値は `apps/worker/.dev.vars.example` を
`apps/worker/.dev.vars` にコピーして設定します。ローカル開発では Wrangler に宣言した
3つのローカル専用 Organization D1 から、組織ごとに別のDBを割り当てます。
Cloudflare のアカウントID、APIトークン、Worker名は不要です。Organization の認証情報を
Control DBへ代替保存することもありません。3枠を使い切った場合は、不要なローカル
セットアップを最初からやり直すか、`wrangler.jsonc` にローカル D1 binding を追加してください。

Google Cloud Console の **API とサービス → 認証情報 → このアプリの OAuth 2.0 クライアント ID → 承認済みのリダイレクト URI** には、次を登録してください。

- `http://localhost:8787/oauth/google/callback`

`redirect_uri_mismatch` が出た場合は、`apps/worker/.dev.vars` の `GOOGLE_CLIENT_ID` と同じ OAuth クライアントを開き、利用する URI が完全一致していることを確認してください。初回画面では
「新しいOrganizationを作る」か「既存Organizationへログイン」の一方を選びます。新規作成は完全 grant、既存メンバーのログインは identity-only grant を要求し、どちらも選んだ導線で Google OAuth を一度だけ行います。新規作成で認可したアカウントは Automation Inbox と初期 Owner Identity の両方になり、同意後、Google表示名を初期値にした組織名を確認・編集してから組織DBを作成します。受信した新着メールに `2026/08/03 19:00-21:00` または
`2026年8月3日 19:00〜21:00` のような日付と時刻範囲があれば、primary Calendar に予定を
作成します。ログイン時点より前のメールは処理しません。

## テスト

`npm test` は通常の統合テストに加えて、Workers Vitest pool の Miniflare D1 adapter で canonical Organization schema を検証します。D1 provisioning の回帰だけを数秒で実行するコマンドは次です。

```bash
npm run test:d1
```

## CI とマイグレーションのリハーサル

`.github/workflows/ci.yml` が pull request と `main` への push で動きます。

- `verify`: `npm run typecheck` と `npm test`
- `rehearse-migrations`: `npm run db:rehearse:remote`。本番の Control D1 と全 Organization D1 を `wrangler d1 export` で取り出し、
  ローカル SQLite に読み込んで、Worker と同じ Schema Lifecycle で未適用マイグレーションを適用します。
  本番の行で失敗するマイグレーションはここで落ち、マージできません。

リポジトリの **Settings → Secrets and variables → Actions** に `CLOUDFLARE_API_TOKEN`（D1 読み取り権限）と
`CLOUDFLARE_ACCOUNT_ID` を登録し、**Settings → Branches** で `main` に両ジョブを required status check にしてください。
required にしていないと、この検査は「見える」だけで「止める」役目を果たしません。

手元で試す場合は同じ環境変数を付けて `npm run db:rehearse:remote` を実行します。既にエクスポート済みの
`<DB名>.sql` を置いたディレクトリを引数に渡すと、エクスポートを飛ばして再生だけを行います。

## Cloudflare Workers Builds による自動デプロイ

Cloudflare Dashboard の **Workers & Pages → Create → Git repository** でこの
GitHub リポジトリを接続します。初回のデプロイ時に、`wrangler.jsonc` に定義された
`CONTROL_DB` (D1) と `RECOVERY_RECEIPTS` (R2) は Cloudflare が自動作成します。
リソース ID やバケット名をリポジトリへ書き戻す必要はありません。

Dashboard の設定値は次のとおりです。

- Build command: `npm run build`
- Deploy command: `npm run deploy:cloudflare`
- Production branch: `main`

`deploy:cloudflare` は次の順で動きます。どれかが失敗した時点で止まり、その前に動いていた Worker がそのまま動き続けます（ADR 0100、ADR 0174）。

1. `db:rehearse:remote`: 本番の全 D1 をエクスポートし、未適用マイグレーションをローカル SQLite 上で試す
2. Control D1 のマイグレーション適用
3. 全 Organization D1 のマイグレーション適用（リリースバリアを取得）
4. `wrangler deploy`
5. 再検証してバリアを解放

Deploy command が `wrangler deploy` や `npx wrangler deploy` のままだと 1〜3 と 5 が飛ばされ、
Worker が起動時に自力でマイグレーションを試す修復経路だけが残ります。その経路が失敗すると全リクエストが 503 になるので、
Dashboard の Deploy command は必ず `npm run deploy:cloudflare` にしてください。1〜3 と 5 が本番 D1 に触るため、
**Settings → Build → Variables and secrets** にも `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が必要です
（Worker の Secrets とは別枠で、ビルド環境には渡りません）。
`schema_releases` テーブルの `target_migration` が最新のマイグレーション名になっていなければ、この経路が動いていません。
本番URLなどの非秘密変数は `apps/worker/wrangler.jsonc` を source of truth とします。
初回デプロイ前に、Worker の **Settings → Variables and Secrets** または
`wrangler secret bulk` で次のSecretsを設定します。`secrets.required` により、
一つでも存在しない状態でのデプロイは失敗します。localhost 用の値は `env.local` にだけ定義されています。
OrganizationごとのD1 bindingはセットアップ時にCloudflare APIで追加されるため、
`wrangler.jsonc` の `unsafe.metadata.keep_bindings` でD1・変数・Secretsを通常デプロイ後も保持します。

- Variables: `APP_URL`, `WEB_ORIGIN`, `RP_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME`
- Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CREDENTIAL_MASTER_KEY`, `CREDENTIAL_MASTER_KEY_VERSION`, `CLOUDFLARE_API_TOKEN`

`APP_URL` と `WEB_ORIGIN` には `https://<domain>`、`RP_ID` には scheme を除いた
`<domain>`、`CLOUDFLARE_WORKER_NAME` には `flarechat` を設定します。

`CLOUDFLARE_API_TOKEN` は、アプリが Organization ごとの D1 を作成・Worker へ binding
するために使います。デプロイ用トークンとは分け、対象アカウントと必要な Workers/D1 権限だけに
制限してください。Google Cloud Console には本番 URL の
`https://<domain>/oauth/google/callback` も OAuth redirect URI として登録します。
