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

- `http://localhost:8787/oauth/google/callback`（初回 Organization セットアップ）
- `http://localhost:8787/oauth/google/login/callback`（後日の管理画面ログイン）

`redirect_uri_mismatch` が出た場合は、`apps/worker/.dev.vars` の `GOOGLE_CLIENT_ID` と同じ OAuth クライアントを開き、利用する URI が完全一致していることを確認してください。初回画面では
Google 認可を一度だけ行い、そのアカウントが Automation Inbox と初期 Owner の両方になります。同意後、Google表示名を初期値にした組織名を確認・編集してから組織DBを作成します。受信した新着メールに `2026/08/03 19:00-21:00` または
`2026年8月3日 19:00〜21:00` のような日付と時刻範囲があれば、primary Calendar に予定を
作成します。ログイン時点より前のメールは処理しません。
