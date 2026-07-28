# Mail Automation

Gmailで受信した案内を自動で予定へ変換し、Google Calendar、メール、LINEへ配信するCloudflareネイティブの管理サービスです。

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

## Cloudflare Workers Builds による自動デプロイ

Cloudflare Dashboard の **Workers & Pages → Create → Git repository** でこの
GitHub リポジトリを接続します。初回のデプロイ時に、`wrangler.jsonc` に定義された
`CONTROL_DB` (D1) と `RECOVERY_RECEIPTS` (R2) は Cloudflare が自動作成します。
リソース ID やバケット名をリポジトリへ書き戻す必要はありません。

Dashboard の設定値は次のとおりです。

- Build command: `npm run build`
- Deploy command: `npm run deploy:cloudflare`
- Production branch: `main`

`deploy:cloudflare` は Worker と GUI をデプロイしてから Control D1 migration を適用します。
初回のデプロイが成功したら、Worker の **Settings → Variables and Secrets** で次を設定します。
本番の変数は Dashboard を source of truth とし、`wrangler.jsonc` の `keep_vars` によって
以後の自動デプロイでも保持します。localhost 用の値は `env.local` にだけ定義されています。

- Variables: `APP_URL`, `WEB_ORIGIN`, `RP_ID`, `GOOGLE_CLIENT_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME`
- Secrets: `GOOGLE_CLIENT_SECRET`, `CREDENTIAL_MASTER_KEY`, `CREDENTIAL_MASTER_KEY_VERSION`, `CLOUDFLARE_API_TOKEN`

`APP_URL` と `WEB_ORIGIN` には `https://<domain>`、`RP_ID` には scheme を除いた
`<domain>`、`CLOUDFLARE_WORKER_NAME` には `flarechat` を設定します。

`CLOUDFLARE_API_TOKEN` は、アプリが Organization ごとの D1 を作成・Worker へ binding
するために使います。デプロイ用トークンとは分け、対象アカウントと必要な Workers/D1 権限だけに
制限してください。Google Cloud Console には本番 URL の
`https://<domain>/oauth/google/callback` も OAuth redirect URI として登録します。
